/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/** Authentication flavors a host entry may carry. */
export type SshAuthKind = 'key' | 'password'

/** Trusted server host key (trust-on-first-use, recorded on the first connect). */
export interface SshHostKeyTrust {
  /** OpenSSH-style SHA256 fingerprint, e.g. `SHA256:AbCd...` (base64, no padding). */
  fingerprint: string
  /** When the fingerprint was first recorded (ms since epoch). */
  recordedAt: number
}

/** One stored host entry (the ~/.dsh/dsh-remote-ide.json store shape). */
export interface SshHostEntry {
  /** Stable, user-chosen identifier used by every operation. */
  alias: string
  /** Hostname or IP of the target. */
  host: string
  /** SSH port (default 22). */
  port: number
  /** Login user. */
  user: string
  /** Authentication. */
  auth: {
    kind: SshAuthKind
    /** Absolute path to the private key for 'key' auth. */
    keyPath?: string
    /** Passphrase for an encrypted key. */
    passphrase?: string
    /** Password for 'password' auth. */
    password?: string
  }
  /** Jump chain: local aliases connected through in order (ProxyJump). */
  proxyJump: string[]
  /** Free-form note. */
  description?: string
  /** Deployment environment label (development / production / ...). */
  environment?: string
  /** Free-form tags. */
  tags: string[]
  /** Trusted server host key (TOFU). Absent until the first connect. */
  hostKey?: SshHostKeyTrust
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface SshHostSummary {  alias: string
  host: string
  port: number
  user: string
  auth: SshAuthKind
  /** Whether the key path exists on the host machine (key auth only). */
  keyReady: boolean
  proxyJump: string[]
  description?: string
  environment?: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** 设置卡片/工具面共用的一台 SSH 主机（口令 write-only，永不出 store）。 */
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
  /** 私钥路径（key 认证）。 */
  privateKeyPath?: string
  /** 口令（password 认证；来自 0600 store，脱敏后不回传）。 */
  password?: string
  /** 跳板链（ProxyJump）：本地别名按序穿过。 */
  proxyJump?: string[]
  /** 备注。 */
  description?: string
}

/** Host edit payload (create/update); 'alias' comes from the URL for updates. */
export interface HostPayload {
  alias?: string
  host: string
  port?: number
  user: string
  /** Authentication. Required on create; on update an omitted auth keeps the
   *  stored secrets (the browser never receives them back). */
  auth?: SshHostEntry['auth']
  proxyJump?: string[]
  description?: string
  environment?: string
  tags?: string[]
}

/** Import outcome from ~/.ssh/config. */
export interface ImportResult {
  parsed: number
  added: number
  skipped: number
  skippedNames: string[]
}

/** Test-connection outcome. */
export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** One live local port forward (`127.0.0.1:localPort → remoteHost:remotePort`). */
export interface RemoteTunnel {
  id: string
  hostId: string
  localHost: '127.0.0.1'
  localPort: number
  remoteHost: string
  remotePort: number
  createdAt: number
}

/** One directory listing entry (remote file browser). */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  /** Raw POSIX mode from SFTP attrs. Always set by engine.ls. */
  mode: number
}

/** Remote file read result (editor open). */
export interface RemoteFileContent {
  content: string
  /** True when the file was truncated to maxReadBytes. */
  truncated: boolean
  size: number
  mtimeMs: number
}

/** Result of one non-interactive command execution. */
export interface ExecResult {
  success: boolean
  /** Remote exit code, or null when the channel died without one. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

/** Connection lifecycle state of the active IDE connection. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

/** Full status snapshot of the remote IDE workspace. */
export interface WorkspaceStatus {
  state: ConnectionState
  /** Alias of the active connection ('' when disconnected). */
  alias: string
  /** Remote $HOME when connected. */
  home?: string
  /** Remote cwd when connected. */
  cwd?: string
  /** Human-readable error of the last failed attempt. */
  error?: string
  connectedAt?: number
}

/** WebSocket terminal protocol frames (host -> client and client -> host). */
export type TerminalServerFrame =
  | { type: 'ready'; alias: string; cwd: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null; error?: string }

export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/** Route paths the client calls (shared literals). */
export const REMOTE_API_BASE = '/api/dsh-remote-ide' as const

export const REMOTE_API = {
  hosts: REMOTE_API_BASE + '/hosts',
  importSshConfig: REMOTE_API_BASE + '/hosts/import-ssh-config',
  test: REMOTE_API_BASE + '/test',
  connect: REMOTE_API_BASE + '/connect',
  disconnect: REMOTE_API_BASE + '/disconnect',
  status: REMOTE_API_BASE + '/status',
  ls: REMOTE_API_BASE + '/fs/ls',
  read: REMOTE_API_BASE + '/fs/read',
  write: REMOTE_API_BASE + '/fs/write',
  mkdir: REMOTE_API_BASE + '/fs/mkdir',
  remove: REMOTE_API_BASE + '/fs/remove',
  rename: REMOTE_API_BASE + '/fs/rename',
  exec: REMOTE_API_BASE + '/exec',
  terminal: REMOTE_API_BASE + '/terminal',
} as const
