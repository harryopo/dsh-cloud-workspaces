/**
 * SshRuntime 生命周期测试 —— 参照官方 E2BRuntime 的测试模式
 * （.research/dsh-source/deepseek-harness-master/packages/e2b/e2b/tests/e2b.spec.ts）：
 * vi.mock('ssh2') + FakeClient fixture，验证惰性连接、句柄复用、broken 自动
 * 重建与 disposal 竞态。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from '../src/ssh-service'

/** 可编程的 ssh2 假实现：事件注册 + 测试辅助触发。 */
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

  class FakeStream extends MiniEmitter {
    stderr = new MiniEmitter()
    close() {
      this.emit('close', 0)
    }
  }

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    /** 下一次 connect 的行为：ready（默认）或 error（模拟临时不可达）。 */
    static nextConnectBehavior: 'ready' | 'error' = 'ready'
    exec = vi.fn()
    shell = vi.fn()
    sftp = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
      // 默认 exec：模拟一条成功命令（输出 'ok'，退出码 0）。
      this.exec.mockImplementation((command: string, cb: (err: unknown, stream: FakeStream) => void) => {
        const stream = new FakeStream()
        queueMicrotask(() => {
          cb(null, stream)
          stream.emit('data', Buffer.from('ok'))
          stream.emit('close', 0)
        })
        return this
      })
    }

    /** engine.connectClient 调用的入口：异步触发 ready 或 error。 */
    connect() {
      setImmediate(() => {
        if (FakeClient.nextConnectBehavior === 'ready') this.trigger('ready')
        else this.trigger('error', new Error('connect refused'))
      })
      return this
    }

    /** 测试辅助：模拟底层连接失败 / 被关闭。 */
    trigger(event: string, ...args: unknown[]) {
      this.emit(event, ...args)
      return this
    }
  }

  return { FakeClient }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

type Fiber = Awaited<ReturnType<Context['plugin']>>

/** 唯一 store 文件，隔离各测试的持久化。 */
let storeCounter = 0
function tmpStoreFile(): string {
  storeCounter += 1
  return join(tmpdir(), `dsh-remote-ide-ssh-service-${process.pid}-${storeCounter}.json`)
}

describe('SshRuntime 连接生命周期', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
  })

  async function setup(): Promise<{ ctx: Context; fiber: Fiber; runtime: SshRuntime }> {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    const service = context.ssh
    service.upsertHost({
      alias: 'dev',
      host: '10.0.0.1',
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    return { ctx: context, fiber: f, runtime: service }
  }

  it('初始无激活连接：status disconnected，getConnection 拒绝', async () => {
    const { runtime } = await setup()
    expect(runtime.status().state).toBe('disconnected')
    await expect(runtime.getConnection()).rejects.toThrow(/no active connection/)
    expect(fake.FakeClient.instances).toHaveLength(0)
  })

  it('connect 建立连接，getConnection 复用同一句柄（同一底层连接）', async () => {
    const { fiber, runtime } = await setup()
    const status = await runtime.connect('dev')

    expect(status.state).toBe('connected')
    expect(runtime.status().home).toBe('ok')

    const first = await runtime.getConnection()
    const second = await runtime.getConnection()
    expect(first).toBe(second) // ready 缓存 → 同一引用
    expect(first.alias).toBe('dev')
    expect(first.home).toBe('ok')

    // 两次获取只建立一个底层 ssh2 连接。
    expect(fake.FakeClient.instances).toHaveLength(1)

    // 句柄上的操作委托到激活连接。
    const result = await first.exec('echo hi')
    expect(result.success).toBe(true)
    expect(result.stdout).toBe('ok')

    await fiber.dispose()
    expect(fake.FakeClient.instances[0]?.end).toHaveBeenCalled()
  })

  it('dispose 后 getConnection 拒绝（disposal 竞态防护）', async () => {
    const { fiber, runtime } = await setup()
    await runtime.connect('dev')

    await fiber.dispose()
    await expect(runtime.getConnection()).rejects.toThrow(/disposing/)
  })

  it('底层连接 broken 时 getConnection 自动重建', async () => {
    const { runtime } = await setup()
    await runtime.connect('dev')
    expect(fake.FakeClient.instances).toHaveLength(1)

    // 模拟传输层错误 → engine 将连接标记 broken。
    fake.FakeClient.instances[0]!.trigger('error', new Error('connection reset'))

    // getConnection 自动重建新连接，句柄指向新的底层连接。
    const connection = await runtime.getConnection()
    expect(connection.alias).toBe('dev')
    expect(connection.home).toBe('ok')
    expect(fake.FakeClient.instances).toHaveLength(2)
  })

  it('connect 未知主机不抛异常，状态置 failed', async () => {
    const { runtime } = await setup()
    const status = await runtime.connect('nope')

    expect(status.state).toBe('failed')
    expect(status.error).toMatch(/unknown host/)
    expect(fake.FakeClient.instances).toHaveLength(0)
  })

  it('切换目标：connect(新 alias) 后句柄指向新连接', async () => {
    const { runtime } = await setup()
    runtime.upsertHost({
      alias: 'prod',
      host: '10.0.0.2',
      user: 'deploy',
      auth: { kind: 'password', password: 'secret2' },
    })
    await runtime.connect('dev')
    const dev = await runtime.getConnection()
    expect(dev.alias).toBe('dev')

    await runtime.connect('prod')
    const prod = await runtime.getConnection()
    expect(prod.alias).toBe('prod')
    expect(prod).not.toBe(dev)
    expect(fake.FakeClient.instances).toHaveLength(2)
  })

  it('临时连接失败后不被陈旧 rejection 毒化：主机恢复后 getConnection 自愈', async () => {
    const { runtime } = await setup()
    fake.FakeClient.nextConnectBehavior = 'error'
    const failed = await runtime.connect('dev')
    expect(failed.state).toBe('failed')
    // connect 内部还会立即打开一次句柄（在途中）——等它同样落败，
    // 确保 ready 已是陈旧 rejection，之后的自愈只能靠重建。
    await new Promise((resolve) => setImmediate(resolve))
    const failedAttempts = fake.FakeClient.instances.length

    // 主机恢复可达——此前实现会永久缓存 rejected ready，每次 getConnection
    // 都抛陈旧错误；修复后应重建连接自愈。
    fake.FakeClient.nextConnectBehavior = 'ready'
    const connection = await runtime.getConnection()
    expect(connection.alias).toBe('dev')
    expect(fake.FakeClient.instances.length).toBe(failedAttempts + 1)
  })
})
