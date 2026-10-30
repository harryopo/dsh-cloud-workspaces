/**
 * M4 真实服务器端到端验收（非交互，可重复执行）。
 *
 * 直接驱动构建产物 lib/ + 真实 cordis Context，对 store 第一台主机跑全链路：
 *   1. 设置卡探测路径 engine.testConfig（表单直连 + keyboard-interactive）
 *   2. SshRuntime connect → status（connected + home 解析）
 *   3. engine.exec（基础命令 / cwd 前缀 / 非零退出码）
 *   4. SFTP 全套（mkdir→write→read→ls→rename→remove→rmdir，UTF-8 中文内容）
 *   5. PTY（openShell 回显算术展开 + exit 收尾）
 *   6. 占位工作区路由（createPlaceholderDir → routeByCwd → resolveRemotePath）
 *   7. 后台任务（job-runner：wrapper / dd 增量 append / 杀进程组）
 *
 * 用法：node scripts/e2e-real-server.mjs [alias]
 * 目标默认取 ~/.dsh/dsh-remote-ide.json 的第一台主机（不会打印任何密钥）。
 */

import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from 'dsh-cloud-workspaces/ssh-service'
import {
  createPlaceholderDir,
  routeByCwd,
  resolveRemotePath,
  listPlaceholders,
} from 'dsh-cloud-workspaces/src/workspace.ts'

// ---------------------------------------------------------------- harness

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(1, 60 - title.length))}`)
}
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])

// ---------------------------------------------------------------- setup

const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
const storeHosts = (JSON.parse(readFileSync(storePath, 'utf8')).hosts ?? [])
  .filter(h => h && typeof h.alias === 'string')
if (storeHosts.length === 0) {
  console.error('FAIL  no host in ~/.dsh/dsh-remote-ide.json — add one first')
  process.exit(1)
}
const targetAlias = process.argv[2] ?? storeHosts[0].alias
const target = storeHosts.find(h => h.alias === targetAlias)
if (target === undefined) {
  console.error(`FAIL  unknown host alias: ${targetAlias}`)
  process.exit(1)
}
console.log(`target: alias=${target.alias} host=${target.host}:${target.port} user=${target.user} auth=${target.auth.kind}`)

const ctx = new Context()
const fiber = await ctx.plugin(SshRuntime, { storeFile: storePath })
const runtime = ctx.get('ssh')
if (!runtime) throw new Error('SshRuntime did not provide ctx.ssh')
const engine = runtime.engine

const stamp = Date.now()
const remoteBase = `/tmp/dsh-e2e-${stamp}`
const remoteWs = `/tmp/dsh-e2e-ws-${stamp}`
let localPlaceholder = ''

try {
  // --------------------------------------------- 1. settings-card probe
  section('1. engine.testConfig（设置卡「测试连接」路径）')
  const probe = await withTimeout(
    engine.testConfig({ host: target.host, port: target.port, user: target.user, auth: target.auth }),
    30_000,
    'testConfig',
  )
  check('testConfig ok', probe.ok === true, probe.ok ? `${probe.latencyMs}ms` : probe.error)

  // --------------------------------------------- 2. connect + status
  section('2. SshRuntime connect / status')
  const status = await withTimeout(runtime.connect(targetAlias), 30_000, 'connect')
  check('state=connected', status.state === 'connected', `state=${status.state} error=${status.error ?? ''}`)
  check('home 解析', typeof status.home === 'string' && status.home.startsWith('/'), `home=${status.home}`)

  // --------------------------------------------- 3. exec
  section('3. engine.exec')
  const who = await engine.exec(targetAlias, 'uname -s && whoami')
  check('uname/whoami', who.success && who.stdout.includes('Linux') && who.stdout.includes(target.user),
    JSON.stringify(who.stdout.trim()))
  const cwdExec = await engine.exec(targetAlias, 'pwd', { cwd: '/tmp' })
  check('exec cwd=/tmp', cwdExec.success && cwdExec.stdout.trim() === '/tmp', cwdExec.stdout.trim())
  const failExec = await engine.exec(targetAlias, 'exit 3')
  check('非零退出码透传', !failExec.success && failExec.exitCode === 3, `exitCode=${failExec.exitCode}`)

  // --------------------------------------------- 4. SFTP
  section('4. SFTP（ssh_ls/ssh_read/ssh_write 底层）')
  await engine.mkdir(targetAlias, remoteBase)
  const content = `你好 dsh-remote-ide\nM4 端到端 ${stamp}\n`
  const written = await engine.writeFile(targetAlias, `${remoteBase}/hello.txt`, content)
  check('writeFile', written.size === Buffer.byteLength(content), `${written.size} bytes`)
  const readBack = await engine.readFile(targetAlias, `${remoteBase}/hello.txt`)
  check('readFile 中文往返', readBack.content === content && readBack.truncated === false)
  const listed = await engine.ls(targetAlias, remoteBase)
  check('ls 含 hello.txt', listed.some(e => e.name === 'hello.txt' && e.type === 'file'))
  await engine.rename(targetAlias, `${remoteBase}/hello.txt`, `${remoteBase}/hello-2.txt`)
  const listed2 = await engine.ls(targetAlias, remoteBase)
  check('rename 生效', listed2.some(e => e.name === 'hello-2.txt'))
  await engine.remove(targetAlias, `${remoteBase}/hello-2.txt`)
  await engine.remove(targetAlias, remoteBase)
  const listed3 = await engine.ls(targetAlias, '/tmp').catch(() => [])
  check('remove/rmdir 清理', !listed3.some(e => e.name === `dsh-e2e-${stamp}`))

  // --------------------------------------------- 5. PTY
  section('5. PTY shell')
  const shell = await engine.openShell(targetAlias, 80, 24)
  let ptyOut = ''
  const ptyClosed = new Promise((resolve) => { shell.onExit = () => resolve() })
  shell.onData = (chunk) => { ptyOut += chunk.toString('utf8') }
  shell.send('echo PTY_E2E_$((21*2))\n')
  const sawMarker = await (async () => {
    for (let i = 0; i < 50 && !ptyOut.includes('PTY_E2E_42'); i += 1) {
      await new Promise(r => setTimeout(r, 200))
    }
    return ptyOut.includes('PTY_E2E_42')
  })()
  check('PTY 算术展开回显', sawMarker, sawMarker ? '' : 'output 未含 PTY_E2E_42')
  shell.send('exit\n')
  await withTimeout(ptyClosed, 10_000, 'PTY close')

  // --------------------------------------------- 6. 占位工作区路由
  section('6. 占位工作区（placeholder workspace 路由）')
  await engine.mkdir(targetAlias, remoteWs)
  const ph = await createPlaceholderDir({ hostId: targetAlias, remotePath: remoteWs })
  localPlaceholder = ph.localPath
  check('占位目录落 ~/.dsh/remote', ph.localPath.replaceAll('\\', '/').includes('/.dsh/remote/'), ph.localPath)
  const routed = routeByCwd(ph.localPath)
  check('routeByCwd → remote', routed.kind === 'remote' && routed.hostId === targetAlias
    && routed.remoteCwd === remoteWs, JSON.stringify(routed))
  // 占位会话锚定后 runtime 激活连接应同步切换：ssh_* 工具的无别名回退
  // 读 activeAlias，不激活会让同会话 ssh_exec 报 "no alias given"。
  check('锚定同步激活连接（ssh_* 无别名可用）', runtime.engine.status().alias === targetAlias,
    `activeAlias=${runtime.engine.status().alias}`)
  check('resolveRemotePath 纯函数', resolveRemotePath('a/b.txt', remoteWs, ph.localPath) === `${remoteWs}/a/b.txt`)
  const allPh = await listPlaceholders()
  check('listPlaceholders 可见', allPh.some(w => w.localPath === ph.localPath && w.remotePath === remoteWs))

  // --------------------------------------------- 7. 后台任务（job-runner）
  section('7. 后台任务（job-runner：wrapper / dd 增量 append / 杀进程组）')
  {
    const { startRemoteJob } = await import('dsh-cloud-workspaces/job-runner')
    // 裸 Context 无 dsh-jobs——假 registry 捕获 spec，验证的是远端机制本身。
    // 0.2 推模式：run(job) 调用 job.append()。
    const appends = []
    let hooks = null
    const fakeJobs = {
      start: (s) => {
        const job = { id: 'ssh-e2e-1', append: (t) => { appends.push(t) }, updateProgress: () => {} }
        queueMicrotask(() => { hooks = s.run(job) })
        return 'ssh-e2e-1'
      },
    }
    const sleepCmd = 'for i in 1 2 3 4 5; do echo tick$i; sleep 1; done'
    const started = startRemoteJob({ engine, jobs: fakeJobs }, { hostId: targetAlias, command: sleepCmd, cwd: remoteWs })
    check('startRemoteJob 返回 background+jobId', started.kind === 'background' && started.jobId === 'ssh-e2e-1')
    let mid = ''
    for (let i = 0; i < 8 && !mid.includes('tick1'); i++) {
      await new Promise(r => setTimeout(r, 1500))
      mid = appends.join('')
    }
    check('job.append 中途见增量输出', mid.includes('tick1'), JSON.stringify(mid.slice(0, 40)))
    const doneOutcome = await withTimeout(hooks.done, 20_000, 'job done')
    check('done=completed + exit code 0', doneOutcome.status === 'completed' && doneOutcome.detail === 'exit code: 0', JSON.stringify(doneOutcome))
    startRemoteJob({ engine, jobs: fakeJobs }, { hostId: targetAlias, command: 'sleep 120', cwd: remoteWs })
    await new Promise(r => setTimeout(r, 800))
    const kh = hooks
    kh.cancel()
    kh.cancel()
    const ko = await withTimeout(kh.done, 15_000, 'cancel done')
    check('cancel → killed（进程组终止，幂等）', ko.status === 'killed', JSON.stringify(ko))
  }
} finally {
  // ---------------------------------------------------------- cleanup
  section('清理')
  try {
    await engine.exec(targetAlias, `rm -rf ${remoteBase} ${remoteWs} && rm -f "$HOME"/m4-e2e-*.txt /tmp/dsh-job-*.log /tmp/dsh-job-*.pid`)
    console.log('远程临时目录已清理')
  } catch (e) { console.log(`远程清理失败（可忽略）: ${e.message}`) }
  try {
    if (localPlaceholder !== '') rmSync(localPlaceholder, { recursive: true, force: true })
    console.log('本地占位目录已清理')
  } catch { /* ignore */ }
  await fiber.dispose()
}

// ---------------------------------------------------------------- summary
section('结果汇总')
const passed = results.filter(r => r.ok).length
console.log(`${passed}/${results.length} 项通过${failed === 0 ? '  ✅ M4 真实服务器端到端验收通过' : `  ❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
