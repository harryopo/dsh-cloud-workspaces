/**
 * dsh-remote-ide — SSH 远程文件系统能力缝（ctx.fs 的 SSH 后端）。
 *
 * 完全复刻官方 fs-e2b 的 adapter 范式（.research/dsh-source/deepseek-harness-master/
 * packages/e2b/fs-e2b/src/index.ts）：一个 FileSystem 后端共享 ctx.ssh 持有的远程
 * 世界，每次操作 await getConnection() 拿稳定句柄，仅把「e2b SDK 调用」换成现有
 * SshEngine 的 SFTP（stat/lstat/readdir/readFile/writeFile/rename...）+ exec
 * （realpath/chmod/ln 守卫）。SSH 是 bare backend：不施加 sandbox 围栏，
 * writeText/editText 的 sandboxPolicy 参数按契约接收但忽略。
 *
 * 与 fs-e2b 的差异（SSH 环境适配）：
 * 1. resolve 基准目录用连接句柄的 home（动态），而非固定 cwd 配置。
 * 2. canonical path 用 exec `realpath -mz | base64 -w0`（与 e2b 相同）。
 * 3. writeAtomic 的 createIfAbsent 守卫仍用 `ln -T`（GNU coreutils，Linux 服务器）；
 *    提交后硬链接在 staging 目录仍占一个计数，需先 unlink 再 rmdir（e2b 的
 *    remove 是递归的，SSH 的 rmdir 只删空目录，故补一步）。
 * 4. readBytes 双保险用 SFTP 整读 + 事后 size 校验（e2b 用流式中断；SSH 的
 *    readFile 一次性入内存，stat 预检已挡 at-rest 超限，post-stat grower 事后拒绝）。
 */

import { randomUUID, createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Stats } from 'ssh2'
import type { SshConnection } from './ssh-service'
import { resolveRemotePath, routeByCwd } from './workspace'

/** 二进制采样窗口：头部出现 NUL 即判定为二进制文件。 */
const BINARY_SAMPLE_BYTES = 8192
/** base64 严格校验（realpath 传输用 -w0 无换行）。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** 中止预检：signal 已中止则抛 FS_ABORTED。 */
function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

/** LF 归一化（diff 基准统一为 \n）。 */
function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

/** 采样前 4096 字符判断文件是否 CRLF 为主。 */
function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

/** 写入前按原文件的换行风格恢复。 */
function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

/** 解码 UTF-8 文本：头部 NUL → FS_NOT_TEXT，非法 UTF-8 → FS_NOT_TEXT。 */
function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/** 解码 exec 返回的 base64 + NUL 帧（realpath -mz | base64 -w0）。 */
function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-ssh: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded
    || framed.length < 2
    || framed.at(-1) !== 0
    || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-ssh: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error: unknown) {
    throw new Error('fs-ssh: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-ssh: canonical path is not absolute')
  return path
}

/** POSIX 单引号转义（供 exec 命令内嵌路径）。 */
function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Stats → FsInfo 的三态类型。 */
function entryType(entry: Stats): FsInfo['type'] {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  return 'other'
}

/**
 * 版本令牌：对「路径 + 类型 + 是否 symlink + 大小 + mode + mtime」哈希。
 * 任何变更都产生新版本，供 write/edit 的 stale 守卫比对。
 */
function entryVersion(path: string, entry: Stats, symlink = false): FsVersion {
  const facts = JSON.stringify([
    path,
    entryType(entry),
    symlink ? 'symlink' : null,
    entry.size,
    entry.mode,
    entry.mtime,
  ])
  return FsVersion(`ssh:${createHash('sha256').update(facts).digest('hex')}`)
}

/** SFTP 错误 → FsError（唯一错误出口，保证 FsErrorCode 全映射）。 */
function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const message = String((error as { message?: unknown })?.message ?? error)
  if (/no such file|ENOENT|not found/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|EACCES|EPERM|operation not permitted/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

/** 字面量编辑：非空 oldString / 精确单匹配（或 replaceAll 全量）。 */
function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** SFTP 回调 → Promise（带值操作：stat/lstat/readdir/readFile）。 */
function sftpCall<T>(
  invoke: (callback: (error: Error | null | undefined, value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((error, value) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    })
  })
}

/** SFTP 回调 → Promise（void 操作：mkdir/rmdir/unlink/rename/chmod/writeFile）。 */
function sftpCallVoid(
  invoke: (callback: (error: Error | null | undefined) => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    invoke((error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

/** SFTPWrapper 的 OpenSSH 扩展形状（@types/ssh2 未声明 ext_openssh_rename）。 */
type SftpWithOpensshExtensions = import('ssh2').SFTPWrapper & {
  ext_openssh_rename?: (from: string, to: string, callback: (error: Error | null | undefined) => void) => void
}

const POSIX_RENAME_UNSUPPORTED = 'posix-rename@openssh.com unsupported'

/** posix-rename@openssh.com 原子替换（覆盖已存在目标；普通 SFTP RENAME 做不到）。 */
async function posixRename(sftp: import('ssh2').SFTPWrapper, from: string, to: string): Promise<void> {
  const extRename = (sftp as SftpWithOpensshExtensions).ext_openssh_rename
  if (extRename === undefined) throw new Error(POSIX_RENAME_UNSUPPORTED)
  await sftpCallVoid((callback) => extRename.call(sftp, from, to, callback))
}

/** 扩展缺失（ssh2 同步 throw 或方法不存在）才降级；远端真实错误原样上抛。 */
function isPosixRenameUnsupported(error: unknown): boolean {
  return error instanceof Error
    && (error.message === POSIX_RENAME_UNSUPPORTED
      || error.message.includes('does not support this extended request'))
}

/** SSH 远程文件系统后端：共享 ctx.ssh 的连接，适配 dsh-fs 能力缝。 */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh']

  /** 每个 targetKey 的尾 promise：串行化读→守→写窗口，并发写确定有序。 */
  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * 会话锚定的主机（占位工作区路由）。第一个带占位 cwd 的 resolve/lstat
   * 把整个 fs 实例锚到该主机——isolate realm 下每会话一个实例，此后所有
   * 操作（含 readText/writeText 等只拿 FsTarget 的方法）都落在该主机上。
   */
  private anchor: string | undefined

  /**
   * 取连接句柄（带占位工作区路由）：cwd 落在 ~/.dsh/remote/<hostId>/… 下时
   * 连接该主机；否则沿用已锚定主机或共享激活连接。锚定变更时同步激活
   * runtime 连接——ssh_* 工具的无别名回退读 activeAlias（全局单目标），
   * 不激活会让同一占位会话里的 ssh_exec 报 "no alias given"，而 fs 工具
   * 明明已在该主机上工作。
   */
  private async connectionFor(cwd?: string): Promise<SshConnection> {
    const route = routeByCwd(cwd)
    if (route.kind === 'remote') {
      await this.activateAnchor(route.hostId)
      return this.ctx.ssh.getConnectionFor(route.hostId)
    }
    if (this.anchor !== undefined) return this.ctx.ssh.getConnectionFor(this.anchor)
    return this.ctx.ssh.getConnection()
  }

  /** 首次锚定某主机时把 runtime 的激活连接也切过去（幂等，仅锚定变更时）。 */
  private async activateAnchor(hostId: string): Promise<void> {
    if (this.anchor === hostId) return
    this.anchor = hostId
    await this.ctx.ssh.connect(hostId)
  }

  /**
   * 相对路径的解析基准：占位 cwd → 该主机 + 远程工作区路径（绝对占位路径
   * 由 resolveRemotePath 重锚定）；普通远程 cwd → 原样作基准（旧行为）；
   * 未传 → 该主机 home。
   */
  private async sessionFor(cwd?: string): Promise<{
    connection: SshConnection
    remoteCwd: string
    placeholderCwd: string | undefined
  }> {
    const route = routeByCwd(cwd)
    if (route.kind === 'remote') {
      await this.activateAnchor(route.hostId)
      const connection = await this.ctx.ssh.getConnectionFor(route.hostId)
      return { connection, remoteCwd: route.remoteCwd, placeholderCwd: cwd }
    }
    const connection = await this.connectionFor()
    return { connection, remoteCwd: cwd ?? connection.home ?? '/', placeholderCwd: undefined }
  }

  // --------------------------------------------------------------- resolve

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const fallback = posix.resolve(opts?.cwd ?? '', path)
    try {
      const session = await this.sessionFor(opts?.cwd)
      const displayPath = resolveRemotePath(path, session.remoteCwd, session.placeholderCwd)
      const targetKey = await this.canonicalPath(displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', fallback, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) {
      throw new Error(`fs-ssh: expected an absolute process path: ${JSON.stringify(path)}`)
    }
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  // ------------------------------------------------------------ metadata

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(String(target.targetKey), entry),
      type: entryType(entry),
      ...(entry.isFile() ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const session = await this.sessionFor(opts?.cwd)
    const displayPath = resolveRemotePath(path, session.remoteCwd, session.placeholderCwd)
    const connection = session.connection
    try {
      const sftp = await connection.getSftp()
      const entry = await sftpCall<Stats>((cb) => sftp.lstat(displayPath, cb))
      assertNotAborted(signal, 'lstat')
      const symlink = entry.isSymbolicLink()
      return {
        version: entryVersion(displayPath, entry, symlink),
        type: symlink ? 'symlink' : entryType(entry),
        ...(entry.isFile() ? { size: entry.size } : {}),
      }
    } catch (error: unknown) {
      const message = String((error as { message?: unknown })?.message ?? error)
      if (/no such file|ENOENT/i.test(message)) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  // ----------------------------------------------------------------- read

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal)
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const bytes = await sftpCall<Buffer>((cb) => sftp.readFile(String(target.targetKey), cb))
      assertNotAborted(signal, 'read')
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const buffer = await sftpCall<Buffer>((cb) => sftp.readFile(String(target.targetKey), cb))
      assertNotAborted(signal, 'read')
      // stat 预检覆盖 at-rest 场景；此双保险挡住 stat 后增长的文件。
      if (buffer.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal)
    const sftp = await (await this.connectionFor()).getSftp()
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const stream = sftp.createReadStream(String(target.targetKey))
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          for await (const chunk of stream as AsyncIterable<Uint8Array>) {
            assertNotAborted(signal, 'read')
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = chunk.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(chunk, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          if (!completed) {
            try {
              stream.destroy()
            } catch (_streamCancellationFailure) {
              // 主读取结果拥有操作语义；提前停止后的销毁尽力而为。
            }
          }
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const listed = await sftpCall<import('ssh2').FileEntryWithStats[]>((cb) => sftp.readdir(String(target.targetKey), cb))
      const entries: FsDirEntry[] = []
      for (const entry of listed) {
        const displayPath = posix.join(target.displayPath, entry.filename)
        const isSymlink = (entry.attrs.mode & 0o170000) === 0o120000
        let canonical: string
        let resolved: Stats | undefined
        if (isSymlink) {
          // symlink 跟随：realpath 解析目标身份，再探测目标类型。
          canonical = await this.canonicalPath(displayPath, signal)
          resolved = await this.probe(canonical, displayPath, signal)
        } else {
          canonical = posix.join(String(target.targetKey), entry.filename)
          resolved = entry.attrs
        }
        entries.push({
          name: entry.filename,
          type: resolved === undefined ? 'other' : entryType(resolved),
          target: { targetKey: FsTargetKey(canonical), displayPath },
          ...(resolved !== undefined ? { version: entryVersion(canonical, resolved, isSymlink) } : {}),
          ...(resolved?.isFile() === true ? { size: resolved.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  // ---------------------------------------------------------------- write

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  // ------------------------------------------------------------- internal

  /** 串行化每个 targetKey 的写窗口（FIFO）。 */
  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  /** 远程 realpath（-m 容忍不存在；base64 传输避免 shell 特殊字符歧义）。 */
  private async canonicalPath(path: string, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, 'resolve')
    const connection = await this.connectionFor()
    const result = await connection.exec(`set -o pipefail; realpath -mz -- ${quotePosixArg(path)} | base64 -w0`)
    assertNotAborted(signal, 'resolve')
    if (!result.success) {
      throw new Error(result.stderr || result.stdout || `realpath failed with exit code ${result.exitCode}`)
    }
    return decodeCanonicalPath(result.stdout.replace(/\s+$/g, ''))
  }

  /** SFTP stat 探测：ENOENT → undefined，其余错误映射为 FsError。 */
  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<Stats | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const entry = await sftpCall<Stats>((cb) => sftp.stat(path, cb))
      assertNotAborted(signal, 'stat')
      return entry
    } catch (error: unknown) {
      const message = String((error as { message?: unknown })?.message ?? error)
      if (/no such file|ENOENT/i.test(message)) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  /** 常规文件预检：不存在 → FS_NOT_FOUND，非文件 → FS_NOT_REGULAR_FILE。 */
  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  /** 守卫意图校验：createIfAbsent 拒绝已存在；replaceIfVersion 拒绝缺失/版本不符。 */
  private checkWriteIntent(existing: Stats | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(String(target.targetKey), existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  /** 写入前的差异基准读取（LF 归一化；二进制旧文件 → null）。 */
  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const bytes = await sftpCall<Buffer>((cb) => sftp.readFile(String(target.targetKey), cb))
      assertNotAborted(signal, 'read')
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  /** 编辑基准读取（保持原始字节文本，不归一化）。 */
  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const sftp = await (await this.connectionFor()).getSftp()
      const bytes = await sftpCall<Buffer>((cb) => sftp.readFile(String(target.targetKey), cb))
      assertNotAborted(signal, 'edit')
      return decodeText(bytes, target.displayPath, bytes.length)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  /**
   * 原子发布：私有 staging 目录（chmod 700）→ 写 content → chmod 目标 mode →
   * createIfAbsent 用 `ln -T` 守卫创建（并发下后到者报 FS_NOT_OBSERVED）/ 否则 rename 提交。
   * 提交后 staging 侧硬链接计数 +1，先 unlink 再 rmdir 清空 staging。
   */
  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: Stats | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    const connection = await this.connectionFor()
    const sftp = await connection.getSftp()
    const targetPath = String(target.targetKey)
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      await sftpCallVoid((cb) => sftp.mkdir(stagingDirectory, cb))
      stagingDirectoryCreated = true
      const chmodStaging = await connection.exec(`chmod 700 -- ${quotePosixArg(stagingDirectory)}`)
      if (!chmodStaging.success) {
        throw new Error(chmodStaging.stderr || `chmod failed with exit code ${chmodStaging.exitCode}`)
      }
      assertNotAborted(signal, 'write')
      await sftpCallVoid((cb) => sftp.writeFile(temporary, Buffer.from(content, 'utf8'), cb))
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      const chmodContent = await connection.exec(`chmod ${mode.toString(8)} -- ${quotePosixArg(temporary)}`)
      if (!chmodContent.success) {
        throw new Error(chmodContent.stderr || `chmod failed with exit code ${chmodContent.exitCode}`)
      }
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        const targetArg = quotePosixArg(targetPath)
        const publication = await connection.exec(
          `if ln -T -- ${quotePosixArg(temporary)} ${targetArg}; then printf created; `
          + `elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`,
        )
        if (publication.stdout === 'exists') {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            'FS_NOT_OBSERVED',
          )
        }
        if (publication.stdout !== 'created') {
          throw new Error(publication.stderr || publication.stdout || 'guarded create returned an invalid publication result')
        }
        await sftpCallVoid((cb) => sftp.unlink(temporary, cb))
      } else {
        // SFTP RENAME 语义不覆盖已存在目标（OpenSSH 对存在目标返回
        // SSH_FX_FAILURE）；替换已存在文件必须走 posix-rename@openssh.com
        // 扩展（原子覆盖）。扩展不可用的服务器降级 unlink + rename（极小
        // 非原子窗口）。
        try {
          await posixRename(sftp, temporary, targetPath)
        } catch (error) {
          if (isPosixRenameUnsupported(error)) {
            try {
              await sftpCallVoid((cb) => sftp.unlink(targetPath, cb))
            } catch (_targetAlreadyAbsent) {
              // create-race：目标本就不存在，普通 rename 照常生效。
            }
            await sftpCallVoid((cb) => sftp.rename(temporary, targetPath, cb))
          } else {
            throw error
          }
        }
      }
      try {
        await sftpCallVoid((cb) => sftp.rmdir(stagingDirectory, cb))
      } catch (_committedStagingCleanupFailure) {
        // target 已提交；空目录清理失败不影响写入结果。
      }
      const committed = await sftpCall<Stats>((cb) => sftp.stat(targetPath, cb))
      return entryVersion(targetPath, committed)
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        try {
          await sftpCallVoid((cb) => sftp.unlink(temporary, cb))
        } catch (_stagingFileAlreadyAbsent) {
          // 尽力清理：原失败拥有操作语义。
        }
        try {
          await sftpCallVoid((cb) => sftp.rmdir(stagingDirectory, cb))
        } catch (_stagingDirectoryAlreadyAbsent) {
          // 尽力清理：原失败拥有操作语义。
        }
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

export default SshFileSystem
