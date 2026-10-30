import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importLegacyHosts } from '../src/legacy-import'

describe('legacy settings → store import', () => {
  it('imports hosts when store is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
    const settingsFile = join(dir, 'settings.yaml')
    const storeFile = join(dir, 'store.json')
    writeFileSync(settingsFile, [
      'dsh-remote-ide-hosts:',
      '  hosts:',
      '    web-1:',
      '      id: web-1',
      '      name: web-1',
      '      host: 10.0.0.5',
      '      port: 22',
      '      user: root',
      '      authType: key',
      '      privateKeyPath: ~/.ssh/id_ed25519',
    ].join('\n'))
    const result = await importLegacyHosts({ settingsFile, storeFile })
    expect(result.imported).toBe(1)
    const disk = JSON.parse(readFileSync(storeFile, 'utf8')) as { hosts: Array<Record<string, unknown>> }
    expect(disk.hosts[0].host).toBe('10.0.0.5')
    expect((disk.hosts[0].auth as { kind: string }).kind).toBe('key')
  })

  it('is a no-op when the store already has hosts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
    const settingsFile = join(dir, 'settings.yaml')
    const storeFile = join(dir, 'store.json')
    writeFileSync(storeFile, JSON.stringify({
      hosts: [{
        alias: 'keep', host: 'h', port: 22, user: 'u',
        auth: { kind: 'key', keyPath: '' }, proxyJump: [], tags: [], createdAt: 0, updatedAt: 0,
      }],
    }))
    writeFileSync(settingsFile, 'dsh-remote-ide-hosts:\n  hosts: {}\n')
    expect((await importLegacyHosts({ settingsFile, storeFile })).imported).toBe(0)
    const disk = JSON.parse(readFileSync(storeFile, 'utf8')) as { hosts: Array<{ alias: string }> }
    expect(disk.hosts.map((h) => h.alias)).toEqual(['keep'])
  })

  it('missing settings file is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
    const result = await importLegacyHosts({ settingsFile: join(dir, 'nope.yaml'), storeFile: join(dir, 's.json') })
    expect(result).toEqual({ imported: 0, skipped: 0 })
  })
})
