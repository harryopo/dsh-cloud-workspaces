/**
 * workspace.ts 单测：占位工作区映射的纯函数 + 注入 fs 的窄口 IO。
 * 语义对齐 dsh-ssh 的 router.js（可逆编码 / 穿越拒绝 / 往返一致性）。
 */

import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  createPlaceholderDir,
  decodeRemotePath,
  encodeRemotePath,
  isValidHostId,
  listPlaceholders,
  MANIFEST_NAME,
  mapLocalToRemote,
  mapRemoteToLocal,
  readManifest,
  remoteRoot,
  resolveRemotePath,
  routeByCwd,
} from '../src/workspace'

const ENV = { DSH_REMOTE_ROOT: path.resolve('/test-root/remote') } as NodeJS.ProcessEnv

describe('remoteRoot', () => {
  it('honors DSH_REMOTE_ROOT over DSH_HOME and default', () => {
    expect(remoteRoot(ENV)).toBe(path.resolve('/test-root/remote'))
    expect(remoteRoot({ DSH_HOME: '/dsh' } as NodeJS.ProcessEnv)).toBe(path.join('/dsh', 'remote'))
    expect(remoteRoot({} as NodeJS.ProcessEnv)).toBe(path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'remote'))
  })
})

describe('hostId validation', () => {
  it('accepts safe single-segment names', () => {
    expect(isValidHostId('web-1')).toBe(true)
    expect(isValidHostId('a.b_c-d')).toBe(true)
    expect(isValidHostId('A1')).toBe(true)
  })
  it('rejects traversal and unsafe names', () => {
    expect(isValidHostId('')).toBe(false)
    expect(isValidHostId('.')).toBe(false)
    expect(isValidHostId('..')).toBe(false)
    expect(isValidHostId('-x')).toBe(false)
    expect(isValidHostId('a/b')).toBe(false)
    expect(isValidHostId('a\\b')).toBe(false)
    expect(isValidHostId(undefined)).toBe(false)
    expect(isValidHostId(42)).toBe(false)
  })
})

describe('reversible path encoding', () => {
  it('round-trips absolute remote paths', () => {
    const remote = '/home/user/my project/中文 目录'
    const encoded = encodeRemotePath(remote)
    expect(encoded).not.toContain('/')
    expect(decodeRemotePath(encoded)).toBe(remote)
  })

  it('rejects non-canonical or malformed input', () => {
    expect(decodeRemotePath('')).toBeNull()
    expect(decodeRemotePath('a/b')).toBeNull()
    expect(decodeRemotePath('not base64!')).toBeNull()
    // double-encoded padding form is non-canonical
    const padded = Buffer.from('/x', 'utf8').toString('base64') // has '='
    expect(decodeRemotePath(padded)).toBeNull()
  })
})

describe('placeholder mapping', () => {
  it('maps remote → local → remote consistently', () => {
    const local = mapRemoteToLocal('web-1', '/home/user/project', ENV)
    expect(local).toBe(path.join(path.resolve('/test-root/remote'), 'web-1', encodeRemotePath('/home/user/project')))
    expect(mapLocalToRemote(local, ENV)).toEqual({ hostId: 'web-1', remotePath: '/home/user/project' })
  })

  it('rejects invalid host ids and non-absolute remote paths', () => {
    expect(mapRemoteToLocal('../evil', '/x', ENV)).toBeNull()
    expect(mapLocalToRemote(path.join(path.resolve('/test-root/remote'), 'web-1', 'extra', 'seg'), ENV)).toBeNull()
  })

  it('never misdetects ordinary local paths', () => {
    expect(mapLocalToRemote('C:\\Users\\someone\\project', ENV)).toBeNull()
    expect(mapLocalToRemote(path.resolve('/test-root/remote'), ENV)).toBeNull()
    expect(routeByCwd('C:\\somewhere\\else', ENV)).toEqual({ kind: 'local' })
  })

  it('routeByCwd returns the host and remote cwd for placeholder paths', () => {
    const local = mapRemoteToLocal('db-1', '/var/lib/app', ENV)
    expect(routeByCwd(local, ENV)).toEqual({ kind: 'remote', hostId: 'db-1', remoteCwd: '/var/lib/app' })
  })
})

describe('resolveRemotePath', () => {
  const remoteCwd = '/srv/app'
  const placeholderCwd = mapRemoteToLocal('h', remoteCwd, ENV)!

  it('resolves relative paths against the remote cwd', () => {
    expect(resolveRemotePath('src/main.ts', remoteCwd)).toBe('/srv/app/src/main.ts')
    expect(resolveRemotePath('./a/../b', remoteCwd)).toBe('/srv/app/b')
  })

  it('re-anchors placeholder-absolute paths back to the remote tree', () => {
    const inside = path.join(placeholderCwd, 'sub', 'file.txt')
    expect(resolveRemotePath(inside, remoteCwd, placeholderCwd)).toBe('/srv/app/sub/file.txt')
  })

  it('normalizes plain remote absolute paths', () => {
    expect(resolveRemotePath('/data/x/../y//z', remoteCwd, placeholderCwd)).toBe('/data/y/z')
  })
})

describe('placeholder IO', () => {
  it('creates the placeholder directory with a manifest (in-memory fs)', async () => {
    const files = new Map<string, string>()
    const fsImpl = {
      promises: {
        mkdir: async (p: string) => { files.set(p, files.get(p) ?? '') },
        writeFile: async (p: string, data: string) => { files.set(p, data) },
        readFile: async (p: string) => {
          const hit = files.get(p)
          if (hit === undefined) throw new Error('ENOENT')
          return hit
        },
        readdir: async (p: string) => [...files.keys()].filter(k => path.dirname(k) === p).map(k => path.basename(k)),
      },
    } as unknown as typeof import('node:fs')
    const created = await createPlaceholderDir({ hostId: 'web-1', remotePath: '/opt/app', env: ENV, fsImpl })
    expect(created.localPath).toBe(mapRemoteToLocal('web-1', '/opt/app', ENV))
    const manifest = await readManifest(created.localPath, fsImpl)
    expect(manifest).toMatchObject({ hostId: 'web-1', remotePath: '/opt/app' })
    expect(manifest?.createdAt).toBeTruthy()
    expect(files.get(path.join(created.localPath, MANIFEST_NAME))).toContain('"hostId": "web-1"')
  })

  it('refuses invalid host ids and relative remote paths', async () => {
    await expect(createPlaceholderDir({ hostId: 'x/y', remotePath: '/a', env: ENV })).rejects.toThrow(/invalid host id/)
    await expect(createPlaceholderDir({ hostId: 'ok', remotePath: 'relative', env: ENV })).rejects.toThrow(/absolute/)
  })

  it('readManifest returns null for missing or corrupt manifests', async () => {
    const fsImpl = {
      promises: { readFile: async () => { throw new Error('ENOENT') } },
    } as unknown as typeof import('node:fs')
    expect(await readManifest('/anywhere', fsImpl)).toBeNull()
    const broken = {
      promises: { readFile: async () => 'not json' },
    } as unknown as typeof import('node:fs')
    expect(await readManifest('/anywhere', broken)).toBeNull()
  })

  it('listPlaceholders decodes existing placeholder directories', async () => {
    const a = mapRemoteToLocal('a-host', '/home/x', ENV)!
    const b = mapRemoteToLocal('b-host', '/var/y', ENV)!
    const root = path.resolve('/test-root/remote')
    const fsImpl = {
      promises: {
        readdir: async (p: string) => {
          // Two levels: root → hostId dirs, host dir → encoded dirs.
          if (p === root) return ['a-host', 'b-host']
          if (p === path.join(root, 'a-host')) return [path.basename(a)]
          if (p === path.join(root, 'b-host')) return [path.basename(b)]
          return []
        },
      },
    } as unknown as typeof import('node:fs')
    const listed = await listPlaceholders(ENV, fsImpl)
    expect(listed).toContainEqual({ localPath: a, hostId: 'a-host', remotePath: '/home/x' })
    expect(listed).toContainEqual({ localPath: b, hostId: 'b-host', remotePath: '/var/y' })
  })

  it('listPlaceholders swallows a missing root', async () => {
    const fsImpl = {
      promises: { readdir: async () => { throw new Error('ENOENT') } },
    } as unknown as typeof import('node:fs')
    expect(await listPlaceholders(ENV, fsImpl)).toEqual([])
  })
})
