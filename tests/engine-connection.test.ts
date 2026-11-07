/**
 * SshEngine 连接池并发回归测试 —— E2E 真机抓到的竞态：
 * ensureConnection 在连接建立中会把 client 尚未赋值的 PoolRecord 返回给
 * 并发调用者，导致 `record.client.exec` 崩溃（TypeError: reading 'exec'）。
 * 修复后：在途尝试登记 connecting map，并发调用者 await 同一 attempt。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostKeyFingerprint, SshEngine } from '../src/engine'
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
    resume() {}
    close() {
      this.emit('close', 0)
    }
  }

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    /** 下一次 connect 的行为：ready（默认）或 error。 */
    static nextConnectBehavior: 'ready' | 'error' = 'ready'
    /** 逐次消费的行为队列（优先于 nextConnectBehavior）。 */
    static behaviorQueue: Array<'ready' | 'error'> = []
    /** 服务器出示的主机密钥；测试改它来模拟换钥/中间人。 */
    static hostKey: Buffer = Buffer.from('host-key-A')

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

    connect(config?: { hostVerifier?: (key: Buffer) => boolean }) {
      const behavior = FakeClient.behaviorQueue.shift() ?? FakeClient.nextConnectBehavior
      setImmediate(() => {
        if (behavior !== 'ready') {
          this.emit('error', new Error('boom'))
          return
        }
        // 真实 ssh2 在认证前同步调用 hostVerifier；返回 false 即握手失败。
        const verifier = config?.hostVerifier
        if (typeof verifier === 'function' && verifier(FakeClient.hostKey) === false) {
          this.emit('error', new Error('Host denied (verification failed)'))
          return
        }
        this.emit('ready')
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
    fake.FakeClient.behaviorQueue = []
    // 主机密钥状态也是跨用例泄漏源（AGENTS 坑 10 的变体）：必须逐用例复位。
    fake.FakeClient.hostKey = Buffer.from('host-key-A')
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

  it('握手失败时释放半开 client（重试不累积泄漏）', async () => {
    const { engine } = newEngine()
    fake.FakeClient.nextConnectBehavior = 'error'
    await expect(engine.ensureConnection('dev')).rejects.toThrow('boom')
    expect(fake.FakeClient.instances[0]!.end).toHaveBeenCalled()
  })

  it('跳板链中途失败：已建立的跳板被释放（不泄漏 client）', async () => {
    const storeFile = join(tmpdir(), `dsh-remote-ide-engine-hop-${process.pid}-${Date.now()}.json`)
    const store = new HostStore(storeFile)
    store.upsert({ alias: 'hop1', host: '10.0.0.2', user: 'root', auth: { kind: 'password', password: 'x' } })
    store.upsert({ alias: 'hop2', host: '10.0.0.3', user: 'root', auth: { kind: 'password', password: 'x' } })
    store.upsert({
      alias: 'dev', host: '10.0.0.1', user: 'root',
      auth: { kind: 'password', password: 'secret' }, proxyJump: ['hop1', 'hop2'],
    })
    const engine = new SshEngine(store)
    fake.FakeClient.behaviorQueue = ['ready', 'error']
    await expect(engine.ensureConnection('dev')).rejects.toThrow('boom')
    const hop = fake.FakeClient.instances[0]!
    expect(hop.end).toHaveBeenCalled()
  })
})

describe('SshEngine openShell 的 inFlight 释放语义', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
    fake.FakeClient.behaviorQueue = []
    // 主机密钥状态也是跨用例泄漏源（AGENTS 坑 10 的变体）：必须逐用例复位。
    fake.FakeClient.hostKey = Buffer.from('host-key-A')
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

/** 读取 store 文件里的主机条目（断言指纹是否落盘 / 是否被改写）。 */
function readHosts(storeFile: string): Array<{ alias: string; hostKey?: { fingerprint: string; recordedAt: number } }> {
  const parsed = JSON.parse(readFileSync(storeFile, 'utf8')) as {
    hosts: Array<{ alias: string; hostKey?: { fingerprint: string; recordedAt: number } }>
  }
  return parsed.hosts
}

describe('SshEngine 主机密钥校验（TOFU）', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
    fake.FakeClient.behaviorQueue = []
    fake.FakeClient.hostKey = Buffer.from('host-key-A')
  })

  it('首次连接记录服务器指纹并落盘', async () => {
    const { engine, storeFile } = newEngine()
    await engine.ensureConnection('dev')
    const hosts = readHosts(storeFile)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.hostKey?.fingerprint).toBe(hostKeyFingerprint(fake.FakeClient.hostKey))
    expect(typeof hosts[0]!.hostKey?.recordedAt).toBe('number')
  })

  it('已记录指纹匹配时重连放行（从 store 复读，且不重写记录）', async () => {
    const { engine, storeFile } = newEngine()
    await engine.ensureConnection('dev')
    const recordedAt = readHosts(storeFile)[0]!.hostKey!.recordedAt
    // 新引擎从同一 store 复读，等价于一次重启后重连。
    const reloaded = new SshEngine(new HostStore(storeFile))
    const record = await reloaded.ensureConnection('dev')
    expect(record.client).toBeDefined()
    expect(readHosts(storeFile)[0]!.hostKey!.recordedAt).toBe(recordedAt)
  })

  it('指纹不匹配时拒绝连接，给出中间人告警并保留旧记录', async () => {
    const { engine, storeFile } = newEngine()
    await engine.ensureConnection('dev')
    const trusted = hostKeyFingerprint(Buffer.from('host-key-A'))
    fake.FakeClient.instances.length = 0
    // 同一端点换了主机密钥：模拟中间人或服务器重装。
    fake.FakeClient.hostKey = Buffer.from('host-key-B')
    const presented = hostKeyFingerprint(fake.FakeClient.hostKey)
    const reloaded = new SshEngine(new HostStore(storeFile))

    let message = ''
    try {
      await reloaded.ensureConnection('dev')
      throw new Error('expected rejection')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('主机密钥已变更，可能存在中间人风险')
    expect(message).toContain(trusted)
    expect(message).toContain(presented)
    // 拒绝文案必须给出清除旧指纹的路径。
    expect(message).toContain('hostKey')
    // 旧指纹不被覆盖；半开 client 被释放（不累积泄漏）。
    expect(readHosts(storeFile)[0]!.hostKey!.fingerprint).toBe(trusted)
    expect(fake.FakeClient.instances[0]!.end).toHaveBeenCalled()
  })

  it('测试连接复用同端点指纹：匹配放行、不匹配拒绝', async () => {
    const { engine, storeFile } = newEngine()
    await engine.ensureConnection('dev')
    const reloaded = new SshEngine(new HostStore(storeFile))
    const config = {
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      auth: { kind: 'password' as const, password: 'secret' },
    }
    expect((await reloaded.testConfig(config)).ok).toBe(true)

    fake.FakeClient.hostKey = Buffer.from('host-key-B')
    const denied = await reloaded.testConfig(config)
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/主机密钥已变更，可能存在中间人风险/)
  })

  it('未保存主机的 ad-hoc 探测：首次信任放行但不落盘', async () => {
    const storeFile = join(tmpdir(), `dsh-remote-ide-engine-probe-${process.pid}-${Date.now()}.json`)
    const engine = new SshEngine(new HostStore(storeFile))
    const result = await engine.testConfig({
      host: '10.0.0.9',
      port: 22,
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    expect(result.ok).toBe(true)
    // 探测不带别名：信任不落盘（store 文件从未被创建）。
    expect(existsSync(storeFile)).toBe(false)
  })
})
