/**
 * SshEngine 连接池并发回归测试 —— E2E 真机抓到的竞态：
 * ensureConnection 在连接建立中会把 client 尚未赋值的 PoolRecord 返回给
 * 并发调用者，导致 `record.client.exec` 崩溃（TypeError: reading 'exec'）。
 * 修复后：在途尝试登记 connecting map，并发调用者 await 同一 attempt。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshEngine } from '../src/engine'
import { HostStore } from '../src/store'

/** 可编程 ssh2 假实现：connect 时机可控（默认 setImmediate ready）。 */
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
    /** 下一次 connect 的行为：ready（默认）或 error。 */
    static nextConnectBehavior: 'ready' | 'error' = 'ready'

    exec = vi.fn()
    shell = vi.fn()
    sftp = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
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

    connect() {
      const behavior = FakeClient.nextConnectBehavior
      setImmediate(() => {
        if (behavior === 'ready') this.emit('ready')
        else this.emit('error', new Error('boom'))
      })
      return this
    }
  }

  return { FakeClient, FakeStream }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

let storeCounter = 0
function newEngine(): { engine: SshEngine; storeFile: string } {
  storeCounter += 1
  const storeFile = join(tmpdir(), `dsh-remote-ide-engine-conn-${process.pid}-${storeCounter}.json`)
  const store = new HostStore(storeFile)
  store.upsert({
    alias: 'dev',
    host: '10.0.0.1',
    user: 'root',
    auth: { kind: 'password', password: 'secret' },
  })
  return { engine: new SshEngine(store), storeFile }
}

describe('SshEngine 连接池并发语义', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
  })

  it('并发 ensureConnection 去重：单一底层连接，且 client 均已就绪', async () => {
    const { engine } = newEngine()
    const p1 = engine.ensureConnection('dev')
    const p2 = engine.ensureConnection('dev')
    // 在 ready（setImmediate）触发前，两条调用都必须已挂起。
    expect(fake.FakeClient.instances.length).toBe(1)
    const r1 = await p1
    const r2 = await p2
    expect(r1).toBe(r2)
    expect(r1.client).toBeDefined()
    expect(r1.client).toBe(fake.FakeClient.instances[0])
  })

  it('连接在途时 exec 安全等待（不再读到未赋值 client）', async () => {
    const { engine } = newEngine()
    const pending = engine.exec('dev', 'echo hi')
    // exec 触发的 ensureConnection 已登记在途尝试，client 此刻尚未赋值。
    expect(fake.FakeClient.instances.length).toBe(1)
    const result = await pending
    expect(result.success).toBe(true)
    expect(result.stdout).toBe('ok')
  })

  it('连接失败时并发调用者收到同一错误，池不留残记录', async () => {
    const { engine } = newEngine()
    fake.FakeClient.nextConnectBehavior = 'error'
    const p1 = engine.ensureConnection('dev')
    const p2 = engine.ensureConnection('dev')
    expect(fake.FakeClient.instances.length).toBe(1)
    await expect(p1).rejects.toThrow('boom')
    await expect(p2).rejects.toThrow('boom')
    // 失败后可重试：新 attempt 建立新连接。
    fake.FakeClient.nextConnectBehavior = 'ready'
    const retry = await engine.ensureConnection('dev')
    expect(retry.client).toBeDefined()
    expect(fake.FakeClient.instances.length).toBe(2)
  })
})

describe('SshEngine openShell 的 inFlight 释放语义', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
  })

  it('error 与 close 双发只释放一次（不降到负数让 sweep 误断忙碌连接）', async () => {
    const { engine } = newEngine()
    await engine.ensureConnection('dev')
    const client = fake.FakeClient.instances[0]!
    let channel: InstanceType<typeof fake.FakeStream> | undefined
    client.shell.mockImplementation((_opts: unknown, cb: (err: unknown, ch: unknown) => void) => {
      channel = new fake.FakeStream()
      queueMicrotask(() => cb(null, channel))
    })
    const session = await engine.openShell('dev', 80, 24)
    expect(session).toBeDefined()
    // ssh2 常见：channel error 之后 close 也会再来一次；此前实现两次都减
    // inFlight。（传输级 error 必须先于取通道之后发——之前发会触发
    // broken 重建，属正确的另一语义。）
    channel!.emit('error', new Error('channel reset'))
    channel!.emit('close')
    const record = (engine as unknown as { pool: Map<string, { inFlight: number }> }).pool.get('dev')
    expect(record?.inFlight).toBe(0)
  })
})
