/**
 * dsh-remote-ide — SSH 主机配置的设置命名空间（settings-card 的数据层）。
 *
 * 官方 settings 机制（dsh-settings）：hosts 用 dict（id → HostConfig）而非
 * 数组——settings 的递归 merge 只对 plain object 深合并、数组整体替换，
 * dict 让「口令留空 = 保持已存」的 write-only 语义成立；删除走单键 unset。
 * 口令用 role('secret')：保存后永不回传（wire 面必须 redactSecrets）。
 *
 * 存储形状：{ hosts: { <id>: SshHostConfig } }
 * 运行时桥接：saveHost/deleteHost 同步 upsert 进 HostStore
 * （~/.dsh/dsh-remote-ide.json，0600），让 ssh_* 工具与占位工作区路由
 * （engine/fs-ssh/subprocess-ssh）立即可用。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { isSafeHostId } from './store'
import type { HostPayload } from './protocol'

/** settingsNamespace 强制 /^[a-z][a-z0-9-]*$/（kebab-case、无点）。 */
export const HOSTS_NAMESPACE = settingsNamespace('dsh-remote-ide-hosts')

/** 一台 SSH 主机（settings 持久化形状；口令 write-only）。 */
export interface SshHostConfig {
  /** 稳定 id（= alias，占位目录路径依赖）。 */
  id: string
  /** 显示名。 */
  name?: string
  /** 主机名或 IP。 */
  host: string
  /** SSH 端口。 */
  port: number
  /** 登录用户。 */
  user: string
  /** 认证方式。 */
  authType: 'key' | 'password'
  /** 私钥路径（key 认证；缺省走 ssh-agent）。 */
  privateKeyPath?: string
  /** 口令（password 认证；role secret，保存后不回传，留空沿用已存值）。 */
  password?: string
  /** 跳板链（ProxyJump）：本地别名按序穿过。 */
  proxyJump?: string[]
  /** 备注。 */
  description?: string
}

/** schemastery schema（client 表单提交的同一契约）。 */
export const HostConfigSchema: z<SshHostConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  host: z.string().required(),
  port: z.number().min(1).max(65535).default(22),
  user: z.string().required(),
  authType: z.union([z.const('key'), z.const('password')]).default('key'),
  privateKeyPath: z.string(),
  password: z.string().role('secret'),
  proxyJump: z.array(z.string()),
  description: z.string(),
})

/** 命名空间文档：hosts dict。 */
export const HostsSettingsSchema: z<{ hosts: Record<string, SshHostConfig> }> = z.object({
  hosts: z.dict(HostConfigSchema).default({}),
})

/** 从 settings 文档取 hosts dict（容错 undefined/畸形；过滤原型污染键）。 */
export function hostsOf(doc: unknown): Record<string, SshHostConfig> {
  const out: Record<string, SshHostConfig> = {}
  if (doc !== null && typeof doc === 'object') {
    const hosts = (doc as { hosts?: unknown }).hosts
    if (hosts !== null && typeof hosts === 'object') {
      for (const [id, cfg] of Object.entries(hosts as Record<string, unknown>)) {
        if (isSafeHostId(id)) out[id] = cfg as SshHostConfig
      }
    }
  }
  return out
}

/** 脱敏视图（wire 面）：口令永不回传。 */
export function redactHosts(hosts: Record<string, SshHostConfig>): Record<string, Omit<SshHostConfig, 'password'>> {
  const out: Record<string, Omit<SshHostConfig, 'password'>> = {}
  for (const [id, cfg] of Object.entries(hosts)) {
    const { password: _password, ...rest } = cfg
    out[id] = rest
  }
  return out
}

/** settings HostConfig → HostStore 条目 payload（桥接给 ssh_* 工具）。
 *
 * 口令安全边界：settings 文档**永不持久化口令**（明文落盘面收敛到 0600 的
 * dsh-remote-ide.json）。因此 settings 视图里 password 字段恒缺省——此时
 * auth 返回 undefined，HostStore.upsert 的 `payload.auth ?? prev?.auth`
 * 语义会保留既有条目的完整 auth（含口令），同步不会清掉密钥。 */
export function toHostPayload(cfg: SshHostConfig): HostPayload {
  const auth = cfg.authType === 'key'
    ? (cfg.privateKeyPath ? { kind: 'key' as const, keyPath: cfg.privateKeyPath } : undefined)
    : (cfg.password ? { kind: 'password' as const, password: cfg.password } : undefined)
  return {
    alias: cfg.id,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    auth,
    proxyJump: cfg.proxyJump,
    description: cfg.description ?? cfg.name,
  }
}

/** 注册命名空间并返回 scope（applies live：改动立即生效）。 */
export function registerHostSettings(ctx: Context): SettingsScope<{ hosts: Record<string, SshHostConfig> }> {
  return ctx.settings.register(HOSTS_NAMESPACE, HostsSettingsSchema, {
    applies: 'live',
    base: { hosts: {} },
  })
}

/** 在具备 settings 的 ctx 上注册（host 半入口，index.ts 的 inject 段调用）。 */
export function installHostSettings(ctx: Context): SettingsScope<{ hosts: Record<string, SshHostConfig> }> {
  const scope = registerHostSettings(ctx)
  ctx.logger?.info('[dsh-remote-ide] settings namespace ' + HOSTS_NAMESPACE + ' registered')
  return scope
}
