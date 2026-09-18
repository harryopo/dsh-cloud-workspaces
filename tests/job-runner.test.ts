/**
 * job-runner 单测 —— fake engine（可编程通道/exec）+ fake JobRegistry（捕获 spec）。
 * 覆盖：background 返回、spec 形状、wrapper 协议、done 三态（流式 job 无 output，
 * 对齐 dsh-jobs d.ts「stream jobs leave it unset」）、readOutput 异步泵与游标、
 * cancel 幂等与 TERM→KILL 升级、jobs 缺失报错。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startRemoteJob } from '../src/job-runner'

type CloseListener = (code: number | null, signal: string | null) => void
class FakeChannel {
  closeListeners: CloseListener[] = []
  onClose(l: CloseListener) { this.closeListeners.push(l) }
  fire(code: number | null, signal: string | null) { for (const l of [...this.closeListeners]) l(code, signal) }
}

const okResult = (stdout = '') => ({ success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 1 })

function makeFakes() {
  const channel = new FakeChannel()
  const openChannel = vi.fn(async () => channel as never)
  const exec = vi.fn(async () => okResult())
  const engine = { openChannel, exec, homeOf: () => '/root' } as never
  let spec: Record<string, unknown> | undefined
  const jobs = { start: (s: Record<string, unknown>) => { spec = s; return 'ssh-1' } } as never
  return { channel, openChannel, exec, engine, jobs, spec: () => spec! }
}

/** 取第 n 次 exec 调用的命令串列表。 */
const execCommands = (exec: { mock: { calls: unknown[][] } }) =>
  exec.mock.calls.map(c => (c as [string, string])[1])

/** openChannel 是异步的：等通道 onClose 监听器挂上再驱动 close 事件。 */
async function awaitChannel(f: { channel: FakeChannel }) {
  await vi.waitFor(() => expect(f.channel.closeListeners.length).toBe(1))
}

describe('startRemoteJob', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('返回 background 形状并以 kind=ssh/label=命令注册 spec', () => {
    const f = makeFakes()
    const out = startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'make build' })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-1' })
    const spec = f.spec()
    expect(spec.kind).toBe('ssh')
    expect(spec.label).toBe('make build')
    expect(typeof spec.run).toBe('function')
    expect(spec.outputLimitBytes).toBe(8192)
  })

  it('wrapper 协议：pidfile + exec bash -c + 日志重定向，路径 quoteSh', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: "echo it's", cwd: '/work' })
    const hooks = f.spec().run as () => unknown
    void hooks()
    const [alias, wrapper, opts] = f.openChannel.mock.calls[0] as [string, string, { cwd?: string }]
    expect(alias).toBe('dev')
    expect(opts.cwd).toBe('/work')
    expect(wrapper.startsWith("printf %s $$ > '/tmp/dsh-job-")).toBe(true)
    expect(wrapper).toContain(".pid' && exec bash -c ")
    expect(wrapper).toContain("'echo it'\\''s'")
    expect(wrapper).toMatch(/> '\/tmp\/dsh-job-[0-9a-f-]+\.log' 2>&1$/)
  })

  it('jobs 缺失 → throw 官方同款文案', () => {
    const f = makeFakes()
    expect(() => startRemoteJob({ engine: f.engine, jobs: undefined }, { hostId: 'dev', command: 'x' }))
      .toThrow(/background jobs unavailable/)
  })

  it('done：exit code 3 → completed + detail（流式 job 无 output 字段）', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(3, null)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 3' })
  })

  it('done：signal → killed', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(null, 'SIGTERM')
    await expect(hooks.done).resolves.toEqual({ status: 'killed', detail: 'SIGTERM' })
  })

  it('done：无码无号 + kill -0 探测存活 → failed 带孤儿 pid/log 提示', async () => {
    const f = makeFakes()
    f.exec.mockImplementation(async (_a: string, cmd: string) => okResult(cmd.startsWith("bash -c 'kill -0") ? 'alive' : ''))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(null, null)
    const o = await hooks.done
    expect(o.status).toBe('failed')
    expect(String(o.detail)).toMatch(/may still be running/)
    expect(String(o.detail)).toMatch(/\/tmp\/dsh-job-.*\.log/)
  })

  it('done 只 settle 一次（close 后重复事件被忽略）', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(0, null)
    f.channel.fire(1, null)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('readOutput：异步泵取回块后消费；游标推进 skip=0→1', async () => {
    const f = makeFakes()
    let delivered = false
    f.exec.mockImplementation(async (_a: string, cmd: string) => {
      if (cmd.startsWith('dd ') && !delivered) { delivered = true; return okResult('tick1\n') }
      return okResult()
    })
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { readOutput?(): string })()
    expect(hooks.readOutput!()).toBe('') // 首调只启动泵，无积压
    await vi.waitFor(() => {
      // 泵在推进；持续消费直到取回
      const t = hooks.readOutput!()
      expect(t).toContain('tick1')
    })
    const ddCalls = execCommands(f.exec).filter(c => c.startsWith('dd '))
    expect(ddCalls[0]).toContain('bs=65536 skip=0 count=1')
    expect(ddCalls.some(c => c.includes('skip=1'))).toBe(true)
  })

  it('readOutput：exec 失败（断连/日志未生成）→ 空串不抛', async () => {
    const f = makeFakes()
    f.exec.mockRejectedValue(new Error('disconnected'))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { readOutput?(): string })()
    await vi.waitFor(() => expect(hooks.readOutput!()).toBe(''))
  })

  it('cancel：TERM 一次、幂等、5s 后升级 KILL', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { cancel(): void })()
    await awaitChannel(f)
    hooks.cancel()
    hooks.cancel()
    await vi.waitFor(() => {
      const kills = execCommands(f.exec).filter(c => c.includes('kill -'))
      expect(kills).toHaveLength(1)
      expect(kills[0]).toContain("kill -TERM -$(cat")
    })
    await vi.advanceTimersByTimeAsync(5_100)
    const escalated = execCommands(f.exec).filter(c => c.includes('kill -'))
    expect(escalated).toHaveLength(2)
    expect(escalated[1]).toContain("kill -KILL -$(cat")
  })

  it('通道建立失败 → done=failed（错误消息透传）', async () => {
    const f = makeFakes()
    f.openChannel.mockRejectedValue(new Error('unknown host: dev'))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await expect(hooks.done).resolves.toEqual({ status: 'failed', detail: 'unknown host: dev' })
  })
})
