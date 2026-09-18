/**
 * ssh_* 工具输出边界回归测试 —— 真机（用户会话）抓到的 bug：
 * ① ssh_list 输出的 SshHostSummary 携带 `description: undefined` /
 *    `environment: undefined` own-keys → lossless-JSON 校验拒绝；
 * ② 修掉 ① 后下一层暴露：createdAt/updatedAt 未在 output schema 声明，
 *    additionalProperties:false 拒绝。输出必须与 schema 声明严格对齐。
 */

import { describe, expect, it, vi } from 'vitest'
import { sshExecTool, sshListTool, sshWorkspaceTool } from '../src/tools'
import type { SshRuntime } from '../src/ssh-service'

/** 轻量镜像 lossless-JSON 断言（同 dsh-session walkJsonValue 语义）。 */
function assertLosslessJson(value: unknown, ancestors: Set<unknown> = new Set()): void {
  if (value === undefined) throw new TypeError('undefined is not lossless JSON')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('non-finite number')
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${typeof value} is not lossless JSON`)
  if (ancestors.has(value)) throw new TypeError('cyclic value')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertLosslessJson(item, ancestors)
    return
  }
  for (const key of Object.keys(value)) {
    assertLosslessJson((value as Record<string, unknown>)[key], ancestors)
  }
}

/** SshRuntime stub：只实现工具消费的引擎面。 */
function stubRuntime(engine: Record<string, unknown> = {}): SshRuntime {
  return {
    engine: {
      status: () => ({ alias: 'server', state: 'connected', home: '/root' }),
      list: () => [],
      exec: async () => ({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }),
      ...engine,
    },
  } as unknown as SshRuntime
}

/** 引擎返回的两台主机：完整 store 摘要形状（含 schema 未声明的时间戳字段）。 */
function hostsFromStore(): Array<Record<string, unknown>> {
  return [
    {
      alias: 'server', host: '192.168.45.200', port: 22, user: 'root',
      auth: 'password', keyReady: true, proxyJump: [],
      description: undefined, environment: undefined, tags: [],
      createdAt: 1788056122468, updatedAt: 1788056122468,
    },
    {
      alias: 'wsl-e2e', host: '127.0.0.1', port: 2223, user: 'root',
      auth: 'password', keyReady: true, proxyJump: [],
      description: 'local wsl', environment: undefined, tags: ['e2e'],
      createdAt: 1788056122468, updatedAt: 1788056122468,
    },
  ]
}

describe('ssh_list 输出边界', () => {
  it('undefined 字段剥离、有值字段保留（lossless 回归）', async () => {
    const tool = sshListTool(stubRuntime({ list: () => hostsFromStore() }))
    const output = await tool.execute({})
    assertLosslessJson(output)
    expect(output.hosts).toHaveLength(2)
    // server 主机的 description/environment 为 undefined → own-key 剥离；
    // wsl-e2e 的 description 有值 → 保留。
    expect(Object.hasOwn(output.hosts[0], 'description')).toBe(false)
    expect(Object.hasOwn(output.hosts[0], 'environment')).toBe(false)
    expect((output.hosts[1] as Record<string, unknown>).description).toBe('local wsl')
  })

  it('输出字段与 schema 声明严格一致（createdAt/updatedAt 泄漏回归）', async () => {
    const tool = sshListTool(stubRuntime({ list: () => hostsFromStore() }))
    const output = await tool.execute({})
    const schema = tool.output.schema as unknown as {
      properties: { hosts: { items: { properties: Record<string, unknown> } }, total: unknown }
    }
    const hostDeclared = new Set(Object.keys(schema.properties.hosts.items.properties))
    for (const host of output.hosts) {
      for (const key of Object.keys(host)) {
        expect(hostDeclared.has(key)).toBe(true)
      }
    }
    const rootDeclared = new Set(Object.keys(schema.properties))
    for (const key of Object.keys(output)) {
      expect(rootDeclared.has(key)).toBe(true)
    }
    expect(Object.hasOwn(output.hosts[0], 'createdAt')).toBe(false)
  })

  it('空 store 输出 total=0；render 提示去设置面板添加', async () => {
    const tool = sshListTool(stubRuntime())
    const output = await tool.execute({})
    assertLosslessJson(output)
    expect(output.total).toBe(0)
    const rendered = tool.output.render({}, output as never)
    expect(rendered[0]?.text).toContain('no hosts configured')
    expect(rendered[0]?.text).toContain('设置')
  })

  it('render：过滤无匹配但 store 有主机时不再说 no hosts configured', () => {
    const tool = sshListTool(stubRuntime())
    const rendered = tool.output.render({ query: 'nomatch' }, { hosts: [], total: 2 } as never)
    expect(rendered[0]?.text).toContain('no hosts match query')
    expect(rendered[0]?.text).toContain('2 host(s)')
    expect(rendered[0]?.text).not.toContain('no hosts configured')
  })
})

describe('ssh_exec 输出边界', () => {
  it('exitCode 为 null（通道异常退出）时输出无 undefined own-key', async () => {
    const exec = vi.fn(async () => ({
      success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 3, error: 'channel error',
    }))
    const tool = sshExecTool(stubRuntime({ exec }), undefined)
    const output = await tool.execute({ command: 'true' })
    assertLosslessJson(output)
    expect(output.kind).toBe('foreground')
    expect(Object.hasOwn(output, 'exitCode')).toBe(false)
    expect(output.error).toBe('channel error')
  })
})

describe('ssh_exec run_in_background', () => {
  it('后台分支：注册 spec（kind ssh）返回 {kind:background, jobId}，不跑前台 exec', async () => {
    const exec = vi.fn()
    const started: unknown[] = []
    const jobs = { start: (s: { label: string }) => { started.push(s); return 'ssh-2' } }
    const tool = sshExecTool(stubRuntime({ exec }), jobs as never)
    const out = await tool.execute({ command: 'sleep 100', run_in_background: true }, { agent: undefined })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-2' })
    expect(exec).not.toHaveBeenCalled()
    expect(started[0]).toMatchObject({ kind: 'ssh', label: 'sleep 100' })
  })

  it('render：background 结果渲染 started 文案', () => {
    const tool = sshExecTool(stubRuntime(), undefined)
    const rendered = tool.output.render({}, { kind: 'background', jobId: 'ssh-3' } as never)
    expect(rendered[0]?.text).toContain('started background job ssh-3')
  })
})


describe('ssh_workspace registration', () => {
  it('registers a created placeholder when workspaceRegistry is available', async () => {
    const create = vi.fn(async () => undefined)
    const ctx = { get: vi.fn(() => ({ create })) }
    const runtime = Object.assign(stubRuntime(), { getConnectionFor: vi.fn(async () => undefined) })
    const tool = sshWorkspaceTool(runtime, ctx as never)
    const output = await tool.execute({ action: 'create', host: 'server', path: '/srv/my-project' })
    assertLosslessJson(output)
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(output.localPath, 'server / my-project')
  })

  it('still succeeds when workspaceRegistry is unavailable', async () => {
    const ctx = { get: vi.fn(() => undefined) }
    const runtime = Object.assign(stubRuntime(), { getConnectionFor: vi.fn(async () => undefined) })
    const tool = sshWorkspaceTool(runtime, ctx as never)
    const output = await tool.execute({ action: 'create', host: 'server', path: '/srv/no-registry' })
    assertLosslessJson(output)
    expect(output).toMatchObject({ action: 'create', host: 'server', remotePath: '/srv/no-registry' })
  })
})
