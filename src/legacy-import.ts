/**
 * 一次性迁移：DSH 0.2 删除了 settings 命名空间，旧版把主机元数据写在
 * settings.yaml 的 `dsh-remote-ide-hosts:` 段。首次启动若 0600 store 为空，
 * 把这批主机导入 store（口令一并导入——旧版本 0.1.x 已把口令剥离到 store，
 * 这里只兜底极老的数据）。
 *
 * 约束：只读 settings.yaml，绝不改写用户文件；任何失败都返回 0 导入。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'

export interface LegacyImportOptions {
  /** 0600 store 路径（默认 ~/.dsh/dsh-remote-ide.json）。 */
  storeFile: string
  /** settings.yaml 路径（默认 $DSH_HOME/settings.yaml 或 ~/.dsh/settings.yaml）。 */
  settingsFile?: string
}

export interface LegacyImportResult {
  imported: number
  skipped: number
}

function defaultSettingsFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'settings.yaml')
}

export async function importLegacyHosts(opts: LegacyImportOptions): Promise<LegacyImportResult> {
  try {
    if (existsSync(opts.storeFile)) {
      const raw = JSON.parse(readFileSync(opts.storeFile, 'utf8')) as { hosts?: unknown[] }
      if ((raw.hosts?.length ?? 0) > 0) return { imported: 0, skipped: 0 }
    }
    const settingsFile = opts.settingsFile ?? defaultSettingsFile()
    if (!existsSync(settingsFile)) return { imported: 0, skipped: 0 }
    const doc = load(readFileSync(settingsFile, 'utf8')) as Record<string, unknown> | null
    const section = doc?.['dsh-remote-ide-hosts'] as { hosts?: Record<string, Record<string, unknown>> } | undefined
    const hosts = section?.hosts ?? {}
    const entries = Object.entries(hosts).map(([alias, cfg]) => ({
      alias,
      host: String(cfg.host ?? ''),
      port: Number(cfg.port ?? 22),
      user: String(cfg.user ?? ''),
      auth: cfg.authType === 'password'
        ? { kind: 'password' as const, password: String(cfg.password ?? '') }
        : { kind: 'key' as const, keyPath: String(cfg.privateKeyPath ?? '') },
      proxyJump: Array.isArray(cfg.proxyJump) ? cfg.proxyJump : [],
      ...(typeof (cfg.description ?? cfg.name) === 'string' ? { description: String(cfg.description ?? cfg.name) } : {}),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })).filter((e) => e.host !== '' && e.user !== '')
    if (entries.length === 0) return { imported: 0, skipped: 0 }
    mkdirSync(dirname(opts.storeFile), { recursive: true })
    writeFileSync(opts.storeFile, JSON.stringify({ hosts: entries }, null, 2), { mode: 0o600 })
    return { imported: entries.length, skipped: Object.keys(hosts).length - entries.length }
  } catch {
    return { imported: 0, skipped: 0 }
  }
}
