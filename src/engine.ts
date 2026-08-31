/**
 * The remote-IDE SSH engine: a per-alias persistent connection pool (ssh2)
 * with jump-host support, command execution, PTY shells and SFTP file
 * operations — the DSH counterpart of a remote-development backend, living
 * entirely in the host process.
 */

import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import type {
  ConnectionState,
  ExecResult,
  RemoteDirEntry,
  RemoteFileContent,
  SshAuthKind,
  SshHostEntry,
  SshHostSummary,
  TestResult,
  WorkspaceStatus,
} from './protocol'
import { expandHome, type HostStore } from './store'

/** Engine knobs. */
export interface EngineOptions {
  /** Connections idle longer than this are closed (ms). */
  idleTimeoutMs?: number
  /** SSH handshake timeout (ms). */
  connectTimeoutMs?: number
  /** Keepalive ping interval (ms). */
  keepaliveIntervalMs?: number
  /** Cap on captured stdout/stderr bytes per exec. */
  maxOutputBytes?: number
  /** Default exec timeout (ms). */
  defaultExecTimeoutMs?: number
  /** Cap on remote file bytes read into the editor (larger files are truncated). */
  maxReadBytes?: number
}

const DEFAULTS: Required<EngineOptions> = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  maxOutputBytes: 2 * 1024 * 1024,
  defaultExecTimeoutMs: 60_000,
  maxReadBytes: 2 * 1024 * 1024,
}

/** One pooled connection record. */
interface PoolRecord {
  client: Client
  /** Jump-chain clients kept alive under the target. */
  hops: Client[]
  /** SFTP subsystem handle, lazily opened. */
  sftp?: import('ssh2').SFTPWrapper
  sftpReady?: Promise<import('ssh2').SFTPWrapper>
  /** Remote $HOME, resolved lazily. */
  home?: string
  idleAt: number
  broken: boolean
  /** Operations currently running on this connection (sweep guard). */
  inFlight: number
}

/**
 * Low-level streaming command channel: raw duplex access to one SSH exec
 * channel without collection, timeouts, or exit-code normalization. The
 * subprocess adapter (subprocess-ssh) builds its wrapper protocol and
 * tree-scoped termination on top of this seam.
 *
 * stdout/stderr are delivered as distinct Buffer streams (ssh2 keeps the
 * remote stderr on an extended-data channel); the close event carries the
 * remote exit-status (code) or, for a signal death, null plus the signal
 * name — matching the Node child-process vocabulary the subprocess seam uses.
 */
export interface SshExecChannel {
  /** Register a stdout-data listener (Buffer chunks, delivery order). */
  onStdout(listener: (chunk: Buffer) => void): void
  /** Register a stderr-data listener (Buffer chunks, delivery order). */
  onStderr(listener: (chunk: Buffer) => void): void
  /** Register a close listener: `(code)` on normal exit, `(null, signal)` on signal death. */
  onClose(listener: (code: number | null, signal: string | null) => void): void
  /** Write bytes to the channel's stdin. */
  write(data: Buffer | string): void
  /** Send EOF on stdin (the remote child sees `read(0)` return 0). */
  end(): void
  /** Close the channel immediately without waiting for the remote side. */
  close(): void
}

/** A live PTY shell session. */
export interface ShellSession {
  /** Assign to receive remote output. */
  onData?: (data: Buffer) => void
  /** Assign to be notified when the channel closes. */
  onExit?: (code: number | null, error?: string) => void
  /** Write raw input to the shell. */
  send(data: string): void
  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void
  /** Pause remote output delivery (transport backpressure). */
  pause(): void
  /** Resume remote output delivery. */
  resume(): void
  /** Close the session and its channel. */
  close(): void
}

/** Build the ssh2 connect config for one entry (key read from disk). */
function buildConnectConfig(entry: SshHostEntry, sock?: ConnectConfig['sock'], readyTimeoutMs?: number): ConnectConfig {
  const config: ConnectConfig = {
    host: entry.host,
    port: entry.port,
    username: entry.user,
    readyTimeout: readyTimeoutMs ?? 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  }
  if (sock !== undefined) config.sock = sock
  // 开启 keyboard-interactive：配合 connectClient 的回应回调覆盖
  // Ubuntu/PAM 常见「仅 keyboard-interactive」服务器。
  config.tryKeyboard = true
  if (entry.auth.kind === 'password') {
    config.password = entry.auth.password
  } else {
    const keyPath = entry.auth.keyPath === undefined ? undefined : expandHome(entry.auth.keyPath)
    if (keyPath === undefined || !existsSync(keyPath)) {
      throw new Error(`private key not found: '${entry.auth.keyPath ?? '(unset)'}'`)
    }
    config.privateKey = readFileSync(keyPath, 'utf8')
    if (entry.auth.passphrase !== undefined && entry.auth.passphrase !== '') {
      config.passphrase = entry.auth.passphrase
    }
  }
  return config
}

/** Connect one ssh2 client (resolve on ready, reject on error/close). */
function connectClient(config: ConnectConfig, password?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    // Permanent guard: an ssh2 Client whose 'error' event has no listener
    // makes Node throw and kill the process. The once() handlers below only
    // cover the initial connect, so every later transport error (e.g. a
    // reset on a jump-host or test client) lands here.
    client.on('error', () => {})
    let settled = false
    client.once('ready', () => {
      if (settled) return
      settled = true
      resolve(client)
    })
    client.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    // keyboard-interactive 认证（Ubuntu/PAM 服务器常见：sshd 可能只提供
    // keyboard-interactive 而非 password 方法）：用同一密码回应所有提示。
    // 没有 tryKeyboard 时 ssh2 只试 password，遇到仅 keyboard-interactive
    // 的服务器会报 "All configured authentication methods failed"。
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password ?? ''))
    })
    try {
      client.connect(config)
    } catch (error) {
      if (!settled) {
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
}

/** Cap captured output at the configured byte budget (marks truncation). */
function appendOutput(target: { text: string; truncated: boolean }, chunk: Buffer, maxBytes: number): void {
  if (target.truncated) return
  if (target.text.length + chunk.length > maxBytes) {
    let cut = chunk.toString('utf8').slice(0, maxBytes - target.text.length)
    // Never split a surrogate pair at the cut boundary.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
    target.text += cut + '…[output truncated]'
    target.truncated = true
    return
  }
  target.text += chunk.toString('utf8')
}

/** The engine. Owns the pool, the active IDE connection and all operations. */
export class SshEngine {
  private readonly store: HostStore
  private readonly opts: Required<EngineOptions>
  private readonly pool = new Map<string, PoolRecord>()
  /** In-flight connect attempts (concurrent callers await instead of racing). */
  private readonly connecting = new Map<string, Promise<PoolRecord>>()
  private sweepTimer: NodeJS.Timeout | undefined
  /** Alias of the connection the IDE workspace is bound to ('' = none). */
  private activeAlias = ''
  private state: ConnectionState = 'disconnected'
  private lastError: string | undefined
  private connectedAt: number | undefined

  constructor(store: HostStore, options?: EngineOptions) {
    this.store = store
    this.opts = { ...DEFAULTS, ...options }
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(10_000, this.opts.idleTimeoutMs / 4))
    this.sweepTimer.unref?.()
  }

  // ---------------------------------------------------------------- config

  /** Secret-free host list (filtered by the optional query). */
  list(query?: string): SshHostSummary[] {
    const needle = query?.trim().toLowerCase()
    return this.store.list()
      .filter(entry => needle === undefined || needle === ''
        || entry.alias.toLowerCase().includes(needle)
        || (entry.description ?? '').toLowerCase().includes(needle)
        || entry.host.toLowerCase().includes(needle)
        || entry.tags.some(tag => tag.toLowerCase().includes(needle)))
      .map(entry => this.store.summarize(entry))
  }

  /** One host summary by alias. */
  get(alias: string): SshHostSummary | undefined {
    const entry = this.store.get(alias)
    return entry === undefined ? undefined : this.store.summarize(entry)
  }

  /** Create or update a host. */
  upsertHost(payload: Parameters<HostStore['upsert']>[0], existingAlias?: string) {
    return this.store.upsert(payload, existingAlias)
  }

  removeHost(alias: string): boolean {
    // Disconnect first when the removed host is the active one.
    if (this.activeAlias === alias) this.disconnect()
    this.dropConnection(alias)
    return this.store.remove(alias)
  }

  importSshConfig() {
    return this.store.importSshConfig()
  }

  // ------------------------------------------------------------ connection

  /** Test a host without keeping a pooled connection. */
  async test(alias: string): Promise<TestResult> {
    const entry = this.store.get(alias)
    if (entry === undefined) return { ok: false, error: `unknown host: ${alias}` }
    return this.testEntry(entry)
  }

  /**
   * Test an ad-hoc host config (settings-card "test connection" endpoint).
   * Builds an entry from the config and runs the same probe as test().
   */
  async testConfig(config: {
    host: string
    port?: number
    user: string
    auth: { kind: SshAuthKind; keyPath?: string; passphrase?: string; password?: string }
    proxyJump?: string[]
  }): Promise<TestResult> {
    const entry: SshHostEntry = {
      alias: '(probe)',
      host: config.host,
      port: config.port ?? 22,
      user: config.user,
      auth: config.auth,
      proxyJump: config.proxyJump ?? [],
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    }
    return this.testEntry(entry)
  }

  /** Shared probe: connect (optionally through the jump chain) and exec echo. */
  private async testEntry(entry: SshHostEntry): Promise<TestResult> {
    const started = Date.now()
    let client: Client | undefined
    // Jump-hop clients must outlive the probe: they carry the target's
    // transport socket, so they are ended only in finally (ending them
    // earlier drops the connection before the ping runs).
    const hops: Client[] = []
    try {
      const config = buildConnectConfig(entry, undefined, this.opts.connectTimeoutMs)
      const password = entry.auth.kind === 'password' ? entry.auth.password : undefined
      if (entry.proxyJump.length > 0) {
        const opened = await this.connectHops(entry)
        for (const hop of opened) hops.push(hop.client)
        config.sock = opened[opened.length - 1]!.sock
      }
      client = await connectClient(config, password)
      const ok = await new Promise<boolean>((resolve) => {
        client!.exec('echo dsh-remote-ide-ping', (error, stream) => {
          if (error) { resolve(false); return }
          stream.resume()
          stream.on('close', () => resolve(true))
        })
      })
      return { ok, latencyMs: Date.now() - started }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      client?.end()
      for (const hop of hops) {
        try { hop.end() } catch { /* already closed */ }
      }
    }
  }

  /**
   * Open (or reuse) the pooled connection for a host. Concurrent callers
   * while a connect attempt is in flight await that same attempt — they must
   * never observe a record whose client has not been assigned yet.
   */
  async ensureConnection(alias: string): Promise<PoolRecord> {
    const existing = this.pool.get(alias)
    if (existing !== undefined && existing.client !== undefined && !existing.broken) return existing
    const inflight = this.connecting.get(alias)
    if (inflight !== undefined) return inflight
    const attempt = this.openPoolRecord(alias)
    this.connecting.set(alias, attempt)
    void attempt.catch(() => {})
    return attempt
  }

  /** Build one pooled connection record (pool + in-flight registry updated). */
  private async openPoolRecord(alias: string): Promise<PoolRecord> {
    try {
      const entry = this.store.get(alias)
      if (entry === undefined) throw new Error(`unknown host: ${alias}`)
      this.dropConnection(alias)

      const record: PoolRecord = {
        client: undefined as unknown as Client,
        hops: [],
        idleAt: Date.now(),
        broken: false,
        inFlight: 0,
      }
      this.pool.set(alias, record)
      const config = buildConnectConfig(entry, undefined, this.opts.connectTimeoutMs)
      if (entry.proxyJump.length > 0) {
        const hops = await this.connectHops(entry)
        config.sock = hops[hops.length - 1]!.sock
        record.hops = hops.map(h => h.client)
      }
      let client: Client
      try {
        client = await connectClient(config, entry.auth.kind === 'password' ? entry.auth.password : undefined)
      } catch (error) {
        // 目标连接失败时跳板链已建立——显式释放，否则泄漏。
        for (const hop of record.hops) {
          try { hop.end() } catch { /* already closed */ }
        }
        throw error
      }
      record.client = client
      client.on('error', (error) => {
        record.broken = true
        if (this.activeAlias === alias) {
          this.state = 'failed'
          this.lastError = error instanceof Error ? error.message : String(error)
        }
      })
      client.on('close', () => {
        record.broken = true
        if (this.activeAlias === alias) {
          this.state = 'disconnected'
          this.activeAlias = ''
          this.connectedAt = undefined
        }
      })
      record.idleAt = Date.now()
      return record
    } catch (error) {
      this.pool.delete(alias)
      throw error
    } finally {
      this.connecting.delete(alias)
    }
  }

  /** Open the jump chain for an entry (returns hop sockets in order). */
  private async connectHops(entry: SshHostEntry): Promise<Array<{ client: Client; sock: import('node:net').Socket }>> {
    const hops: Array<{ client: Client; sock: import('node:net').Socket }> = []
    for (const hopAlias of entry.proxyJump) {
      const hop = this.store.get(hopAlias)
      if (hop === undefined) throw new Error(`jump host not found: ${hopAlias}`)
      const config = buildConnectConfig(hop, undefined, this.opts.connectTimeoutMs)
      if (hops.length > 0) config.sock = hops[hops.length - 1]!.sock
      const client = await connectClient(config, hop.auth.kind === 'password' ? hop.auth.password : undefined)
      const sock = (client as unknown as { sock: import('node:net').Socket }).sock
      hops.push({ client, sock })
    }
    return hops
  }

  /** Whether the pooled connection for a host is marked broken (rebuild decision). */
  isBroken(alias: string): boolean {
    return this.pool.get(alias)?.broken ?? false
  }

  /** Resolve (or reuse) the remote $HOME of a connection. */
  async resolveHome(alias: string): Promise<string | undefined> {
    const record = await this.ensureConnection(alias)
    if (record.home !== undefined) return record.home
    try {
      const home = await this.exec(alias, 'printf %s "$HOME"', { timeoutMs: 10_000 })
      record.home = home.stdout.trim() || undefined
    } catch {
      // Non-fatal: home stays undefined.
    }
    return record.home
  }

  /** The current IDE workspace status. */
  status(): WorkspaceStatus {
    const active = this.activeAlias === '' ? undefined : this.pool.get(this.activeAlias)
    return {
      state: this.state,
      alias: this.activeAlias,
      home: active?.home,
      cwd: active?.home,
      error: this.lastError,
      connectedAt: this.connectedAt,
    }
  }

  /** Cached remote $HOME of a host, if it has been resolved (sync read). */
  homeOf(alias: string): string | undefined {
    return this.pool.get(alias)?.home
  }

  /** Bind the IDE workspace to a host (connects on demand). */
  async connect(alias: string): Promise<WorkspaceStatus> {
    if (this.activeAlias !== '' && this.activeAlias !== alias) {
      // Only one workspace at a time; keep the old pooled connection alive
      // but unbind it.
      this.activeAlias = ''
      this.state = 'disconnected'
    }
    this.activeAlias = alias
    this.state = 'connecting'
    this.lastError = undefined
    try {
      const record = await this.ensureConnection(alias)
      this.state = 'connected'
      this.connectedAt = Date.now()
      if (record.home === undefined) {
        try {
          const home = await this.exec(alias, 'printf %s "$HOME"', { timeoutMs: 10_000 })
          record.home = home.stdout.trim() || undefined
        } catch {
          // Non-fatal: home stays undefined.
        }
      }
      return this.status()
    } catch (error) {
      this.state = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
      return this.status()
    }
  }

  /** Unbind the IDE workspace. */
  disconnect(): WorkspaceStatus {
    this.activeAlias = ''
    this.state = 'disconnected'
    this.connectedAt = undefined
    return this.status()
  }

  // ---------------------------------------------------------------- exec

  /**
   * Open a streaming exec channel without collection, timeouts, or exit-code
   * normalization. Data flows as soon as the channel resolves; listeners
   * registered later still receive every event because pre-resolution events
   * are buffered until the first listener appears.
   */
  async openChannel(alias: string, command: string, options?: { cwd?: string }): Promise<SshExecChannel> {
    const record = await this.ensureConnection(alias)
    record.inFlight += 1
    record.idleAt = Date.now()
    return await new Promise<SshExecChannel>((resolve, reject) => {
      const prefix = options?.cwd ? `cd ${quoteSh(options.cwd)} && ` : ''
      record.client.exec(prefix + command, (error, stream) => {
        if (error) {
          record.inFlight -= 1
          record.idleAt = Date.now()
          reject(error)
          return
        }
        const stdoutListeners: Array<(chunk: Buffer) => void> = []
        const stderrListeners: Array<(chunk: Buffer) => void> = []
        const closeListeners: Array<(code: number | null, signal: string | null) => void> = []
        const pending: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
        let pendingClose: readonly [number | null, string | null] | undefined
        const release = (): void => {
          record.inFlight -= 1
          record.idleAt = Date.now()
        }
        stream.on('data', (chunk: Buffer) => {
          if (stdoutListeners.length === 0) pending.stdout.push(chunk)
          else for (const listener of stdoutListeners) listener(chunk)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderrListeners.length === 0) pending.stderr.push(chunk)
          else for (const listener of stderrListeners) listener(chunk)
        })
        stream.on('close', (code: number | null, signal: string | null) => {
          release()
          if (closeListeners.length === 0) pendingClose = [code, signal]
          else for (const listener of closeListeners) listener(code, signal)
        })
        // A transport error surfaces through close; keep the stream safe from
        // an unhandled 'error' event.
        stream.on('error', () => {})
        resolve({
          onStdout(listener) {
            stdoutListeners.push(listener)
            if (pending.stdout.length > 0) {
              const buffered = pending.stdout.splice(0)
              for (const chunk of buffered) listener(chunk)
            }
          },
          onStderr(listener) {
            stderrListeners.push(listener)
            if (pending.stderr.length > 0) {
              const buffered = pending.stderr.splice(0)
              for (const chunk of buffered) listener(chunk)
            }
          },
          onClose(listener) {
            if (pendingClose !== undefined) {
              const [code, signal] = pendingClose
              pendingClose = undefined
              listener(code, signal)
              return
            }
            closeListeners.push(listener)
          },
          write(data) {
            if (!stream.destroyed) stream.write(data)
          },
          end() {
            if (!stream.destroyed && !stream.writableEnded) stream.end()
          },
          close() {
            stream.close()
          },
        })
      })
    })
  }

  /** Run one command on a host with a timeout and output caps. */
  async exec(alias: string, command: string, options?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
    const record = await this.ensureConnection(alias)
    const started = Date.now()
    const timeoutMs = options?.timeoutMs ?? this.opts.defaultExecTimeoutMs
    record.inFlight += 1
    record.idleAt = Date.now()
    try {
      return await new Promise<ExecResult>((resolve) => {
        const prefix = options?.cwd ? `cd ${quoteSh(options.cwd)} && ` : ''
        record.client.exec(prefix + command, (error, stream) => {
          if (error) {
            resolve({
              success: false,
              exitCode: null,
              timedOut: false,
              stdout: '',
              stderr: '',
              durationMs: Date.now() - started,
              error: error.message,
            })
            return
          }
          const stdout: { text: string; truncated: boolean } = { text: '', truncated: false }
          const stderr: { text: string; truncated: boolean } = { text: '', truncated: false }
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            stream.close()
          }, timeoutMs)
          stream.on('data', (chunk: Buffer) => appendOutput(stdout, chunk, this.opts.maxOutputBytes))
          stream.stderr.on('data', (chunk: Buffer) => appendOutput(stderr, chunk, this.opts.maxOutputBytes))
          stream.on('close', (code: number | null) => {
            clearTimeout(timer)
            resolve({
              success: !timedOut && (code === null || code === 0),
              exitCode: timedOut ? null : code,
              timedOut,
              stdout: stdout.text,
              stderr: stderr.text,
              durationMs: Date.now() - started,
            })
          })
          stream.on('error', () => {
            clearTimeout(timer)
            resolve({
              success: false,
              exitCode: null,
              timedOut,
              stdout: stdout.text,
              stderr: stderr.text,
              durationMs: Date.now() - started,
              error: 'channel error',
            })
          })
        })
      })
    } finally {
      record.inFlight -= 1
      record.idleAt = Date.now()
    }
  }

  // ---------------------------------------------------------------- shell

  /** Open a PTY shell on the active connection (WebSocket terminal). */
  async openShell(alias: string, cols: number, rows: number): Promise<ShellSession> {
    const record = await this.ensureConnection(alias)
    record.inFlight += 1
    record.idleAt = Date.now()
    return await new Promise<ShellSession>((resolve, reject) => {
      record.client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
        if (error) {
          record.inFlight -= 1
          reject(error)
          return
        }
        const session: ShellSession = {
          onData: undefined,
          onExit: undefined,
          send(data) {
            channel.write(data)
          },
          resize(c, r) {
            channel.setWindow(r, c, 0, 0)
          },
          pause() {
            channel.pause()
          },
          resume() {
            channel.resume()
          },
          close() {
            channel.close()
          },
        }
        // error 与 close 常先后双发——inFlight 只释放一次，否则会降到负数，
        // 让 sweep 误判连接空闲并在其他操作运行中将其断开。
        let released = false
        const release = (): void => {
          if (released) return
          released = true
          record.inFlight -= 1
          record.idleAt = Date.now()
        }
        channel.on('data', (chunk: Buffer) => session.onData?.(chunk))
        channel.on('close', () => {
          release()
          session.onExit?.(null)
        })
        channel.on('error', (error: Error) => {
          release()
          session.onExit?.(null, error.message)
        })
        resolve(session)
      })
    })
  }

  // ------------------------------------------------------------------ sftp

  /** Get (and lazily open) the SFTP subsystem of a connection. */
  async getSftp(alias: string): Promise<import('ssh2').SFTPWrapper> {
    const record = await this.ensureConnection(alias)
    if (record.sftp !== undefined) return record.sftp
    record.sftpReady ??= new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      record.client.sftp((error, sftp) => {
        if (error) {
          record.sftpReady = undefined
          reject(error)
          return
        }
        record.sftp = sftp
        resolve(sftp)
      })
    })
    return record.sftpReady
  }

  /** List a remote directory. */
  async ls(alias: string, path: string): Promise<RemoteDirEntry[]> {
    const sftp = await this.getSftp(alias)
    const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error) reject(error)
        else resolve(list)
      })
    })
    return entries
      .map((entry): RemoteDirEntry => {
        const mode = entry.attrs.mode
        const isDir = (mode & 0o170000) === 0o040000
        const isFile = (mode & 0o170000) === 0o100000
        return {
          name: entry.filename,
          type: isDir ? 'dir' : isFile ? 'file' : 'other',
          size: entry.attrs.size,
          mtimeMs: entry.attrs.mtime * 1000,
          mode,
        }
      })
      .sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
      })
  }

  /** Read a remote file into text (capped at maxReadBytes). */
  async readFile(alias: string, path: string): Promise<RemoteFileContent> {
    const sftp = await this.getSftp(alias)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(path, (error, stats) => {
        if (error) reject(error)
        else resolve(stats)
      })
    })
    if (stat.isDirectory()) throw new Error(`cannot read directory: ${path}`)
    const cap = this.opts.maxReadBytes
    const truncated = stat.size > cap
    // 超限文件只流式读取头部 cap 字节——整读入内存会让大日志/数据文件
    // 直接打爆宿主进程。
    const buffer = truncated
      ? await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const stream = sftp.createReadStream(path, { start: 0, end: cap - 1 })
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      })
      : await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(path, (error, data: Buffer) => {
          if (error) reject(error)
          else resolve(data)
        })
      })
    const slice = truncated ? buffer.subarray(0, cap) : buffer
    // Binary sniff: reject files with a NUL byte in the head (the editor is
    // text-only; binary files get a clear error instead of mojibake).
    const head = slice.subarray(0, 8192)
    if (head.includes(0)) {
      throw new Error(`binary file (${stat.size} bytes); preview is not supported`)
    }
    return {
      content: slice.toString('utf8'),
      truncated,
      size: stat.size,
      mtimeMs: stat.mtime * 1000,
    }
  }

  /** Write text to a remote file (missing parent directories are created). */
  async writeFile(alias: string, path: string, content: string): Promise<{ size: number; mtimeMs: number }> {
    const sftp = await this.getSftp(alias)
    const write = (): Promise<void> => new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, Buffer.from(content, 'utf8'), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    try {
      await write()
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      await this.mkdirParents(sftp, path)
      await write()
    }
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(path, (error, stats) => {
        if (error) reject(error)
        else resolve(stats)
      })
    })
    return { size: stat.size, mtimeMs: stat.mtime * 1000 }
  }

  /** Create the missing parent directories of a remote path (bottom-up scan). */
  private async mkdirParents(sftp: import('ssh2').SFTPWrapper, path: string): Promise<void> {
    let dir = posix.dirname(path)
    const missing: string[] = []
    while (dir !== '/' && dir !== '.' && dir !== '') {
      const exists = await new Promise<boolean>((resolve, reject) => {
        sftp.stat(dir, (error) => {
          if (error === undefined || error === null) resolve(true)
          else if (isMissingPathError(error)) resolve(false)
          else reject(error)
        })
      })
      if (exists) break
      missing.push(dir)
      dir = posix.dirname(dir)
    }
    for (const target of missing.reverse()) {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(target, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }

  /** Create a remote directory (recursively via mkdir -p fallback). */
  async mkdir(alias: string, path: string): Promise<void> {
    const sftp = await this.getSftp(alias)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /** Remove a remote file or empty directory. */
  async remove(alias: string, path: string): Promise<void> {
    const sftp = await this.getSftp(alias)
    await new Promise<void>((resolve, reject) => {
      sftp.stat(path, (statError, stats) => {
        if (statError) { reject(statError); return }
        const op = stats.isDirectory()
          ? (cb: (e: Error | null | undefined) => void) => sftp.rmdir(path, cb)
          : (cb: (e: Error | null | undefined) => void) => sftp.unlink(path, cb)
        op((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    })
  }

  /** Rename or move a remote path. */
  async rename(alias: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(alias)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  // ----------------------------------------------------------------- sweep

  /** Close idle connections (keeps the active one and pinned ones). */
  private sweep(): void {
    const now = Date.now()
    for (const [alias, record] of this.pool) {
      if (record.inFlight > 0) continue
      if (alias === this.activeAlias) continue
      if (now - record.idleAt < this.opts.idleTimeoutMs) continue
      this.dropConnection(alias)
    }
  }

  /** Tear down one pooled connection. */
  private dropConnection(alias: string): void {
    const record = this.pool.get(alias)
    if (record === undefined) return
    this.pool.delete(alias)
    for (const hop of record.hops) {
      try { hop.end() } catch { /* already closed */ }
    }
    try { record.client.end() } catch { /* already closed */ }
  }

  /** Close every connection and stop the sweeper. */
  dispose(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    for (const alias of [...this.pool.keys()]) this.dropConnection(alias)
    this.activeAlias = ''
    this.state = 'disconnected'
  }
}

/** POSIX single-quote escaping for remote shell interpolation. */
export function quoteSh(value: string): string {
  return "'" + value.replace(/'/g, `'\\''`) + "'"
}

/** SFTP 错误的「路径不存在」判定（跨实现的错误消息匹配）。 */
function isMissingPathError(error: unknown): boolean {
  return /no such file|ENOENT|not found/i.test(error instanceof Error ? error.message : String(error))
}
