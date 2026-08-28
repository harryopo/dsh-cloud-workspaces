/**
 * dsh-remote-ide — 占位工作区映射（placeholder workspace router）。
 *
 * 语义复刻自 dsh-ssh/dsh-ssh（MIT，github.com/dsh-ssh/dsh-ssh，src/router.js）：
 * 一个「远程工作区」在本地只是一个占位目录——
 *   占位根   remoteRoot() = <$DSH_HOME || ~/.dsh>/remote
 *   占位路径 = <root>/<hostId>/<base64url(远程绝对路径)>
 *     （恰好两段：hostId + 单段可逆编码）
 * DSH 把占位目录当普通本地工作区（会话 cwd 落在里面）；适配器
 * （fs-ssh / subprocess-ssh）按 cwd 前缀路由到对应主机并把相对路径
 * 重锚定到远程目录。编码可逆（base64url 无 padding 单段）；hostId 校验
 * 拒绝路径穿越；解码必须还原为以 '/' 开头的绝对路径。
 *
 * 纯函数 + 两个窄口 IO（mkdir / 读 manifest）：单测可注入 fsImpl/env。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { posix } from 'node:path'

/** 占位目录内的清单文件名（增强可诊断性：目录名即不依赖也能路由）。 */
export const MANIFEST_NAME = '.dsh-remote-workspace.json'

/** 环境覆盖优先级：DSH_REMOTE_ROOT > $DSH_HOME/remote > ~/.dsh/remote。 */
export function remoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_REMOTE_ROOT !== undefined && env.DSH_REMOTE_ROOT !== '') {
    return path.resolve(String(env.DSH_REMOTE_ROOT))
  }
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME !== ''
    ? String(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'remote')
}

/** hostId 必须是安全的单段目录名：字母数字开头，可含 . _ -，且不为 . / ..。 */
export function isValidHostId(hostId: unknown): hostId is string {
  if (typeof hostId !== 'string' || hostId.length === 0) return false
  if (hostId === '.' || hostId === '..') return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)
}

/** 远程绝对路径 → base64url（无 padding）：单段、不含 '/'。 */
export function encodeRemotePath(remotePath: string): string {
  return Buffer.from(String(remotePath), 'utf8').toString('base64url')
}

/** base64url → 原字符串；非法/非规范输入返回 null（可逆性守卫）。 */
export function decodeRemotePath(encoded: unknown): string | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  let text: string
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  // 拒绝非规范编码（保证 decode → re-encode 往返一致，排除歧义输入）。
  if (encodeRemotePath(text) !== encoded) return null
  return text
}

/** 远程路径 → 本地占位路径。hostId 非法时返回 null。 */
export function mapRemoteToLocal(hostId: string, remotePath: string, env?: NodeJS.ProcessEnv): string | null {
  if (!isValidHostId(hostId)) return null
  return path.join(remoteRoot(env), hostId, encodeRemotePath(remotePath))
}

/**
 * 本地路径 → { hostId, remotePath } | null。要求恰好两段
 * <root>/<hostId>/<encoded>，且 encoded 可解码为 '/' 开头的绝对路径
 * （可逆、无穿越；碰巧同形的真实本地目录不会被误判）。
 */
export function mapLocalToRemote(localPath: unknown, env?: NodeJS.ProcessEnv): { hostId: string; remotePath: string } | null {
  if (typeof localPath !== 'string' || localPath.length === 0) return null
  const root = remoteRoot(env)
  const rel = path.relative(root, localPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep)
  if (segments.length !== 2) return null
  const hostId = segments[0]!
  const encoded = segments[1]!
  if (!isValidHostId(hostId)) return null
  const remotePath = decodeRemotePath(encoded)
  if (remotePath === null) return null
  if (!path.isAbsolute(remotePath) || !remotePath.startsWith('/')) return null
  return { hostId, remotePath }
}

/** 路由入口：会话 cwd 恰为占位路径 → remote；否则 local（绝不抛错）。 */
export function routeByCwd(cwd: unknown, env?: NodeJS.ProcessEnv): { kind: 'local' } | { kind: 'remote'; hostId: string; remoteCwd: string } {
  const mapped = mapLocalToRemote(cwd, env)
  if (mapped === null) return { kind: 'local' }
  return { kind: 'remote', hostId: mapped.hostId, remoteCwd: mapped.remotePath }
}

/**
 * 远程路径解析：相对路径基于 remoteCwd；占位工作区内的绝对路径（Windows
 * 本地形态 <placeholderCwd>/...）重锚定回远程；其余绝对路径按远程绝对路径
 * 处理（词法规范化，折叠 ./../ 与重复斜杠——与官方 dsh-fs-sandbox 的
 * containment 威胁模型一致，不做 symlink 解析）。
 */
export function resolveRemotePath(requestedPath: string, remoteCwd: string, placeholderCwd?: string): string {
  if (!posix.isAbsolute(requestedPath)) {
    if (placeholderCwd !== undefined) {
      const rel = path.relative(placeholderCwd, requestedPath)
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return posix.join(remoteCwd, rel.split(path.sep).join('/'))
      }
    }
    return posix.resolve(remoteCwd, requestedPath)
  }
  if (placeholderCwd !== undefined) {
    const rel = posix.relative(placeholderCwd, requestedPath)
    if (rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)) {
      return posix.join(remoteCwd, rel)
    }
  }
  return posix.normalize(requestedPath)
}

// ------------------------------------------------------------------ manifest

/** 占位清单内容（写入占位目录，供诊断与未来目录名策略演进）。 */
export interface WorkspaceManifest {
  hostId: string
  remotePath: string
  createdAt: string
}

/**
 * 创建占位目录并写入清单（幂等：recursive mkdir + 覆盖写）。
 * hostId/remotePath 非法时抛错；fs 错误原样上抛由调用者包装。
 */
export async function createPlaceholderDir(
  { hostId, remotePath, env, fsImpl = fs, now = new Date() }: {
    hostId: string
    remotePath: string
    env?: NodeJS.ProcessEnv
    fsImpl?: typeof fs
    now?: Date
  },
): Promise<{ localPath: string; hostId: string; remotePath: string }> {
  if (!isValidHostId(hostId)) throw new Error(`invalid host id: ${JSON.stringify(hostId)}`)
  if (typeof remotePath !== 'string' || remotePath === '' || !remotePath.startsWith('/')) {
    throw new Error('remote path must be an absolute POSIX path')
  }
  const localPath = mapRemoteToLocal(hostId, remotePath, env)
  if (localPath === null) throw new Error(`invalid host id: ${JSON.stringify(hostId)}`)
  await fsImpl.promises.mkdir(localPath, { recursive: true })
  const manifest: WorkspaceManifest = {
    hostId,
    remotePath,
    createdAt: now.toISOString(),
  }
  await fsImpl.promises.writeFile(
    path.join(localPath, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
  return { localPath, hostId, remotePath }
}

/** 读取占位清单；缺失/损坏返回 null（目录名编码是兜底路由依据）。 */
export async function readManifest(
  localPath: string,
  fsImpl: typeof fs = fs,
): Promise<WorkspaceManifest | null> {
  try {
    const text = await fsImpl.promises.readFile(path.join(localPath, MANIFEST_NAME), 'utf8')
    const parsed = JSON.parse(text) as Partial<WorkspaceManifest>
    if (typeof parsed.hostId !== 'string' || typeof parsed.remotePath !== 'string') return null
    return { hostId: parsed.hostId, remotePath: parsed.remotePath, createdAt: String(parsed.createdAt ?? '') }
  } catch {
    return null
  }
}

/** 列出全部占位工作区（root 下逐 hostId 目录；目录名解码 + manifest 双源）。 */
export async function listPlaceholders(env?: NodeJS.ProcessEnv, fsImpl: typeof fs = fs): Promise<Array<{ localPath: string; hostId: string; remotePath: string }>> {
  const root = remoteRoot(env)
  const result: Array<{ localPath: string; hostId: string; remotePath: string }> = []
  let hostDirs: string[]
  try {
    hostDirs = await fsImpl.promises.readdir(root)
  } catch {
    return result
  }
  for (const hostId of hostDirs) {
    if (!isValidHostId(hostId)) continue
    const hostDir = path.join(root, hostId)
    let entries: string[]
    try {
      entries = await fsImpl.promises.readdir(hostDir)
    } catch {
      continue
    }
    for (const encoded of entries) {
      const localPath = path.join(hostDir, encoded)
      const remotePath = decodeRemotePath(encoded)
      if (remotePath !== null && path.isAbsolute(remotePath)) {
        result.push({ localPath, hostId, remotePath })
      }
    }
  }
  return result
}
