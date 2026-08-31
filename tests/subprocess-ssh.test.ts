/**
 * SshSubprocessRuntime（subprocess-ssh）测试 —— 参照 subprocess-e2b 语义 +
 * fs-ssh.test.ts 的 mock 模式（vi.mock('ssh2') + 内存 FakeSftp），
 * 验证 ctx.subprocess 的三个远程入口：resolveExecutable / spawn（wrapper +
 * pgid 轮询 + 输出 bounded + 本地 spill）/ spawnTerminal（openShell 注入）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { posix } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from '../src/ssh-service'
import SshSubprocessRuntime from '../src/subprocess-ssh'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** 可编程的 ssh2 假实现：exec 流式通道 + shell + 内存 SFTP。 */
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  class MiniEmitter {
    private listeners = new Map<string, Handler[]>()

    on(event: string, cb: Handler) {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }

    once(event: string, cb: Handler) {
      const wrapper: Handler = (...args) => {
        this.remove(event, wrapper)
        cb(...args)
      }
      const list = this.listeners.get(event) ?? []
      list.push(wrapper)
      this.listeners.set(event, list)
      return this
    }

    remove(event: string, cb: Handler) {
      const list = this.listeners.get(event)
      if (!list) return
      const index = list.indexOf(cb)
      if (index >= 0) list.splice(index, 1)
    }

    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
      return this
    }
  }

  /** exec 通道流：stdout 数据 + 独立 stderr + close(code, signal)。 */
  class FakeStream extends MiniEmitter {
    command = ''
    stderr = new MiniEmitter()
    destroyed = false
    writableEnded = false
    writes: Array<string | Buffer> = []
    write(data: string | Buffer) { this.writes.push(data); return true }
    end() { this.writableEnded = true }
    close() { this.destroyed = true; this.emit('close', 0, null) }
    finish(code: number | null, signal: string | null) {
      this.destroyed = true
      this.emit('close', code, signal)
    }
  }

  /** openShell 的底层通道：engine 注册 data/close/error；write 自动回显 marker 行。 */
  class FakeShell extends MiniEmitter {
    writes: string[] = []
    closed = false
    write(data: string) {
      this.writes.push(data)
      // 模拟真实 PTY：命令发出后远端回显 marker 行（marker + 换行）。
      queueMicrotask(() => {
        if (this.closed) return
        const marker = /dsh-ssh-bootstrap:([a-f0-9-]+)/.exec(data)?.[1]
        if (marker) this.emit('data', Buffer.from(`dsh-ssh-bootstrap:${marker}\n`))
      })
    }
    setWindow(_rows: number, _cols: number, _height: number, _width: number) {}
    pause() {}
    resume() {}
    close() {
      if (this.closed) return
      this.closed = true
      this.emit('close')
    }
  }

  interface FakeFile { kind: 'file'; content: Buffer; mode: number; mtime: number }
  interface FakeDir { kind: 'dir'; mode: number; mtime: number }
  type FakeNode = FakeFile | FakeDir

  const norm = (p: string) => p === '/' ? '/' : p.replace(/\/+$/g, '')

  /** 内存远程文件系统（subprocess 需要的子集：writeFile/readFile/mkdir/chmod/unlink）。 */
  class FakeSftp {
    nodes = new Map<string, FakeNode>()
    symlinks = new Map<string, string>()
    private mtimeCounter = 0

    private tick(): number {
      this.mtimeCounter += 1
      return this.mtimeCounter
    }

    seed() {
      this.nodes.set('/home/dev', { kind: 'dir', mode: 0o755, mtime: 1 })
      this.nodes.set('/home/dev/project', { kind: 'dir', mode: 0o755, mtime: 1 })
      this.nodes.set('/home/dev/project/main.ts', {
        kind: 'file',
        content: Buffer.from("console.log('hi')\n", 'utf8'),
        mode: 0o644,
        mtime: 100,
      })
    }

    readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void) {
      const node = this.nodes.get(norm(path))
      if (node === undefined || node.kind !== 'file') {
        cb(new Error('No such file or directory'), Buffer.alloc(0))
        return
      }
      cb(undefined, Buffer.from(node.content))
    }

    writeFile(path: string, data: string | Buffer, cb: (err?: Error) => void) {
      const key = norm(path)
      const parent = posix.dirname(key)
      if (!this.nodes.has(parent)) {
        cb(new Error('No such file or directory'))
        return
      }
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
      const existing = this.nodes.get(key)
      this.nodes.set(key, {
        kind: 'file',
        content,
        mode: existing?.kind === 'file' ? existing.mode : 0o600,
        mtime: this.tick(),
      })
      cb(undefined)
    }

    mkdir(path: string, cb: (err?: Error) => void) {
      const key = norm(path)
      if (this.nodes.has(key) || this.symlinks.has(key)) {
        cb(new Error('File exists'))
        return
      }
      this.nodes.set(key, { kind: 'dir', mode: 0o700, mtime: this.tick() })
      cb(undefined)
    }

    chmod(path: string, mode: number | string, cb: (err?: Error) => void) {
      const key = norm(path)
      const node = this.nodes.get(key)
      const numeric = typeof mode === 'number' ? mode : parseInt(mode, 8)
      if (node === undefined) {
        cb(new Error('No such file or directory'))
        return
      }
      node.mode = (node.mode & ~0o777) | (numeric & 0o777)
      cb(undefined)
    }

    unlink(path: string, cb: (err?: Error) => void) {
      const key = norm(path)
      if (this.symlinks.has(key)) {
        this.symlinks.delete(key)
        cb(undefined)
        return
      }
      if (this.nodes.get(key)?.kind === 'file') {
        this.nodes.delete(key)
        cb(undefined)
        return
      }
      cb(new Error('No such file or directory'))
    }
  }

  /** 共享 mock 状态（每次测试 reset）。 */
  const state = {
    sftp: new FakeSftp(),
    home: '/home/dev',
    /** NUL 分隔的远程环境（base64 传输的原料）。 */
    remoteEnv: 'HOME=/home/dev\0PATH=/usr/local/bin:/usr/bin\0LANG=C.UTF-8\0',
    which: {} as Record<string, string>,
    /** groupAlive 轮询结果。 */
    pgidAlive: false,
    /** ps -o sid= 结果。 */
    sid: 12345,
    /** sessionProcessGroups 结果。 */
    sessionGroups: [] as number[],
    /** ps -o tpgid= 结果（undefined = 前台组解析失败）。 */
    foregroundPid: undefined as number | undefined,
    kills: [] as Array<{ signal: string; args: string }>,
    execCalls: [] as string[],
    channels: [] as FakeStream[],
    shells: [] as FakeShell[],
  }

  /** 递归创建目录（mkdir -p 的镜像）。 */
  function mkdirDeep(path: string): void {
    const parts = norm(path).split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += '/' + part
      if (!state.sftp.nodes.has(current)) {
        state.sftp.nodes.set(current, { kind: 'dir', mode: 0o700, mtime: 1 })
      }
    }
  }

  /** 递归删除目录（rm -rf 的镜像）。 */
  function removeTree(path: string): void {
    const key = norm(path)
    for (const p of [...state.sftp.nodes.keys()]) {
      if (p === key || p.startsWith(key + '/')) state.sftp.nodes.delete(p)
    }
    for (const p of [...state.sftp.symlinks.keys()]) {
      if (p === key || p.startsWith(key + '/')) state.sftp.symlinks.delete(p)
    }
  }

  /** 解开 `exec bash -c '...'` 外层（bashCommand 包裹），还原内层脚本。 */
  function unwrapBash(command: string): string | undefined {
    const match = /^exec bash -c '([\s\S]*)'$/.exec(command)
    if (match === null) return undefined
    return match[1]!.replace(/'\\''/g, "'")
  }

  /**
   * 远程命令分发：控制命令返回立即结果（stdout/stderr/exitCode）；
   * wrapper 命令（setsid 启动）返回 null，由测试操控其流式事件。
   */
  function execScript(command: string): { stdout: string; stderr: string; exitCode: number } | null {
    // 裸命令（未包裹）：engine.resolveHome。
    if (command === 'printf %s "$HOME"') {
      return { stdout: state.home, stderr: '', exitCode: 0 }
    }
    // 去掉 engine 的 `cd '<cwd>' && ` 前缀。
    const cdPrefix = /^cd '([^']*)' && ([\s\S]+)$/.exec(command)
    const body = cdPrefix === null ? command : cdPrefix[2]!
    const script = unwrapBash(body)
    if (script === undefined) {
      return { stdout: '', stderr: `unknown command: ${command}`, exitCode: 1 }
    }
    // wrapper 命令：流式，由测试控制（先写 pid 文件，再发数据与 close）。
    if (script.includes('dsh_setsid')) return null
    // 远程环境传输（readRemoteEnvironment）。
    if (script.includes('getent passwd')) {
      const home = Buffer.from(state.home, 'utf8').toString('base64')
      const env = Buffer.from(state.remoteEnv, 'utf8').toString('base64')
      return { stdout: `${home}\n${env}`, stderr: '', exitCode: 0 }
    }
    // prepareState：mkdir -p + chmod 700。
    const mkdirMatch = /^mkdir -p '([^']*)' && chmod 700 '([^']*)'$/.exec(script)
    if (mkdirMatch !== null) {
      mkdirDeep(mkdirMatch[1]!)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // prepareState：chmod 600 environment。
    const chmodMatch = /^chmod 600 '([^']*)'$/.exec(script)
    if (chmodMatch !== null) {
      state.sftp.chmod(chmodMatch[1]!, 0o600, () => {})
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // 清理：rm -rf。
    const rmMatch = /^rm -rf -- '([^']*)'$/.exec(script)
    if (rmMatch !== null) {
      removeTree(rmMatch[1]!)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // resolveExecutable：绝对路径 `test -f X -a -x X`。
    const testMatch = /^test -f '([^']*)' -a -x '([^']*)'$/.exec(script)
    if (testMatch !== null) {
      const exists = state.sftp.nodes.get(norm(testMatch[1]!))?.kind === 'file'
      return exists ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 1 }
    }
    // resolveExecutable：bare 名 `[PATH='...' ]command -v -- name`。
    const whichMatch = /^(?:PATH='[^']*' )?command -v -- '([^']*)'$/.exec(script)
    if (whichMatch !== null) {
      const name = whichMatch[1]!
      return { stdout: state.which[name] ?? `/usr/bin/${name}`, stderr: '', exitCode: 0 }
    }
    // groupAlive：ps -eo pgid=,stat= | awk '$1 == N && $2 !~ /^[ZXx]/ ...'
    const pgidAliveMatch = /\$1 == (\d+) && \$2 !~ \/^\[ZXx\]\//.exec(script)
    if (pgidAliveMatch !== null) {
      return { stdout: state.pgidAlive ? 'live' : '', stderr: '', exitCode: 0 }
    }
    // sessionProcessGroups：ps -eo sid=,pgid=,stat= | awk '$1 == S && $3 !~ ...'
    const sessionMatch = /\$1 == (\d+) && \$3 !~ \/^\[ZXx\]\//.exec(script)
    if (sessionMatch !== null) {
      const sid = sessionMatch[1]!
      const lines = state.sessionGroups.map(group => `${sid} ${group}`).join('\n')
      return { stdout: lines, stderr: '', exitCode: 0 }
    }
    // signalRemoteGroups：kill -TERM/-KILL -- -g1 -g2 ...
    const killMatch = /^kill -(\w+) -- ([\s\S]+)$/.exec(script)
    if (killMatch !== null) {
      state.kills.push({ signal: killMatch[1]!, args: killMatch[2]! })
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // terminalSessionId：ps -o sid= -p N。
    const sidMatch = /^ps -o sid= -p (\d+)$/.exec(script)
    if (sidMatch !== null) {
      return { stdout: String(state.sid), stderr: '', exitCode: 0 }
    }
    // inspectForeground：ps -o tpgid= -p N。
    const tpgidMatch = /^ps -o tpgid= -p (\d+)$/.exec(script)
    if (tpgidMatch !== null) {
      return state.foregroundPid === undefined
        ? { stdout: '', stderr: '', exitCode: 1 }
        : { stdout: String(state.foregroundPid), stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: `unknown script: ${script}`, exitCode: 1 }
  }

  /** 每次测试重建 mock 世界。 */
  function reset(): void {
    state.sftp = new FakeSftp()
    state.sftp.seed()
    state.pgidAlive = false
    state.sid = 12345
    state.sessionGroups = []
    state.foregroundPid = undefined
    state.kills = []
    state.execCalls = []
    state.channels = []
    state.shells = []
  }

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    exec = vi.fn()
    shell = vi.fn()
    sftp = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
      this.exec.mockImplementation((command: string, cb: (err: unknown, stream: FakeStream) => void) => {
        state.execCalls.push(command)
        const stream = new FakeStream()
        stream.command = command
        queueMicrotask(() => {
          cb(null, stream)
          const direct = execScript(command)
          if (direct === null) {
            state.channels.push(stream)
          } else {
            if (direct.stderr.length > 0) stream.stderr.emit('data', Buffer.from(direct.stderr))
            if (direct.stdout.length > 0) stream.emit('data', Buffer.from(direct.stdout))
            stream.finish(direct.exitCode, null)
          }
        })
        return this
      })
      this.shell.mockImplementation((_opts: unknown, cb: (err: unknown, shell: FakeShell) => void) => {
        const shell = new FakeShell()
        queueMicrotask(() => {
          cb(null, shell)
          state.shells.push(shell)
        })
        return this
      })
      this.sftp.mockImplementation((cb: (err: unknown, sftp: unknown) => void) => {
        queueMicrotask(() => cb(null, state.sftp))
        return this
      })
    }

    connect() {
      setImmediate(() => this.trigger('ready'))
      return this
    }

    trigger(event: string, ...args: unknown[]) {
      this.emit(event, ...args)
      return this
    }
  }

  return { FakeClient, state, reset }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

type Fiber = Awaited<ReturnType<Context['plugin']>>

/** 唯一 store 文件，隔离各测试的持久化。 */
let storeCounter = 0
function tmpStoreFile(): string {
  storeCounter += 1
  return join(tmpdir(), `dsh-remote-ide-subprocess-ssh-${process.pid}-${storeCounter}.json`)
}

/** 默认 spawn 规格（collect 输出，short grace）。 */
function spawnSpec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['echo', 'hi'],
    cwd: undefined,
    graceMs: 200,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
    },
    ...overrides,
  }
}

/** 默认 terminal 规格。 */
function terminalSpec(overrides: Partial<SubprocessTerminalSpawnSpec> = {}): SubprocessTerminalSpawnSpec {
  return {
    argv: ['bash'],
    cols: 80,
    rows: 24,
    graceMs: 200,
    ...overrides,
  }
}

describe('SshSubprocessRuntime 远程 subprocess', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.reset()
  })

  async function setup(): Promise<{ ctx: Context; fiber: Fiber; subprocess: SshSubprocessRuntime }> {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    context.ssh.upsertHost({
      alias: 'dev',
      host: '10.0.0.1',
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    await context.ssh.connect('dev')
    expect(context.ssh.status().home).toBe('/home/dev')
    await context.plugin(SshSubprocessRuntime, { pollMs: 5 })
    return { ctx: context, fiber: f, subprocess: context.subprocess as SshSubprocessRuntime }
  }

  /** 拿内存 SFTP（发布 pid 文件等）。 */
  async function sftpOf(ctx: Context) {
    const connection = await ctx.ssh.getConnection()
    return await connection.getSftp() as unknown as {
      nodes: Map<string, { kind: string; content: Buffer; mode: number; mtime: number }>
    }
  }

  /** 解开 `exec bash -c '...'` 外层（bashCommand 包裹）与 cd 前缀，还原脚本。 */
  function unwrapBashCommand(command: string): string {
    const cdPrefix = /^cd '([^']*)' && ([\s\S]+)$/.exec(command)
    const body = cdPrefix === null ? command : cdPrefix[2]!
    const bash = /^exec bash -c '([\s\S]*)'$/.exec(body)
    return bash === null ? body : bash[1]!.replace(/'\\''/g, "'")
  }

  /** 从 wrapper 命令提取 stateDir（environment 文件所在目录）。 */
  function stateDirOf(channelCommand: string): string {
    const match = /mapfile -d '' -t dsh_env < '([^']*)\/environment'/.exec(unwrapBashCommand(channelCommand))
    if (match === null) throw new Error(`wrapper command missing environment path: ${channelCommand}`)
    return match[1]!
  }

  /** 等待 wrapper 通道出现并返回。 */
  async function waitForChannel(): Promise<{ command: string; emit(event: string, ...args: unknown[]): void; stderr: { emit(event: string, ...args: unknown[]): void }; writes: Array<string | Buffer>; writableEnded: boolean; closed: boolean }> {
    await vi.waitFor(() => {
      expect(fake.state.channels.length).toBe(1)
    })
    const stream = fake.state.channels[0]!
    return {
      command: stream.command,
      emit: (event: string, ...args: unknown[]) => stream.emit(event, ...args),
      stderr: stream.stderr,
      writes: stream.writes,
      writableEnded: stream.writableEnded,
      // 实时读取而非取值快照（close() 可能稍后发生）。
      get closed() { return stream.destroyed },
    }
  }

  // ---------------------------------------------------------- resolveExecutable

  it('resolveExecutable：绝对路径校验原样返回；不存在报错', async () => {
    const { fiber, subprocess } = await setup()

    const absolute = await subprocess.resolveExecutable('/home/dev/project/main.ts')
    expect(absolute).toBe('/home/dev/project/main.ts')

    await expect(subprocess.resolveExecutable('/no/such/tool')).rejects.toThrow(
      'is not an executable file',
    )
    await fiber.dispose()
  })

  it('resolveExecutable：相对路径（含 /）报错，拒绝 cwd 基准猜测', async () => {
    const { fiber, subprocess } = await setup()
    await expect(subprocess.resolveExecutable('./bin/tool')).rejects.toThrow('relative path')
    await expect(subprocess.resolveExecutable('sub/dir/tool')).rejects.toThrow('relative path')
    await fiber.dispose()
  })

  it('resolveExecutable：bare 名走 command -v，cwd 基准为登录 home；PATH 覆盖生效', async () => {
    const { fiber, subprocess } = await setup()
    fake.state.which.bash = '/usr/local/bin/bash'

    const bash = await subprocess.resolveExecutable('bash')
    expect(bash).toBe('/usr/local/bin/bash')

    const withPath = await subprocess.resolveExecutable('custom-tool', { PATH: '/opt/bin' })
    expect(withPath).toBe('/usr/bin/custom-tool')
    const pathPrefix = fake.state.execCalls.find(call => call.includes('command -v') && call.includes('custom-tool'))
    expect(pathPrefix).toContain('/opt/bin')
    await fiber.dispose()
  })

  // ------------------------------------------------------------- spawn 校验

  it('spawn：空 argv / 非法 graceMs / 已中止信号均拒绝', async () => {
    const { fiber, subprocess } = await setup()

    expect(() => subprocess.spawn(spawnSpec({ argv: [] }))).toThrow('non-empty program name')
    expect(() => subprocess.spawn(spawnSpec({ graceMs: 0 }))).toThrow('positive finite')
    expect(() => subprocess.spawn(spawnSpec({ graceMs: Number.POSITIVE_INFINITY }))).toThrow('positive finite')
    const controller = new AbortController()
    controller.abort(new Error('canceled before start'))
    expect(() => subprocess.spawn(spawnSpec({ signal: controller.signal }))).toThrow('aborted before spawn')
    await fiber.dispose()
  })

  it('spawn：未连接（无激活目标）时 resolveExecutable 报错', async () => {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    await context.plugin(SshSubprocessRuntime, { pollMs: 5 })
    await expect(
      (context.subprocess as SshSubprocessRuntime).resolveExecutable('bash'),
    ).rejects.toThrow('no active connection')
    await f.dispose()
  })

  // --------------------------------------------------------------- spawn 主流程

  it('spawn：wrapper 发布 pgid → 输出收集 → 退出码从 close 事件取得', async () => {
    const { ctx, fiber, subprocess } = await setup()
    const handle = subprocess.spawn(spawnSpec({ argv: ['echo', 'hello'] }))

    const channel = await waitForChannel()
    const stateDir = stateDirOf(channel.command)
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(posix.join(stateDir, 'pid'), {
      kind: 'file',
      content: Buffer.from('777\n'),
      mode: 0o600,
      mtime: 1,
    })

    await vi.waitFor(() => expect(handle.pid).toBe(777))

    channel.emit('data', Buffer.from('hello\n'))
    channel.emit('data', Buffer.from('world\n'))
    await vi.waitFor(() => expect(handle.collected.stdout!.size).toBe(12))
    channel.emit('close', 0, null)

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()

    const collected = handle.collected.stdout!
    expect(collected.readFrom(0).text).toBe('hello\nworld\n')
    expect(collected.size).toBe(12)
    await fiber.dispose()
  })

  it('spawn：快机器竞态——发布 pid 与退出落在同一轮询窗口内仍能取到 pgid', async () => {
    const { ctx, fiber, subprocess } = await setup()
    const handle = subprocess.spawn(spawnSpec({ argv: ['echo', 'fast'] }))

    const channel = await waitForChannel()
    const sftp = await sftpOf(ctx)
    // 真实时序（真实服务器/localhost 上必然出现）：发布 pid 先于命令退出，
    // 且两者都落在一次 SFTP 轮询落空后的 race 等待窗口内——先让首轮
    // poll(ENOENT) 进入等待（pollMs=5），再在窗口内发布 + 关闭通道。
    await new Promise((resolve) => setTimeout(resolve, 2))
    sftp.nodes.set(posix.join(stateDirOf(channel.command), 'pid'), {
      kind: 'file',
      content: Buffer.from('999\n'),
      mode: 0o600,
      mtime: 1,
    })
    channel.emit('close', 0, null)

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
    expect(handle.pid).toBe(999)
    await fiber.dispose()
  })

  it('spawn：stderr 独立通道收集；非零退出码透传', async () => {
    const { ctx, fiber, subprocess } = await setup()
    const handle = subprocess.spawn(spawnSpec({ argv: ['sh', '-c', 'echo err >&2; exit 3'] }))

    const channel = await waitForChannel()
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(posix.join(stateDirOf(channel.command), 'pid'), {
      kind: 'file',
      content: Buffer.from('888\n'),
      mode: 0o600,
      mtime: 1,
    })
    await vi.waitFor(() => expect(handle.pid).toBe(888))

    channel.stderr.emit('data', Buffer.from('err\n'))
    channel.emit('close', 3, null)

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(3)
    expect(handle.collected.stderr!.readFrom(0).text).toBe('err\n')
    // stdout 也以 collect reader 存在（规格未省略），只是无输出。
    expect(handle.collected.stdout!.size).toBe(0)
    await fiber.dispose()
  })

  it('spawn：输出超 maxBytes → 有界 tail + 本地 spill 文件保留全文', async () => {
    const { ctx, fiber, subprocess } = await setup()
    const handle = subprocess.spawn(spawnSpec({
      argv: ['cat'],
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4, spill: { maxBytes: 16 } },
        stderr: { maxBytes: 4096 },
      },
    }))

    const channel = await waitForChannel()
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(posix.join(stateDirOf(channel.command), 'pid'), {
      kind: 'file',
      content: Buffer.from('999\n'),
      mode: 0o600,
      mtime: 1,
    })
    await vi.waitFor(() => expect(handle.pid).toBe(999))

    channel.emit('data', Buffer.from('12345678\n'))
    // push 异步写本地 spill；等收集完成再收尾，避免 close 竞态。
    await vi.waitFor(() => expect(handle.collected.stdout!.size).toBe(9))
    channel.emit('close', 0, null)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)

    const read = handle.collected.stdout!.readFrom(0)
    expect(read.lossy).toBe(true)
    expect(read.text).toBe('678\n')
    expect(read.spillPath).toBeDefined()
    expect(readFileSync(read.spillPath!, 'utf8')).toBe('12345678\n')
    await fiber.dispose()
  })

  it('spawn：terminate 向远程进程组发 TERM，close 后 done 带退出码', async () => {
    const { ctx, fiber, subprocess } = await setup()
    const handle = subprocess.spawn(spawnSpec({ argv: ['sleep', '100'], graceMs: 50 }))

    const channel = await waitForChannel()
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(posix.join(stateDirOf(channel.command), 'pid'), {
      kind: 'file',
      content: Buffer.from('1111\n'),
      mode: 0o600,
      mtime: 1,
    })
    await vi.waitFor(() => expect(handle.pid).toBe(1111))

    fake.state.pgidAlive = true
    handle.terminate()
    // TERM 生效后进程组消失，wrapper 随组退出。
    setTimeout(() => {
      fake.state.pgidAlive = false
      channel.emit('close', 143, null)
    }, 20)

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(143)
    expect(fake.state.kills.some(kill => kill.signal === 'TERM' && kill.args.includes('-1111'))).toBe(true)
    await fiber.dispose()
  })

  it('spawn：signal.abort 在 pid 未发布时拒绝 done（publication aborted）并关闭通道', async () => {
    const { fiber, subprocess } = await setup()
    const controller = new AbortController()
    const handle = subprocess.spawn(spawnSpec({ argv: ['sleep', '100'], signal: controller.signal }))
    const channel = await waitForChannel()

    controller.abort(new Error('user canceled'))
    await expect(handle.done).rejects.toThrow('publication aborted')
    // rollbackUnpublishedGroup 直接关闭通道，sshd 拆会话。
    expect(channel.closed).toBe(true)
    await fiber.dispose()
  })

  // -------------------------------------------------------------- spawnTerminal

  it('spawnTerminal：marker 边界 → pid → sid；output 流与 write 生效', async () => {
    const { ctx, fiber, subprocess } = await setup()
    fake.state.sid = 99

    const promise = subprocess.spawnTerminal(terminalSpec({ argv: ['vim', 'x.txt'] }))

    const shell = await vi.waitFor(() => {
      expect(fake.state.shells.length).toBe(1)
      const s = fake.state.shells[0]!
      expect(s.writes.length).toBe(1)
      return s
    })
    // FakeShell.write 已自动回显 marker；发布 pid 供轮询。
    const injected = shell.writes[0]!
    const pidMatch = /printf '%s\\n' "\$\$" > '([^']*)'/.exec(injected)
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(pidMatch![1]!, {
      kind: 'file',
      content: Buffer.from('4242\n'),
      mode: 0o600,
      mtime: 1,
    })

    const handle = await promise
    expect(handle.pid).toBe(4242)

    const chunks: Buffer[] = []
    handle.output.on('data', (chunk: Buffer) => chunks.push(chunk))
    shell.emit('data', Buffer.from('hello from vim\n'))
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(chunks).toString()).toBe('hello from vim\n')

    await handle.write(':q\r')
    expect(shell.writes[1]).toBe(':q\r')
    await fiber.dispose()
  })

  it('spawnTerminal：terminate 清理会话（TERM → 会话空 → shell 关闭 → stateDir 删除）', async () => {
    const { ctx, fiber, subprocess } = await setup()

    const promise = subprocess.spawnTerminal(terminalSpec({ graceMs: 30 }))
    const shell = await vi.waitFor(() => {
      expect(fake.state.shells.length).toBe(1)
      const s = fake.state.shells[0]!
      expect(s.writes.length).toBe(1)
      return s
    })
    const pidMatch = /printf '%s\\n' "\$\$" > '([^']*)'/.exec(shell.writes[0]!)
    const stateDir = posix.dirname(pidMatch![1]!)
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(pidMatch![1]!, {
      kind: 'file',
      content: Buffer.from('4242\n'),
      mode: 0o600,
      mtime: 1,
    })

    const handle = await promise
    fake.state.sessionGroups = []
    await handle.terminate()

    expect(shell.closed).toBe(true)
    expect(fake.state.sftp.nodes.has(stateDir)).toBe(false)
    await fiber.dispose()
  })

  it('spawnTerminal：inspectForeground 解析前台组；SIGKILL 拒绝自杀式信号', async () => {
    const { ctx, fiber, subprocess } = await setup()

    const promise = subprocess.spawnTerminal(terminalSpec())
    const shell = await vi.waitFor(() => {
      expect(fake.state.shells.length).toBe(1)
      const s = fake.state.shells[0]!
      expect(s.writes.length).toBe(1)
      return s
    })
    const pidMatch = /printf '%s\\n' "\$\$" > '([^']*)'/.exec(shell.writes[0]!)
    const sftp = await sftpOf(ctx)
    sftp.nodes.set(pidMatch![1]!, {
      kind: 'file',
      content: Buffer.from('4242\n'),
      mode: 0o600,
      mtime: 1,
    })
    const handle = await promise

    fake.state.foregroundPid = 9001
    const foreground = await handle.inspectForeground()
    expect(foreground).toEqual({ processGroupId: 9001, inputWaiting: false })

    fake.state.foregroundPid = handle.pid
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow('refusing to SIGKILL the terminal shell')

    fake.state.foregroundPid = 9001
    const signaled = await handle.signalForeground('SIGTERM')
    expect(signaled).toBe(9001)
    expect(fake.state.kills.some(kill => kill.signal === 'TERM' && kill.args.includes('-9001'))).toBe(true)
    await fiber.dispose()
  })
})

