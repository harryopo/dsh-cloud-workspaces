/**
 * 本地端口转发（ssh_tunnel）回归测试：
 * - 引擎：回环监听 → fake ssh2 forwardOut → 双向管道回声；
 * - 生命周期：closeTunnel / dispose 会关闭监听，listTunnels 同步；
 * - 工具：start/list/stop 输出与 schema 对齐、未知 id 抛错。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { SshEngine } from '../src/engine'
import { HostStore } from '../src/store'
import { sshTunnelTool } from '../src/tools'
import type { SshRuntime } from '../src/ssh-service'

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
      const wrapper: Handler = (...args: unknown[]) => { this.remove(event, wrapper); cb(...args) }
      return this.on(event, wrapper)
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

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    exec = vi.fn()
    forwardOut = vi.fn()
    end = vi.fn()
    constructor() {
      super()
      FakeClient.instances.push(this)
    }
    connect() {
      setImmediate(() => this.emit('ready'))
      return this
    }
  }

  return { FakeClient }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

let counter = 0
let engines: SshEngine[] = []
function newEngine(): SshEngine {
  counter += 1
  const storeFile = join(tmpdir(), `dsh-remote-ide-tunnel-${process.pid}-${counter}.json`)
  const store = new HostStore(storeFile)
  store.upsert({ alias: 'dev', host: '10.0.0.1', user: 'root', auth: { kind: 'password', password: 'secret' } })
  const engine = new SshEngine(store)
  engines.push(engine)
  return engine
}

describe('SshEngine 本地端口转发', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
  })
  afterEach(() => {
    for (const engine of engines) engine.dispose()
    engines = []
  })

  it('start：回环监听实际端口，连接时 forwardOut 指向目标并双向回声', async () => {
    const engine = newEngine()
    const client = fake.FakeClient.instances
    const tunnel = await engine.openTunnel('dev', { remoteHost: '127.0.0.1', remotePort: 8080 })
    expect(tunnel.localHost).toBe('127.0.0.1')
    expect(tunnel.localPort).toBeGreaterThan(0)
    expect(engine.listTunnels()).toHaveLength(1)
    expect(client.length).toBe(1)
    const forward = client[0]!.forwardOut as unknown as { mockImplementation(fn: (...args: unknown[]) => void): void; mock: { calls: unknown[][] } }
    forward.mockImplementation((_sip: unknown, _sport: unknown, _host: unknown, _port: unknown, cb: unknown) => {
      (cb as (err: unknown, stream: PassThrough) => void)(null, new PassThrough())
    })
    const echo = await new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1', () => { socket.write('ping') })
      socket.on('data', (chunk) => { resolve(chunk.toString()); socket.destroy() })
      socket.on('error', reject)
    })
    expect(echo).toBe('ping')
    expect(forward.mock.calls[0]?.slice(2, 4)).toEqual(['127.0.0.1', 8080])
  })

  it('stop：closeTunnel 关闭监听并从列表移除，未知 id 返回 false', async () => {
    const engine = newEngine()
    const tunnel = await engine.openTunnel('dev', { remoteHost: '127.0.0.1', remotePort: 22 })
    expect(engine.closeTunnel(tunnel.id)).toBe(true)
    expect(engine.listTunnels()).toHaveLength(0)
    expect(engine.closeTunnel(tunnel.id)).toBe(false)
    await expect(new Promise((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1', () => { socket.destroy(); resolve('connected') })
      socket.on('error', reject)
    })).rejects.toBeTruthy()
  })

  it('dispose：连接回收时一并关闭隧道', async () => {
    const engine = newEngine()
    await engine.openTunnel('dev', { remoteHost: 'db', remotePort: 5432 })
    expect(engine.listTunnels()).toHaveLength(1)
    engine.dispose()
    expect(engine.listTunnels()).toHaveLength(0)
  })
})

describe('ssh_tunnel 工具', () => {
  const tunnel = { id: 't1', hostId: 'dev', localHost: '127.0.0.1' as const, localPort: 9000, remoteHost: '127.0.0.1', remotePort: 8080, createdAt: 1 }
  function stub() {
    return {
      engine: {
        status: () => ({ alias: 'dev', state: 'connected' }),
        openTunnel: vi.fn(async () => tunnel),
        listTunnels: vi.fn(() => [tunnel]),
        closeTunnel: vi.fn((id: string) => id === 't1'),
      },
    } as unknown as SshRuntime
  }

  it('start：返回隧道字段并渲染转发地址', async () => {
    const runtime = stub()
    const tool = sshTunnelTool(runtime)
    const output = await tool.execute({ action: 'start', remoteHost: '127.0.0.1', remotePort: 8080 })
    expect(output).toMatchObject({ action: 'start', id: 't1', localPort: 9000, hostId: 'dev' })
    const rendered = tool.output.render({}, output as never)
    expect(rendered[0]?.text).toContain('127.0.0.1:9000')
  })

  it('list：输出 schema 声明的字段', async () => {
    const tool = sshTunnelTool(stub())
    const output = await tool.execute({ action: 'list' })
    expect(output.action).toBe('list')
    expect(output.tunnels).toHaveLength(1)
  })

  it('stop：未知 id 抛错', async () => {
    const tool = sshTunnelTool(stub())
    await expect(tool.execute({ action: 'stop', id: 'nope' })).rejects.toThrow(/unknown tunnel/)
  })
})
