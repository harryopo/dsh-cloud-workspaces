/**
 * Typert 端点结果 JSON-safe 回归测试 —— 真机抓到的 bug：网关边界校验
 * （assertJsonValue）要求业务结果纯 JSON-safe，显式赋值的 `error: undefined`
 * 是 own property，会被拒绝（"business result failed boundary validation"）。
 * 8/28 验证时连接一直失败（error 为字符串能过校验），成功路径从未走过网关。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { jsonSafe, SshRemoteService } from '../src/typert'
import type { SshHostConfig } from '../src/host-settings'

/** 轻量镜像网关断言：递归拒绝 undefined / 非有限数 / 非 plain object。 */
function assertJsonSafe(value: unknown, ancestors: Set<unknown> = new Set()): void {
  if (value === undefined) throw new TypeError('undefined is not JSON-safe')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number')
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${typeof value} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError('cyclic value')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, ancestors)
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) throw new TypeError('non-plain object')
  for (const key of Object.keys(value)) {
    assertJsonSafe((value as Record<string, unknown>)[key], ancestors)
  }
}

describe('jsonSafe', () => {
  it('剥离 undefined own-values（嵌套对象与数组）', () => {
    const input = {
      ok: true,
      latencyMs: 42,
      error: undefined,
      nested: { present: 'yes', absent: undefined },
      list: [{ fine: 1, skip: undefined }, undefined, 'keep'],
    }
    const output = jsonSafe(input)
    expect(Object.hasOwn(output, 'error')).toBe(false)
    expect(Object.hasOwn((output as { nested: Record<string, unknown> }).nested, 'absent')).toBe(false)
    expect((output as { list: unknown[] }).list).toEqual([{ fine: 1 }, 'keep'])
    expect(output).toEqual({ ok: true, latencyMs: 42, nested: { present: 'yes' }, list: [{ fine: 1 }, 'keep'] })
  })

  it('原始值与 null 原样返回', () => {
    expect(jsonSafe('text')).toBe('text')
    expect(jsonSafe(0)).toBe(0)
    expect(jsonSafe(null)).toBe(null)
  })
})

describe('SshRemoteService 端点结果 JSON-safe', () => {
  interface EngineStub {
    testConfig?: (config: unknown) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>
    upsertHost?: (payload: unknown, existing?: string) => unknown
    removeHost?: (alias: string) => boolean
  }

  function setup(engineStub: EngineStub = {}): SshRemoteService {
    const ctx = new Context()
    const runtimeStub = {
      engine: {
        upsertHost: engineStub.upsertHost ?? (() => undefined),
        removeHost: engineStub.removeHost ?? (() => true),
        testConfig: engineStub.testConfig ?? (async () => ({ ok: true, latencyMs: 5 })),
      },
    }
    const service = new SshRemoteService(ctx, runtimeStub as never)
    const hosts: Record<string, SshHostConfig> = {
      vm: {
        id: 'vm',
        host: '192.0.2.1',
        port: 22,
        user: 'root',
        authType: 'password',
        password: 'secret',
      },
    }
    service.setSettings({ get: () => ({ hosts }) } as never)
    return service
  }

  it('testConnection 成功：结果无 error own-key，整体 JSON-safe', async () => {
    const service = setup({ testConfig: async () => ({ ok: true, latencyMs: 123 }) })
    const result = await service.testConnection('vm', { host: '192.0.2.1', user: 'root' })
    expect(result.ok).toBe(true)
    expect(Object.hasOwn(result, 'error')).toBe(false)
    expect(Object.hasOwn(result, 'latencyMs')).toBe(true)
    assertJsonSafe(result)
  })

  it('testConnection 失败：error 字符串保留，整体 JSON-safe', async () => {
    const service = setup({ testConfig: async () => ({ ok: false, latencyMs: 7, error: 'auth failed' }) })
    const result = await service.testConnection('vm', { host: '192.0.2.1', user: 'root' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('auth failed')
    assertJsonSafe(result)
  })

  it('listHosts：脱敏视图 JSON-safe', async () => {
    const service = setup()
    const result = service.listHosts()
    expect(result.secrets.vm).toBe(true)
    expect(Object.hasOwn(result.hosts.vm as Record<string, unknown>, 'password')).toBe(false)
    assertJsonSafe(result)
  })
})
