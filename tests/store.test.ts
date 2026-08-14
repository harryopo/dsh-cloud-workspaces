/**
 * HostStore unit tests: CRUD, persistence, ssh-config parsing, secret-free
 * summaries. Uses a temp store file so the real ~/.dsh store is untouched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore, parseSshConfig } from '../src/store'

const dirs: string[] = []

function makeStore(): { store: HostStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-ide-test-'))
  dirs.push(dir)
  return { store: new HostStore(join(dir, 'hosts.json')), dir }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('HostStore CRUD', () => {
  it('upserts and lists entries sorted by alias', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'beta', host: '10.0.0.2', user: 'root', auth: { kind: 'password', password: 's3cret' } })
    store.upsert({ alias: 'alpha', host: 'example.com', port: 2222, user: 'dev', auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519' }, tags: ['prod'] })

    const list = store.list()
    expect(list.map(e => e.alias)).toEqual(['alpha', 'beta'])
    expect(list[0]!.port).toBe(2222)
  })

  it('keeps stored secrets on update when auth is omitted', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'h.example.com', user: 'u', auth: { kind: 'password', password: 'secret' } })
    store.upsert({ alias: 'h', host: 'h2.example.com', user: 'u2' })
    const entry = store.get('h')!
    expect(entry.host).toBe('h2.example.com')
    expect(entry.auth).toEqual({ kind: 'password', password: 'secret' })
  })

  it('rejects invalid entries', () => {
    const { store } = makeStore()
    expect(() => store.upsert({ alias: '', host: 'x', user: 'u' })).toThrow('alias')
    expect(() => store.upsert({ alias: 'a', host: '', user: 'u' })).toThrow('host')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: '' })).toThrow('user')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: 'u', auth: { kind: 'password', password: '' } })).toThrow('password')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: 'u', auth: { kind: 'key' } })).toThrow('keyPath')
  })

  it('removes entries', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'p' } })
    expect(store.remove('h')).toBe(true)
    expect(store.remove('h')).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('persists to disk (0600 semantics on POSIX)', () => {
    const { store, dir } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'p' } })
    const raw = readFileSync(join(dir, 'hosts.json'), 'utf8')
    const parsed = JSON.parse(raw) as { hosts: Array<{ alias: string }> }
    expect(parsed.hosts).toHaveLength(1)
    expect(parsed.hosts[0]!.alias).toBe('h')

    // Reopen: entries survive.
    const reopened = new HostStore(join(dir, 'hosts.json'))
    expect(reopened.list()).toHaveLength(1)
  })
})

describe('parseSshConfig', () => {
  it('parses host blocks with hostname/port/user/identity', () => {
    const text = [
      'Host prod',
      '  HostName 10.0.0.1',
      '  Port 2222',
      '  User deploy',
      '  IdentityFile ~/.ssh/prod_key',
      '',
      'Host dev',
      '  HostName dev.example.com',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ name: 'prod', hostName: '10.0.0.1', port: 2222, user: 'deploy', identityFile: '~/.ssh/prod_key' })
    expect(blocks[1]).toMatchObject({ name: 'dev', hostName: 'dev.example.com' })
  })

  it('skips blocks without a concrete hostname', () => {
    const text = [
      'Host *',
      '  User generic',
      '',
      'Host special',
      '  HostName special.example.com',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe('special')
  })

  it('tolerates comments, blanks and unknown keys', () => {
    const text = [
      '# comment',
      '',
      'Host x',
      '  HostName x.example.com',
      '  Compression yes',
      '  ServerAliveInterval 30',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.hostName).toBe('x.example.com')
  })
})

describe('HostStore summaries', () => {
  it('never leaks secrets to the summary', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'top-secret' } })
    const summary = store.summarize(store.get('h')!)
    expect(JSON.stringify(summary)).not.toContain('top-secret')
    expect(summary.auth).toBe('password')
  })
})
