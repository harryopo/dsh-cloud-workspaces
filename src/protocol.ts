/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/** Authentication flavors a host entry may carry. */
export type SshAuthKind = 'key' | 'password'

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
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface SshHostSummary {
  alias: string
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

/** One directory listing entry (remote file browser). */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  mode?: number
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
