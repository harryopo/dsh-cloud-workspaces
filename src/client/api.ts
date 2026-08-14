/**
 * Browser-half API client for /api/dsh-remote-ide. Thin fetch wrappers plus
 * a WebSocket terminal factory. All responses follow the route contracts in
 * src/routes.ts; errors surface as Error with the server message.
 */

import {
  REMOTE_API,
  type ConnectionState,
  type ExecResult,
  type HostPayload,
  type ImportResult,
  type RemoteDirEntry,
  type RemoteFileContent,
  type SshHostSummary,
  type TestResult,
  type WorkspaceStatus,
} from '../protocol'

/** JSON body helper with error extraction. */
async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const parsed = await response.json() as { error?: string }
      if (typeof parsed.error === 'string' && parsed.error !== '') message = parsed.error
    } catch {
      // Non-JSON error body: keep the status message.
    }
    throw new Error(message)
  }
  return await response.json() as T
}

export interface HostsResponse { hosts: SshHostSummary[] }
export interface HostResponse { host: SshHostSummary }
export interface TestResponse { result: TestResult }
export interface ImportResponse { result: ImportResult }
export interface StatusResponse { status: WorkspaceStatus }
export interface ListResponse { entries: RemoteDirEntry[] }
export interface ReadResponse { file: RemoteFileContent }
export interface WriteResponse { file: { size: number; mtimeMs: number } }
export interface ExecResponse { result: ExecResult }
export interface OkResponse { ok: boolean }

/** The remote-IDE API surface. */
export class RemoteIdeApi {
  // ----------------------------------------------------------------- hosts
  async listHosts(query?: string): Promise<SshHostSummary[]> {
    const url = query === undefined || query === ''
      ? REMOTE_API.hosts
      : `${REMOTE_API.hosts}?query=${encodeURIComponent(query)}`
    const data = await call<HostsResponse>(url, 'GET')
    return data.hosts
  }

  async createHost(payload: HostPayload): Promise<SshHostSummary> {
    const data = await call<HostResponse>(REMOTE_API.hosts, 'POST', payload)
    return data.host
  }

  async updateHost(alias: string, payload: Partial<HostPayload>): Promise<SshHostSummary> {
    const data = await call<HostResponse>(`${REMOTE_API.hosts}?alias=${encodeURIComponent(alias)}`, 'PATCH', payload)
    return data.host
  }

  async deleteHost(alias: string): Promise<boolean> {
    const data = await call<OkResponse>(`${REMOTE_API.hosts}?alias=${encodeURIComponent(alias)}`, 'DELETE')
    return data.ok
  }

  async importSshConfig(): Promise<ImportResult> {
    const data = await call<ImportResponse>(REMOTE_API.importSshConfig, 'POST')
    return data.result
  }

  async test(alias: string): Promise<TestResult> {
    const data = await call<TestResponse>(REMOTE_API.test, 'POST', { alias })
    return data.result
  }

  // ------------------------------------------------------------ workspace
  async connect(alias: string): Promise<WorkspaceStatus> {
    const data = await call<StatusResponse>(REMOTE_API.connect, 'POST', { alias })
    return data.status
  }

  async disconnect(): Promise<WorkspaceStatus> {
    const data = await call<StatusResponse>(REMOTE_API.disconnect, 'POST')
    return data.status
  }

  async status(): Promise<WorkspaceStatus> {
    const data = await call<StatusResponse>(REMOTE_API.status, 'GET')
    return data.status
  }

  // ------------------------------------------------------------------- fs
  async ls(path: string, alias?: string): Promise<RemoteDirEntry[]> {
    const data = await call<ListResponse>(REMOTE_API.ls, 'POST', { path, alias })
    return data.entries
  }

  async readFile(path: string, alias?: string): Promise<RemoteFileContent> {
    const data = await call<ReadResponse>(REMOTE_API.read, 'POST', { path, alias })
    return data.file
  }

  async writeFile(path: string, content: string, alias?: string): Promise<{ size: number; mtimeMs: number }> {
    const data = await call<WriteResponse>(REMOTE_API.write, 'POST', { path, content, alias })
    return data.file
  }

  async mkdir(path: string): Promise<void> {
    await call<OkResponse>(REMOTE_API.mkdir, 'POST', { path })
  }

  async remove(path: string): Promise<void> {
    await call<OkResponse>(REMOTE_API.remove, 'POST', { path })
  }

  async rename(from: string, to: string): Promise<void> {
    await call<OkResponse>(REMOTE_API.rename, 'POST', { from, to })
  }

  // ----------------------------------------------------------------- exec
  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const data = await call<ExecResponse>(REMOTE_API.exec, 'POST', { alias, command, timeoutMs })
    return data.result
  }

  // -------------------------------------------------------------- terminal
  /**
   * Open a WebSocket terminal to the remote shell. Returns the socket plus a
   * helper that resolves once the host confirms the shell is ready (or the
   * socket closes with an error).
   */
  openTerminal(alias: string, cols: number, rows: number): WebSocket {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${window.location.host}${REMOTE_API.terminal}?alias=${encodeURIComponent(alias)}&cols=${cols}&rows=${rows}`
    return new WebSocket(url)
  }
}

/** Poll the workspace status every interval; returns an unsubscribe. */
export function pollStatus(api: RemoteIdeApi, intervalMs: number, onChange: (status: WorkspaceStatus) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      onChange(await api.status())
    } catch {
      // Transient polling failure: keep going.
    }
    timer = setTimeout(tick, intervalMs)
  }
  void tick()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Connection-state label helper (client-side copy of the enum). */
export function connectionStateLabel(state: ConnectionState): string {
  return state
}
