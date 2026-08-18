/**
 * dsh-remote-ide — SSH subprocess adapter（`ctx.subprocess` 的远程实现）。
 *
 * 逐行对照官方 E2B 适配器（.research/dsh-source/deepseek-harness-master/
 * packages/e2b/subprocess-e2b/src/），把传输层从 E2B SDK 换成 SSH：
 *
 * | E2B SDK 语义                    | SSH 传输语义                                             |
 * | ------------------------------- | -------------------------------------------------------- |
 * | sandbox.commands.run(流式)      | SshExecChannel（ssh2 Channel 实时 Buffer 流，stderr 分离）|
 * | 远端 node base64 输出编码器     | 无（SSH 通道二进制安全，输出直接透传）                    |
 * | status 文件（退出码发布）       | 无（channel close 事件直接携带 exit-status / signal）     |
 * | 远端 spill 文件 + SFTP 读回     | 本地临时 spill 文件（host 侧已收到全部字节）              |
 * | sandbox.pty.create              | SshEngine.openShell（真实 PTY 登录 shell + exec 注入）    |
 * | e2bControlEnvs                  | 无（SSH exec 的 env 选项受 AcceptEnv 限制，wrapper 内 env -i 重放）|
 *
 * 与 e2b 的关键差异（SSH 通道特性带来的简化）：
 * 1. 无 base64 编码器 —— stderr 走 ssh2 的 extended-data 通道，与 stdout 天然分离。
 * 2. 无 exit-code 文件 —— channel close 的 (code, signal) 即权威退出事实。
 * 3. wrapper 只用 bash/coreutils（set -o pipefail / mapfile / setsid / ps），
 *    不依赖远端 node —— 与 e2b 的 node 编码器不同。
 * 4. 所有远程控制命令统一 `exec bash -c '<script>'` 包裹，登录 shell 是
 *    dash 也能正确执行（e2b 无此问题，因 SDK 命令由沙箱 bash 解释）。
 * 5. 环境 scrub 语义：普通进程经 wrapper 的 `env -i -- "${dsh_env[@]}"`
 *    重放 scrubbed 远程环境（与 e2b 一致）；PTY 终端接受登录 shell 环境
 *    （用户自己的服务器 shell 本就可见自己的环境），spec.env 显式覆盖
 *    经注入命令前缀生效，undefined tombstone 不适用（文档注明）。
 */

import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { SENSITIVE_ENV_PATTERN, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SshConnection } from './ssh-service'
import type { SshExecChannel, ShellSession } from './engine'

/** Node 定时器最大延迟（毫秒）；`@deepseek-ai/dsh-timeout` 的 MAX_TIMER_DELAY_MS 在 dsh-subprocess 未发布时由本地常量承担。 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** 远程 wrapper 状态目录根（/tmp 下按 uuid 隔离，避免依赖远程 $HOME 的解析时序）。 */
const STATE_ROOT = '/tmp'

// ---------------------------------------------------------------- utilities

/** Normalize an unknown rejection into an Error. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** POSIX single-quote escaping for remote shell interpolation. */
function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Wrap one remote script so it always runs under bash regardless of the user's
 * login shell (OpenSSH execs through `$SHELL -c`, which may be dash).
 */
function bashCommand(script: string): string {
  return `exec bash -c ${quoteShellArg(script)}`
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
}

/** Resolve after one duration. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait one poll interval or until the signal aborts.
 * @returns `true` after a full tick, `false` when aborted first.
 */
function waitTick(pollMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, pollMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const WAIT_ABORTED = Symbol('wait aborted')

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof WAIT_ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(WAIT_ABORTED)
  return new Promise<T | typeof WAIT_ABORTED>((resolve) => {
    const onAbort = (): void => { cleanup(); resolve(WAIT_ABORTED) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void promise.then((value) => { cleanup(); resolve(value) })
  })
}

/**
 * Signal remote process groups, tolerating the shared teardown outcome: a
 * nonzero `kill` (groups already gone). The liveness probe, not the signal
 * command, proves cleanup.
 */
async function signalRemoteGroups(connection: SshConnection, groups: readonly number[], signal: 'TERM' | 'KILL'): Promise<void> {
  try {
    await connection.exec(
      bashCommand(`kill -${signal} -- ${groups.map(group => `-${group}`).join(' ')}`),
      { timeoutMs: 10_000 },
    )
  } catch {
    // A vanished group or a broken control connection both settle here; the
    // following liveness polling remains authoritative.
  }
}

// ---------------------------------------------------------------- environment

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function remoteEnvironmentEntries(raw: string): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = []
  for (const entry of raw.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    entries.push([entry.slice(0, separator), entry.slice(separator + 1)])
  }
  return entries
}

/**
 * Read the remote environment through ASCII base64 so SSH channel chunking
 * cannot corrupt UTF-8. The login home comes from getent (exec channels often
 * lack $HOME); `env -0` snapshots the complete NUL-delimited environment.
 */
async function readRemoteEnvironment(connection: SshConnection, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const script = [
    'set -o pipefail',
    'dsh_ssh_passwd="$(getent passwd "$(id -u)")"',
    'dsh_ssh_home="$(printf \'%s\' "$dsh_ssh_passwd" | cut -d: -f6)"',
    'test -n "$dsh_ssh_home" -a -d "$dsh_ssh_home"',
    "printf '%s' \"$dsh_ssh_home\" | base64 -w 0",
    "printf '\\n'",
    'env -0 | base64 -w 0',
  ].join('; ')
  const result = await connection.exec(bashCommand(script), { timeoutMs: 10_000 })
  signal?.throwIfAborted()
  const lines = result.stdout.trim().split('\n')
  if (lines.length !== 2 || !lines.every(line => BASE64.test(line))) {
    throw new Error('subprocess-ssh: remote environment transport returned invalid base64')
  }
  const [encodedHome, encodedEnvironment] = lines as [string, string]
  let home: string
  let raw: string
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    home = decoder.decode(Buffer.from(encodedHome, 'base64'))
    raw = decoder.decode(Buffer.from(encodedEnvironment, 'base64'))
  } catch (error) {
    throw new Error('subprocess-ssh: remote environment is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(home) || home.includes('\0')) {
    throw new Error(`subprocess-ssh: remote login home is invalid: ${JSON.stringify(home)}`)
  }
  const environment = new Map(remoteEnvironmentEntries(raw))
  environment.set('HOME', home)
  return [...environment].map(([name, value]) => `${name}=${value}\0`).join('')
}

/** Remove harness-private and credential-shaped names from a NUL-delimited remote environment. */
function scrubRemoteEnvironment(raw: string): Map<string, string> {
  const environment = new Map<string, string>()
  for (const [name, value] of remoteEnvironmentEntries(raw)) {
    if (name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    environment.set(name, value)
  }
  return environment
}

/** Overlay explicit entries and serialize one validated environment for the
 * remote wrapper's `env -i` replay. An `undefined` explicit value removes an
 * ambient entry (the seam's tombstone).
 */
function serializeRemoteEnvironment(raw: string, explicit: Readonly<NodeJS.ProcessEnv> | undefined): string {
  const environment = scrubRemoteEnvironment(raw)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error('subprocess-ssh: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    if (value === undefined) environment.delete(name)
    else environment.set(name, value)
  }
  return [...environment].map(([name, value]) => `${name}=${value}\0`).join('')
}

// -------------------------------------------------------------------- output

/**
 * Offset reader for one collect-mode SSH stream. The complete stream is
 * mirrored to a LOCAL spill file (the host already received every byte), so a
 * lossy read can still point the caller at the full output.
 */
class SshOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private spillValid = true
  private spillHandle: FileHandle | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: string | undefined,
  ) {}

  /** Total bytes observed. */
  get size(): number {
    return this.totalBytes
  }

  /** Stop advertising a spill whose writer stopped early. */
  invalidateSpill(): void {
    this.spillValid = false
  }

  /** Append one byte-faithful transport event (bounded in-memory tail + optional local spill). */
  async push(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return
    await this.writeSpill(bytes)
    const chunk = Buffer.from(bytes)
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** Drop the local spill file (over cap, invalidated, or finalization). */
  async discardSpill(): Promise<void> {
    this.spillValid = false
    const handle = this.spillHandle
    this.spillHandle = undefined
    if (handle !== undefined) await handle.close().catch(() => {})
    if (this.spillPath !== undefined) await unlink(this.spillPath).catch(() => {})
  }

  /** Close the spill writer while keeping the file (consumers read by path). */
  async closeSpill(): Promise<void> {
    const handle = this.spillHandle
    this.spillHandle = undefined
    if (handle !== undefined) await handle.close().catch(() => {})
  }

  private async writeSpill(bytes: Uint8Array): Promise<void> {
    if (!this.spillValid || this.spillPath === undefined || this.maxSpillBytes === undefined) return
    if (this.totalBytes + bytes.length > this.maxSpillBytes) {
      await this.discardSpill()
      return
    }
    if (this.spillHandle === undefined) {
      this.spillHandle = await open(this.spillPath, 'w', 0o600)
    }
    await this.spillHandle.write(bytes)
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(lossy && this.spillValid && this.maxSpillBytes !== undefined && this.totalBytes <= this.maxSpillBytes
        ? { spillPath: this.spillPath }
        : {}),
    }
  }
}

// ------------------------------------------------------------------- process

/** Remote state files one process handle owns (exit facts come from the channel close event). */
interface RemotePaths {
  pid: string
  environment: string
}

/** stdin writes are buffered until the wrapper channel is open. */
class DeferredStdin extends Writable {
  constructor(private readonly ready: Promise<SshExecChannel | undefined>) {
    super({ decodeStrings: false })
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ready.then(channel => {
      if (channel === undefined) throw new Error('subprocess-ssh: channel never opened')
      channel.write(chunk)
    }).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.ready.then(channel => { channel?.end() }).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

/**
 * Build the remote wrapper: an outer bootstrap resolves coreutils, replays the
 * scrubbed environment with `env -i`, then `setsid --wait` starts a detached
 * session leader that publishes its process-group id and runs the argv.
 * stdout/stderr flow straight onto the exec channel (binary-safe); the exit
 * status surfaces through the channel close event.
 */
function commandText(spec: SubprocessSpawnSpec, paths: RemotePaths): string {
  const inner = [
    'set +e',
    'dsh_ps=$1',
    'dsh_tr=$2',
    'dsh_rm=$3',
    'shift 3',
    'dsh_pgid="$("$dsh_ps" -o pgid= -p "$$" | "$dsh_tr" -d " ")"',
    `printf '%s\\n' "$dsh_pgid" > ${quoteShellArg(paths.pid)}`,
    `"$dsh_rm" -f -- ${quoteShellArg(paths.environment)}`,
    '"$@"',
    'dsh_status=$?',
    'exit "$dsh_status"',
  ].join('\n')
  const argv = spec.argv.map(quoteShellArg).join(' ')
  const bootstrap = [
    `mapfile -d '' -t dsh_env < ${quoteShellArg(paths.environment)}`,
    'dsh_env_bin="$(command -v env)"',
    'dsh_setsid="$(command -v setsid)"',
    'dsh_bash="$(command -v bash)"',
    'dsh_ps="$(command -v ps)"',
    'dsh_tr="$(command -v tr)"',
    'dsh_rm="$(command -v rm)"',
    'for dsh_tool in "$dsh_env_bin" "$dsh_setsid" "$dsh_bash" "$dsh_ps" "$dsh_tr" "$dsh_rm"; do',
    '  [[ "$dsh_tool" == /* && -x "$dsh_tool" ]] || exit 125',
    'done',
    `exec "$dsh_env_bin" -i -- "\${dsh_env[@]}" "$dsh_setsid" --wait -- "$dsh_bash" -c ${quoteShellArg(inner)} dsh-ssh "$dsh_ps" "$dsh_tr" "$dsh_rm" ${argv}`,
  ].join('\n')
  return bashCommand(bootstrap)
}

/** One asynchronously-started SSH command projected onto the subprocess seam. */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly commandState = Promise.withResolvers<SshExecChannel | undefined>()
  private readonly readyState = Promise.withResolvers<void>()
  private readonly terminationController = new AbortController()
  /** Releases output waits that survive the command outcome, so blocked stream writes settle. */
  private readonly outputReleased = new AbortController()
  private readonly stdoutReader: SshOutputReader | undefined
  private readonly stderrReader: SshOutputReader | undefined
  private readonly paths: RemotePaths
  private channel: SshExecChannel | undefined
  private remotePid = -1
  private outputTransportError: Error | undefined
  private stateDirectoryCreated = false
  private quiescenceProven = false
  private terminationAttempt: Promise<void> | undefined
  private terminationFailure: Error | undefined
  private terminationSignal: NodeJS.Signals | null = null

  /**
   * Begin an SSH command without blocking the synchronous subprocess spawn call.
   * @param runtime - Shared SSH connection owner.
   * @param spec - Fully resolved subprocess request.
   * @param stateDir - Remote directory retaining process identity.
   * @param pollMs - Remote status/liveness poll cadence.
   */
  constructor(
    private readonly runtime: SshSubprocessRuntime,
    private readonly spec: SubprocessSpawnSpec,
    readonly stateDir: string,
    private readonly pollMs: number,
  ) {
    this.paths = {
      pid: posix.join(stateDir, 'pid'),
      environment: posix.join(stateDir, 'environment'),
    }
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    const stdoutSpill = hasSpill(outMode) ? join(tmpdir(), `dsh-subprocess-ssh-${randomUUID()}.out`) : undefined
    const stderrSpill = hasSpill(errMode) ? join(tmpdir(), `dsh-subprocess-ssh-${randomUUID()}.err`) : undefined
    this.stdoutReader = isCollect(outMode)
      ? new SshOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, stdoutSpill)
      : undefined
    this.stderrReader = isCollect(errMode)
      ? new SshOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, stderrSpill)
      : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new DeferredStdin(this.commandState.promise) : undefined
    void this.readyState.promise.catch(() => {})
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process-group id after start; `-1` while publication is pending or after failure. */
  get pid(): number {
    return this.remotePid
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.quiescenceProven || this.terminationAttempt !== undefined) return
    this.terminationController.abort(new Error('subprocess-ssh: command terminated'))
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.terminationFailure = undefined
    const attempt = this.terminateRemote()
    this.terminationAttempt = attempt
    void attempt.then(
      () => { this.terminationAttempt = undefined },
      (error: unknown) => {
        if (!this.quiescenceProven) this.terminationFailure = asError(error)
        this.terminationAttempt = undefined
      },
    )
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescenceProven) return true
    let channel: SshExecChannel | undefined
    if (this.terminationController.signal.aborted) {
      const observed = await waitWithSignal(this.commandState.promise, signal)
      if (observed === WAIT_ABORTED) return false
      channel = observed
      if (channel === undefined) {
        this.markQuiescent()
        return true
      }
      if (this.remotePid <= 0) {
        const attempt = this.terminationAttempt
        if (attempt !== undefined && await waitWithSignal(attempt.catch(() => undefined), signal) === WAIT_ABORTED) {
          return false
        }
        this.throwTerminationFailure()
        // Successful pre-publication termination records quiescence; its only other outcome is the failure above.
        return true
      }
    } else {
      // readyState failure falls back to commandState (channel open status).
      const observed = await waitWithSignal(
        this.readyState.promise.then(() => this.commandState.promise).catch(() => this.commandState.promise),
        signal,
      )
      if (observed === WAIT_ABORTED) return false
      channel = observed
      if (channel === undefined) {
        this.markQuiescent()
        return true
      }
    }
    this.throwTerminationFailure()
    if (this.remotePid <= 0) {
      // Published channel but no process-group id: nothing group-scoped to wait on.
      this.markQuiescent()
      return true
    }
    let connection: SshConnection
    try {
      connection = await this.runtime.getConnection()
    } catch (error: unknown) {
      if (signal?.aborted === true) return false
      if (this.quiescenceProven) return true
      throw error
    }
    while (await this.groupAlive(connection, this.remotePid, signal)) {
      this.throwTerminationFailure()
      if (!await waitTick(this.pollMs, signal)) return false
    }
    this.throwTerminationFailure()
    if (signal?.aborted === true) return false
    this.markQuiescent()
    return true
  }

  private readonly onAbort = (): void => { this.terminate() }

  private markQuiescent(): void {
    this.quiescenceProven = true
    this.terminationFailure = undefined
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined) throw this.terminationFailure
  }

  private async run(): Promise<SubprocessOutcome> {
    let preparing = true
    try {
      const connection = await this.runtime.getConnection()
      await this.prepareState(connection)
      preparing = false
      const channel = await connection.execChannel(commandText(this.spec, this.paths), { cwd: this.spec.cwd })
      this.channel = channel
      this.commandState.resolve(channel)
      const completion = Promise.withResolvers<SubprocessOutcome>()
      channel.onStdout((chunk) => { void this.dispatchOutput('stdout', chunk) })
      channel.onStderr((chunk) => { void this.dispatchOutput('stderr', chunk) })
      channel.onClose((code, signal) => {
        completion.resolve({ exitCode: code, signal: signal as NodeJS.Signals | null })
      })
      this.setupStdin(channel)
      try {
        this.remotePid = await this.waitForProcessGroupId(connection, completion.promise)
      } catch (error) {
        try {
          await this.rollbackUnpublishedGroup()
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'subprocess-ssh: process-group publication failed and rollback did not reach quiescence',
          )
        }
        throw error
      }
      this.readyState.resolve()
      const outcome = await completion.promise
      if (this.outputTransportError !== undefined) throw this.outputTransportError
      await this.finalizeSpills()
      return outcome
    } catch (error) {
      const canceledPreparation = preparing && this.terminationController.signal.aborted
      let failure = await this.rollbackPublishedFailure(error)
      if (this.stateDirectoryCreated) {
        try {
          await this.removeFailedState()
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'subprocess-ssh: command failed and private state cleanup failed',
          )
        }
      }
      this.commandState.resolve(undefined)
      this.readyState.reject(failure)
      if (canceledPreparation && failure === error) return { exitCode: null, signal: 'SIGTERM' }
      throw failure
    } finally {
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async prepareState(connection: SshConnection): Promise<void> {
    const signal = this.terminationController.signal
    const ambient = await readRemoteEnvironment(connection, signal)
    // Own the directory before the request: a cancellation racing a committed
    // creation must still enter cleanup (rm -rf tolerates an absent path).
    this.stateDirectoryCreated = true
    const environment = serializeRemoteEnvironment(ambient, this.spec.env)
    await connection.exec(
      bashCommand(`mkdir -p ${quoteShellArg(this.stateDir)} && chmod 700 ${quoteShellArg(this.stateDir)}`),
      { timeoutMs: 10_000 },
    )
    const sftp = await connection.getSftp()
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(this.paths.environment, Buffer.from(environment, 'utf8'), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    await connection.exec(bashCommand(`chmod 600 ${quoteShellArg(this.paths.environment)}`), { timeoutMs: 10_000 })
    signal.throwIfAborted()
  }

  private setupStdin(channel: SshExecChannel): void {
    const mode = this.spec.stdio.stdin
    if (mode === 'ignore') {
      channel.end()
      return
    }
    if (typeof mode === 'object') {
      if (mode.data.length > 0) channel.write(mode.data)
      channel.end()
    }
    // 'pipe' is handled by the DeferredStdin bound to commandState.
  }

  private async dispatchOutput(stream: 'stdout' | 'stderr', chunk: Buffer): Promise<void> {
    try {
      if (stream === 'stdout') {
        await this.stdoutReader?.push(chunk)
        await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, chunk)
        return
      }
      await this.stderrReader?.push(chunk)
      await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, chunk)
    } catch (error) {
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(asError(error))
    }
  }

  private async writeOutput(
    pipe: PassThrough | undefined,
    inherited: NodeJS.WriteStream | undefined,
    data: Uint8Array,
  ): Promise<void> {
    const target = pipe ?? inherited
    if (target === undefined || data.length === 0 || this.terminationController.signal.aborted) return
    if (target.destroyed) throw new Error('subprocess output stream is closed')
    if (target.write(data)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve() }
      const onClose = (): void => { cleanup(); resolve() }
      const onRelease = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        target.removeListener('drain', onDrain)
        target.removeListener('close', onClose)
        target.removeListener('error', onError)
        this.terminationController.signal.removeEventListener('abort', onRelease)
        this.outputReleased.signal.removeEventListener('abort', onRelease)
      }
      target.once('drain', onDrain)
      target.once('close', onClose)
      target.once('error', onError)
      this.terminationController.signal.addEventListener('abort', onRelease, { once: true })
      this.outputReleased.signal.addEventListener('abort', onRelease, { once: true })
      if (this.terminationController.signal.aborted || this.outputReleased.signal.aborted) onRelease()
    })
  }

  private async waitForProcessGroupId(connection: SshConnection, completion: Promise<unknown>): Promise<number> {
    const sftp = await connection.getSftp()
    const commandSettled = completion.then(
      () => true,
      () => true,
    )
    while (true) {
      let raw = ''
      try {
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          sftp.readFile(this.paths.pid, (error, data) => {
            if (error) reject(error)
            else resolve(data)
          })
        })
        raw = buffer.toString('utf8').trim()
      } catch {
        // The wrapper has not published yet; poll again.
      }
      if (raw.length > 0) {
        const pid = Number(raw)
        if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(pid)) {
          throw new Error(`subprocess-ssh: remote wrapper published invalid process-group id ${JSON.stringify(raw)}`)
        }
        // Refuse ids whose negative form addresses every process (`kill -- -1`) or init's group.
        if (pid <= 1) {
          throw new Error(`subprocess-ssh: unsafe published process-group id ${pid}`)
        }
        return pid
      }
      if (this.terminationController.signal.aborted) {
        throw new Error('subprocess-ssh: process-group publication aborted')
      }
      const settled = await Promise.race([commandSettled, waitTick(this.pollMs).then(() => false)])
      if (settled) {
        throw new Error('subprocess-ssh: remote command exited before publishing its process-group id')
      }
    }
  }

  private async rollbackUnpublishedGroup(): Promise<void> {
    // Without a published pgid the only termination lever is closing the
    // channel; sshd tears the session down and the wrapper group follows.
    this.channel?.close()
    this.markQuiescent()
  }

  private async rollbackPublishedFailure(error: unknown): Promise<unknown> {
    if (this.remotePid <= 0 || this.quiescenceProven) return error
    this.terminate()
    try {
      await this.waitForExit()
      return error
    } catch (cleanupError) {
      return new AggregateError(
        [asError(error), asError(cleanupError)],
        'subprocess-ssh: command monitoring failed and process-group rollback did not reach quiescence',
      )
    }
  }

  private async terminateRemote(): Promise<void> {
    const channel = await this.commandState.promise
    if (channel === undefined) {
      this.markQuiescent()
      return
    }
    if (this.remotePid <= 0) {
      // Wait for publication (the wrapper may not have started the group yet),
      // then either terminate the published group or close the channel. A
      // failed startup settles here too (readyState rejection is consumed).
      await waitWithSignal(this.readyState.promise.catch(() => undefined), undefined)
      if (this.remotePid <= 0) {
        this.channel?.close()
        this.markQuiescent()
        return
      }
    }
    const connection = await this.runtime.getConnection()
    await this.terminateGroup(connection, this.remotePid)
  }

  private async terminateGroup(connection: SshConnection, processGroupId: number): Promise<void> {
    this.terminationSignal = 'SIGTERM'
    try {
      await signalRemoteGroups(connection, [processGroupId], 'TERM')
      if (await this.waitForGroupExit(connection, processGroupId)) {
        this.markQuiescent()
        return
      }
    } catch (_gracefulTerminationFailure) {
      // Failed TERM delivery or observation cannot prove exit; force cleanup still owns the group.
    }
    this.terminationSignal = 'SIGKILL'
    await this.forceKillGroup(connection, processGroupId)
    this.markQuiescent()
  }

  private async forceKillGroup(connection: SshConnection, processGroupId: number): Promise<void> {
    try {
      await signalRemoteGroups(connection, [processGroupId], 'KILL')
    } catch (_processGroupKillFailure) {
      // The final liveness probe, not the signal command's self-report, proves cleanup.
    }
    if (await this.waitForGroupExit(connection, processGroupId)) return
    throw new Error(`subprocess-ssh: remote process group ${processGroupId} remained live after force termination`)
  }

  private async waitForGroupExit(connection: SshConnection, processGroupId: number): Promise<boolean> {
    const deadline = Date.now() + this.spec.graceMs
    while (await this.groupAlive(connection, processGroupId)) {
      if (Date.now() >= deadline) return false
      await waitTick(this.pollMs)
    }
    return true
  }

  private async groupAlive(connection: SshConnection, pid: number, signal?: AbortSignal): Promise<boolean> {
    const script = `set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }'`
    const result = await connection.exec(bashCommand(script), { timeoutMs: 10_000 })
    return signal?.aborted === true ? false : result.stdout.trim() === 'live'
  }

  private async finalizeSpills(): Promise<void> {
    const removals: Promise<void>[] = []
    const collect = (mode: SubprocessOutputMode, reader: SshOutputReader | undefined): void => {
      if (!hasSpill(mode)) return
      const size = (reader as SshOutputReader).size
      // Keep only a spill that the reader may still advertise: a stream small
      // enough to fit the tail, or one that overflowed the spill cap, is dropped.
      if (size <= mode.maxBytes || size > mode.spill.maxBytes) {
        removals.push((reader as SshOutputReader).discardSpill().catch(() => {}))
      } else {
        removals.push((reader as SshOutputReader).closeSpill().catch(() => {}))
      }
    }
    collect(this.spec.stdio.stdout, this.stdoutReader)
    collect(this.spec.stdio.stderr, this.stderrReader)
    await Promise.all(removals)
  }

  private async removeFailedState(): Promise<void> {
    try {
      const connection = await this.runtime.getConnection()
      await connection.exec(bashCommand(`rm -rf -- ${quoteShellArg(this.stateDir)}`), { timeoutMs: 10_000 })
    } catch {
      // The command outcome is authoritative; owner teardown bounds private residue.
    }
  }
}

// ------------------------------------------------------------------ terminal

const TERMINAL_MARKER_PREFIX = 'dsh-ssh-bootstrap:'

/** Filters the terminal output stream until the private bootstrap marker appears. */
class BootstrapOutputFilter {
  readonly ready: Promise<void>

  private readonly readyState = Promise.withResolvers<void>()
  private pending = Buffer.alloc(0)
  private published = false

  constructor(
    private readonly marker: Buffer,
    private readonly output: PassThrough,
  ) {
    this.ready = this.readyState.promise
  }

  push(data: Uint8Array): void {
    if (this.published) {
      this.write(data)
      return
    }
    const combined = Buffer.concat([this.pending, Buffer.from(data)])
    const markerOffset = combined.indexOf(this.marker)
    if (markerOffset < 0) {
      const retained = Math.min(combined.length, this.marker.length - 1)
      this.pending = Buffer.from(combined.subarray(combined.length - retained))
      return
    }
    this.published = true
    this.pending = Buffer.alloc(0)
    this.readyState.resolve()
    // The marker line ends with a newline; drop it so the consumer never
    // sees the private bootstrap line itself.
    let rest = combined.subarray(markerOffset + this.marker.length)
    if (rest[0] === 0x0a) rest = rest.subarray(1)
    this.write(rest)
  }

  private write(data: Uint8Array): void {
    if (data.length > 0 && !this.output.destroyed) this.output.write(data)
  }
}

async function waitForBootstrapOutput(
  ready: Promise<void>,
  completion: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let removeAbort: (() => void) | undefined
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      removeAbort?.()
      complete()
    }
    const onExit = (): void => {
      finish(() => { reject(new Error('subprocess-ssh: terminal exited before publishing its output boundary')) })
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        finish(() => { reject(asError(signal.reason)) })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => { signal.removeEventListener('abort', onAbort) }
    }
    void ready.then(() => { finish(resolve) })
    void completion.then(onExit, onExit)
  })
}

function parsePositiveId(value: string, message: string): number {
  const raw = value.trim()
  const id = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) throw new Error(message)
  return id
}

async function terminalSessionId(connection: SshConnection, pid: number): Promise<number> {
  const result = await connection.exec(bashCommand(`ps -o sid= -p ${pid}`), { timeoutMs: 10_000 })
  return parsePositiveId(result.stdout, `subprocess-ssh: cannot resolve process session for terminal ${pid}`)
}

async function sessionProcessGroups(connection: SshConnection, sessionId: number): Promise<number[]> {
  const script = `set -o pipefail; ps -eo sid=,pgid=,stat= | awk '$1 == ${sessionId} && $3 !~ /^[ZXx]/ { print $2 }'`
  const result = await connection.exec(bashCommand(script), { timeoutMs: 10_000 })
  const groups = new Set<number>()
  for (const raw of result.stdout.trim().split(/\s+/)) {
    if (raw.length === 0) continue
    const group = parsePositiveId(
      raw,
      `subprocess-ssh: invalid process group ${JSON.stringify(raw)} in terminal session ${sessionId}`,
    )
    if (group <= 1) {
      throw new Error(`subprocess-ssh: unsafe process group ${group} in terminal session ${sessionId}`)
    }
    groups.add(group)
  }
  return [...groups]
}

async function awaitSessionEmpty(
  connection: SshConnection,
  sessionId: number,
  graceMs: number,
  pollMs: number,
  kill = false,
): Promise<number[]> {
  const deadline = Date.now() + graceMs
  for (;;) {
    const groups = await sessionProcessGroups(connection, sessionId)
    if (groups.length === 0) return groups
    if (kill) {
      await signalRemoteGroups(connection, groups, 'KILL')
      if (Date.now() >= deadline) return await sessionProcessGroups(connection, sessionId)
    } else if (Date.now() >= deadline) {
      return groups
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/** Poll the bootstrap pid file until the PTY shell publishes its process id. */
async function waitForPidFile(
  connection: SshConnection,
  path: string,
  pollMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const sftp = await connection.getSftp()
  while (true) {
    signal?.throwIfAborted()
    let raw = ''
    try {
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(path, (error, data) => {
          if (error) reject(error)
          else resolve(data)
        })
      })
      raw = buffer.toString('utf8').trim()
    } catch {
      // Not published yet; poll again.
    }
    if (raw.length > 0) {
      const pid = Number(raw)
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(pid)) {
        throw new Error(`subprocess-ssh: terminal published invalid process id ${JSON.stringify(raw)}`)
      }
      if (pid <= 1) throw new Error(`subprocess-ssh: unsafe terminal process id ${pid}`)
      return pid
    }
    if (!await waitTick(pollMs, signal)) {
      throw new Error('subprocess-ssh: terminal bootstrap pid publication aborted')
    }
  }
}

/** One SSH PTY and all process groups in its remote process session. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output: PassThrough
  readonly done: Promise<SubprocessOutcome>

  private topLevelExited = false
  private cleanup: Promise<void> | undefined
  private readonly operationController = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private terminationSignal: NodeJS.Signals | null = null

  constructor(
    private readonly connection: SshConnection,
    private readonly shell: ShellSession,
    output: PassThrough,
    completion: Promise<{ code: number | null }>,
    pid: number,
    private readonly sessionId: number,
    private readonly stateDir: string,
    private readonly graceMs: number,
    private readonly pollMs: number,
  ) {
    this.pid = pid
    this.output = output
    this.done = completion.then(
      ({ code }) => ({ exitCode: code, signal: this.terminationSignal }),
      (error: unknown) => {
        this.output.destroy(asError(error))
        throw error
      },
    )
    void this.done.then(
      () => { this.finish() },
      () => { this.finish() },
    )
  }

  /** @inheritdoc */
  write(data: string): Promise<void> {
    return this.trackOperation(async (signal) => {
      if (this.topLevelExited) throw new Error('terminal process has exited')
      signal.throwIfAborted()
      this.shell.send(data)
    })
  }

  /** @inheritdoc */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.trackOperation(signal => this.inspectForegroundOnce(signal))
  }

  /** @inheritdoc */
  signalForeground(signalName: SubprocessTerminalSignal): Promise<number> {
    return this.trackOperation(async (operationSignal) => {
      const foreground = await this.inspectForegroundOnce(operationSignal)
      if (foreground === undefined) {
        throw new Error(`subprocess-ssh: cannot resolve foreground process group for terminal ${this.pid}`)
      }
      if (signalName === 'SIGKILL' && foreground.processGroupId === this.pid) {
        throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
      }
      await signalRemoteGroups(this.connection, [foreground.processGroupId], signalName.slice(3) as 'TERM' | 'KILL')
      return foreground.processGroupId
    })
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.operationController.abort(new Error('subprocess-ssh: terminal is terminating'))
    const cleanup = this.closeAfterOperations()
    this.cleanup = cleanup
    void cleanup.catch((_cleanupFailure: unknown) => {
      this.cleanup = undefined
    })
    return cleanup
  }

  private finish(): void {
    this.topLevelExited = true
    if (!this.output.destroyed) this.output.end()
  }

  private async inspectForegroundOnce(
    signal: AbortSignal,
  ): Promise<SubprocessTerminalForeground | undefined> {
    const result = await this.connection.exec(bashCommand(`ps -o tpgid= -p ${this.pid}`), { timeoutMs: 10_000 })
    if (signal.aborted || this.topLevelExited || result.exitCode !== 0) return undefined
    return {
      processGroupId: parsePositiveId(
        result.stdout,
        `subprocess-ssh: cannot resolve foreground process group for terminal ${this.pid}`,
      ),
      // The SSH substrate exposes process-table commands but not the /proc
      // memory access needed to prove a specific syscall waits on fd 0.
      inputWaiting: false,
    }
  }

  private trackOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operationController.signal.aborted) {
      return Promise.reject(new Error('subprocess-ssh: terminal is terminating'))
    }
    const pending = operation(this.operationController.signal)
    this.operations.add(pending)
    void pending.then(
      () => { this.operations.delete(pending) },
      () => { this.operations.delete(pending) },
    )
    return pending
  }

  private async closeAfterOperations(): Promise<void> {
    await Promise.allSettled(this.operations)
    await this.closeOnce()
  }

  private async closeOnce(): Promise<void> {
    let groups = await sessionProcessGroups(this.connection, this.sessionId)
    if (groups.length > 0) {
      this.terminationSignal = 'SIGTERM'
      await signalRemoteGroups(this.connection, groups, 'TERM')
      groups = await awaitSessionEmpty(this.connection, this.sessionId, this.graceMs, this.pollMs)
    }
    if (groups.length === 0 && !this.topLevelExited) {
      await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)])
    }
    if (groups.length > 0 || !this.topLevelExited) {
      this.terminationSignal = 'SIGKILL'
      if (!this.topLevelExited) {
        this.shell.close()
      }
      groups = await awaitSessionEmpty(this.connection, this.sessionId, this.graceMs, this.pollMs, true)
      if (!this.topLevelExited) await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)])
    }
    if (groups.length > 0) {
      throw new Error(`subprocess-ssh: terminal cleanup failed; surviving process groups: ${groups.join(', ')}`)
    }
    if (!this.topLevelExited) {
      throw new Error(`subprocess-ssh: terminal cleanup failed; surviving pid: ${this.pid}`)
    }
    this.shell.close()
    try {
      await this.connection.exec(bashCommand(`rm -rf -- ${quoteShellArg(this.stateDir)}`), { timeoutMs: 10_000 })
    } catch {
      // The terminal is quiescent; owner teardown bounds private residue.
    }
  }
}

/**
 * Open an SSH PTY, inject `exec <argv>`, and return only after the shell has
 * published its pid through the private marker.
 */
export async function spawnSshTerminal(
  connection: SshConnection,
  spec: SubprocessTerminalSpawnSpec,
  stateDir: string,
  pollMs: number,
): Promise<SshTerminalHandle> {
  spec.signal?.throwIfAborted()
  const paths = {
    pid: posix.join(stateDir, 'pid'),
  }
  const outputMarker = `${TERMINAL_MARKER_PREFIX}${randomUUID()}`
  const output = new PassThrough()
  const outputFilter = new BootstrapOutputFilter(Buffer.from(outputMarker), output)
  let shell: ShellSession | undefined
  let stateDirectoryCreated = false
  try {
    await connection.exec(
      bashCommand(`mkdir -p ${quoteShellArg(stateDir)} && chmod 700 ${quoteShellArg(stateDir)}`),
      { timeoutMs: 10_000 },
    )
    stateDirectoryCreated = true
    spec.signal?.throwIfAborted()
    shell = await connection.openShell(spec.cols, spec.rows)
    // The login shell prints the marker, publishes its pid, then replaces
    // itself with the requested argv (spec.env becomes a shell-prefix overlay;
    // the PTY keeps the login environment — see the module doc).
    const argvLine = spec.argv.map(quoteShellArg).join(' ')
    const envPrefix = Object.entries(spec.env ?? {}).map(([name, value]) => `${name}=${quoteShellArg(value)} `).join('')
    // `\\n` stays a literal backslash-n in the injected text so the remote
    // shell's printf interprets it as the standard newline escape.
    const command = [
      `printf ${quoteShellArg(`${outputMarker}\\n`)}`,
      `printf ${quoteShellArg('%s\\n')} "$$" > ${quoteShellArg(paths.pid)}`,
      `${envPrefix}exec ${argvLine}\r`,
    ].join('; ')
    shell.send(command)
    const exitState = Promise.withResolvers<{ code: number | null }>()
    shell.onExit = (code) => { exitState.resolve({ code }) }
    shell.onData = (chunk) => { outputFilter.push(chunk) }
    await waitForBootstrapOutput(outputFilter.ready, exitState.promise, spec.signal)
    const pid = await waitForPidFile(connection, paths.pid, pollMs, spec.signal)
    const sessionId = await terminalSessionId(connection, pid)
    return new SshTerminalHandle(
      connection,
      shell,
      output,
      exitState.promise,
      pid,
      sessionId,
      stateDir,
      spec.graceMs,
      pollMs,
    )
  } catch (error) {
    output.destroy()
    const failures: Error[] = []
    if (shell !== undefined) {
      try {
        shell.close()
      } catch (cleanupError) {
        failures.push(asError(cleanupError))
      }
    }
    if (stateDirectoryCreated) {
      try {
        await connection.exec(bashCommand(`rm -rf -- ${quoteShellArg(stateDir)}`), { timeoutMs: 10_000 })
      } catch (cleanupError) {
        failures.push(asError(cleanupError))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError([asError(error), ...failures], asError(error).message)
    }
    throw error
  }
}

// ------------------------------------------------------------------- runtime

/** Configuration for the SSH subprocess adapter. */
export interface Config {
  /** Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request. */
  pollMs?: number
}

interface SchemaResolvedConfig extends Config {
  pollMs: number
}

interface TerminalSetup {
  done: Promise<void>
  controller: AbortController
}

/**
 * Enforce the seam's documented grace bound (positive, finite, one Node timer);
 * an unbounded grace would make the remote force-escalation deadline unreachable.
 */
function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** SSH command manager registered as `ctx.subprocess`. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']

  static Config: z<Config> = z.object({
    // The E2B adapter polls every 20ms; SSH control-plane requests cross a
    // network RTT, so a coarser default keeps polling proportional.
    pollMs: z.number().default(100),
  })

  private readonly live = new Set<SshSubprocessHandle>()
  private readonly terminals = new Set<SshTerminalHandle>()
  private readonly terminalSetups = new Set<TerminalSetup>()
  private readonly pollMs: number
  private disposing = false

  /** Create the SSH subprocess service and bind its disposal policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const { pollMs } = config as SchemaResolvedConfig
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
      throw new Error('subprocess-ssh: pollMs must be a positive safe integer')
    }
    this.pollMs = pollMs
    ctx.effect(() => async () => {
      this.disposing = true
      for (const setup of this.terminalSetups) {
        setup.controller.abort(new Error('subprocess-ssh: service disposed during terminal setup'))
      }
      await Promise.all([...this.terminalSetups].map(setup => setup.done))
      const handles = [...this.live]
      const terminals = [...this.terminals]
      const pending: Promise<unknown>[] = []
      for (const handle of handles) {
        handle.terminate()
        pending.push(handle.waitForExit().then(async () => {
          await handle.done.catch(() => undefined)
          this.live.delete(handle)
        }))
      }
      for (const terminal of terminals) {
        pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
      }
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
        ? [outcome.reason as unknown]
        : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-ssh: teardown failed')
    }, 'ssh subprocess teardown')
  }

  /** Shared SSH connection for this adapter's remote world. */
  async getConnection(): Promise<SshConnection> {
    return this.ctx.ssh.getConnection()
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-ssh: executable name must be non-empty')
    signal?.throwIfAborted()
    const connection = await this.ctx.ssh.getConnection()
    if (posix.isAbsolute(command)) {
      const script = `test -f ${quoteShellArg(command)} -a -x ${quoteShellArg(command)}`
      const result = await connection.exec(bashCommand(script), { timeoutMs: 10_000 })
      signal?.throwIfAborted()
      if (!result.success) {
        throw new Error(`subprocess-ssh: executable ${JSON.stringify(command)} is not an executable file`)
      }
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-ssh: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const path = env?.PATH
    const prefix = path === undefined ? '' : `PATH=${quoteShellArg(path)} `
    // SSH has no shared remote cwd, so PATH lookups run relative to the login
    // home (getent-derived; see readRemoteEnvironment).
    const home = connection.home ?? '/'
    const result = await connection.exec(
      bashCommand(`${prefix}command -v -- ${quoteShellArg(command)}`),
      { cwd: home, timeoutMs: 10_000 },
    )
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-ssh: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    // A relative result comes from a relative PATH entry; the lookup ran with the login home.
    return posix.resolve(home, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }
    const stateDir = posix.join(STATE_ROOT, 'dsh-ssh-processes', randomUUID())
    const handle = new SshSubprocessHandle(this, spec, stateDir, this.pollMs)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the handle so service disposal can retry its cleanup transaction.
    })
    return handle
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-ssh: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const stateDir = posix.join(STATE_ROOT, 'dsh-ssh-terminals', randomUUID())
    const done = Promise.withResolvers<void>()
    const setup: TerminalSetup = { done: done.promise, controller: new AbortController() }
    const setupSignal = spec.signal === undefined
      ? setup.controller.signal
      : AbortSignal.any([spec.signal, setup.controller.signal])
    this.terminalSetups.add(setup)
    try {
      const connection = await this.ctx.ssh.getConnection()
      const terminal = await spawnSshTerminal(
        connection,
        { ...spec, signal: setupSignal },
        stateDir,
        this.pollMs,
      )
      this.terminals.add(terminal)
      // Remote allocation yields to disposal: teardown may win this race.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (this.disposing) {
        await terminal.terminate()
        this.terminals.delete(terminal)
        throw new Error('subprocess-ssh: service disposed during terminal setup')
      }
      const release = async (): Promise<void> => {
        await terminal.terminate()
        this.terminals.delete(terminal)
      }
      void terminal.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
        // Retain the terminal so service disposal can retry its cleanup transaction.
      })
      return terminal
    } finally {
      this.terminalSetups.delete(setup)
      done.resolve()
    }
  }
}

export default SshSubprocessRuntime
