/**
 * Host config store: persists SSH host entries to ~/.dsh/dsh-remote-ide.json
 * (0600), with import from ~/.ssh/config. The browser and agent only ever see
 * the secret-free summary projection.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { HostPayload, ImportResult, SshHostEntry, SshHostSummary } from './protocol'

/** Expand a leading ~ to the user home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Store file location (overridable for tests). */
export function defaultStorePath(): string {
  return join(homedir(), '.dsh', 'dsh-remote-ide.json')
}

/** Parse an OpenSSH config file into raw host blocks (best-effort). */
export interface RawSshHostBlock {
  name: string
  hostName?: string
  port?: number
  user?: string
  identityFile?: string
}

export function parseSshConfig(text: string): RawSshHostBlock[] {
  const blocks: RawSshHostBlock[] = []
  let current: RawSshHostBlock | undefined
  let pendingName: string | undefined
  let inHost = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      if (line.startsWith('!') && inHost && current) {
        // A negation starts a new implicit block? OpenSSH treats ! patterns
        // as part of the same Host stanza; keep the current block.
      }
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim()

    if (key === 'host') {
      // Flush the previous block.
      if (inHost && current && current.hostName) {
        blocks.push(current)
      }
      current = { name: value }
      inHost = true
      pendingName = value
      continue
    }

    if (!inHost || !current) continue

    switch (key) {
      case 'hostname':
        current.hostName = value
        break
      case 'port':
        current.port = Number.parseInt(value, 10) || undefined
        break
      case 'user':
        current.user = value
        break
      case 'identityfile':
        if (current.identityFile === undefined) current.identityFile = value
        break
      default:
        break
    }
  }
  if (inHost && current && current.hostName) {
    blocks.push(current)
  }
  // Blocks that only matched the first token of a multi-pattern Host line
  // (e.g. "Host a b") are dropped by the hostName check — acceptable.
  void pendingName
  return blocks
}

/** Read the ssh config file, returning its text or undefined when missing. */
function readSshConfigFile(): string | undefined {
  const path = join(homedir(), '.ssh', 'config')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The host store. */
export class HostStore {
  private readonly file: string
  private readonly entries = new Map<string, SshHostEntry>()

  /**
   * @param file - store file path (defaults to ~/.dsh/dsh-remote-ide.json).
   */
  constructor(file?: string) {
    this.file = file ?? defaultStorePath()
    this.load()
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { hosts?: SshHostEntry[] }
      for (const entry of parsed.hosts ?? []) {
        if (entry && typeof entry.alias === 'string' && entry.alias !== '') {
          this.entries.set(entry.alias, entry)
        }
      }
    } catch {
      // Missing or corrupt store: start empty.
    }
  }

  private save(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ hosts: [...this.entries.values()] }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // Windows: chmod is a no-op for owner-only semantics.
    }
    renameSync(tmp, this.file)
  }

  /** All entries, sorted by alias. */
  list(): SshHostEntry[] {
    return [...this.entries.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  /** Secret-free projection. */
  summarize(entry: SshHostEntry): SshHostSummary {
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      auth: entry.auth.kind,
      keyReady: entry.auth.kind !== 'key' || existsSync(expandHome(entry.auth.keyPath ?? '')),
      proxyJump: [...entry.proxyJump],
      description: entry.description,
      environment: entry.environment,
      tags: [...entry.tags],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  get(alias: string): SshHostEntry | undefined {
    return this.entries.get(alias)
  }

  /** Create or update an entry (by the payload alias or entry.alias). */
  upsert(payload: HostPayload, existingAlias?: string): SshHostEntry {
    const now = Date.now()
    const alias = (existingAlias ?? payload.alias ?? '').trim()
    if (alias === '') throw new Error('alias is required')
    const prev = this.entries.get(alias)
    const entry: SshHostEntry = {
      alias,
      host: payload.host.trim(),
      port: payload.port ?? prev?.port ?? 22,
      user: payload.user.trim(),
      // On update, an omitted auth keeps the stored secrets.
      auth: payload.auth ?? prev?.auth ?? { kind: 'password', password: '' },
      proxyJump: payload.proxyJump ?? prev?.proxyJump ?? [],
      description: payload.description ?? prev?.description,
      environment: payload.environment ?? prev?.environment,
      tags: payload.tags ?? prev?.tags ?? [],
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    }
    if (entry.host === '') throw new Error('host is required')
    if (entry.user === '') throw new Error('user is required')
    if (entry.auth.kind === 'password' && entry.auth.password === '' && prev === undefined) {
      throw new Error('password is required for password auth')
    }
    if (entry.auth.kind === 'key' && !entry.auth.keyPath) {
      throw new Error('keyPath is required for key auth')
    }
    this.entries.set(alias, entry)
    this.save()
    return entry
  }

  remove(alias: string): boolean {
    const removed = this.entries.delete(alias)
    if (removed) this.save()
    return removed
  }

  /** Import hosts from ~/.ssh/config. Returns counts per outcome. */
  importSshConfig(): ImportResult {
    const text = readSshConfigFile()
    if (text === undefined) {
      return { parsed: 0, added: 0, skipped: 0, skippedNames: [] }
    }
    const blocks = parseSshConfig(text)
    let added = 0
    const skippedNames: string[] = []
    for (const block of blocks) {
      // Multi-pattern Host stanzas are only safe to import when the block
      // resolved to a concrete hostName.
      if (!block.hostName || block.name.includes('*') || block.name.includes('?')) {
        skippedNames.push(block.name)
        continue
      }
      const alias = block.name.trim()
      if (alias === '' || this.entries.has(alias)) {
        skippedNames.push(alias)
        continue
      }
      this.upsert({
        alias,
        host: block.hostName,
        port: block.port,
        user: block.user ?? process.env.USER ?? 'root',
        auth: {
          kind: 'key',
          keyPath: block.identityFile ?? '~/.ssh/id_ed25519',
        },
        tags: ['ssh-config'],
      }, undefined)
      added += 1
    }
    return {
      parsed: blocks.length,
      added,
      skipped: skippedNames.length,
      skippedNames: skippedNames.slice(0, 50),
    }
  }

  /** Resolve a private-key path (expand ~) against the store dir for imports. */
  resolveKeyPath(keyPath: string): string {
    const expanded = expandHome(keyPath)
    return resolve(expanded)
  }
}
