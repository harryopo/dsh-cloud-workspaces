/**
 * subprocess-ssh 发布诊断：在真实服务器上逐段复刻 wrapper 的关键步骤，
 * 观察哪一步没有产出 pid 文件。只做诊断，不做断言。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from 'dsh-remote-ide/ssh-service'
import { SshSubprocessRuntime } from 'dsh-remote-ide/subprocess-ssh'

const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
const ctx = new Context()
const fiber = await ctx.plugin(SshRuntime, { storeFile: storePath })
const runtime = ctx.get('ssh')
const engine = runtime.engine
const alias = 'wsl-e2e'

const show = (label, r) => console.log(`[${label}] exit=${r.exitCode} out=${JSON.stringify(r.stdout)} err=${JSON.stringify(r.stderr)}`)

await runtime.connect(alias)

// 1. bootstrap 的工具解析（真实 wrapper 的 command -v 探测）
show('tools', await engine.exec(alias,
  'for t in env setsid bash ps tr rm; do printf "%s=%s\\n" "$t" "$(command -v $t)"; done'))

// 2. inner 的 pgid 探测（真实 wrapper 的发布语句）
show('pgid-self', await engine.exec(alias, `bash -c 'ps -o pgid= -p $$ | tr -d " "'`))

// 3. 环境采集（readRemoteEnvironment）
show('env-probe', await engine.exec(alias,
  'getent passwd root | cut -d: -f6 | head -c 40; echo; env -0 | base64 -w0 | wc -c'))

// 4. setsid --wait 全链路（手工复刻 inner，观察 pgid 输出）
show('setsid-chain', await engine.exec(alias,
  `dsh_ps="$(command -v ps)"; dsh_tr="$(command -v tr)"; dsh_bash="$(command -v bash)"; ` +
  `dsh_setsid="$(command -v setsid)"; dsh_rm="$(command -v rm)"; ` +
  `exec "$dsh_env_bin" 2>/dev/null; mkdir -p /tmp/dsh-diag && chmod 700 /tmp/dsh-diag; ` +
  `"$dsh_setsid" --wait -- "$dsh_bash" -c 'set +e; dsh_ps=$1; dsh_tr=$2; dsh_rm=$3; shift 3; ` +
  `dsh_pgid="$("$dsh_ps" -o pgid= -p "$$" | "$dsh_tr" -d " ")"; ` +
  `printf "%s\\n" "$dsh_pgid" > /tmp/dsh-diag/pid; ` +
  `cat /tmp/dsh-diag/pid 1>&2; ' dsh-ssh "$dsh_ps" "$dsh_tr" "$dsh_rm" true`))

// 5. 检查诊断目录里的 pid 文件
show('diag-pid', await engine.exec(alias, 'cat /tmp/dsh-diag/pid 2>&1; echo; ls -la /tmp/dsh-diag'))

// 6. 真实 spawn：长命令（sleep 1）观察发布窗口
await ctx.plugin(SshSubprocessRuntime, { pollMs: 5 })
const sp = ctx.subprocess
try {
  const h = sp.spawn({
    argv: ['sleep', '1'],
    cwd: '/tmp',
    graceMs: 5000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await h.done
  console.log('[spawn sleep 1] pid=', h.pid, 'outcome=', JSON.stringify(outcome))
} catch (e) {
  console.log('[spawn sleep 1] FAILED:', e.message)
}

// 7. 遗留 state 目录检查（正常完成的 spawn 不清理 stateDir）
show('state-dirs', await engine.exec(alias, 'ls -la /tmp/dsh-ssh-processes/ 2>&1 | tail -5; for f in /tmp/dsh-ssh-processes/*/pid; do echo "$f: $(cat "$f" 2>&1)"; done'))

await engine.exec(alias, 'rm -rf /tmp/dsh-diag')
await fiber.dispose()
