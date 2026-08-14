/**
 * The /api/dsh-remote-ide route family: host CRUD, workspace connect /
 * disconnect / status, remote fs (ls / read / write / mkdir / remove /
 * rename), exec, and the WebSocket PTY terminal upgrade. Every route
 * carries a loopback-only trust fence — these endpoints execute commands on
 * remote servers, so LAN-exposed dsh web deployments must not serve them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { WebSocket, WebSocketServer } from 'ws'
import type { SshEngine, ShellSession } from './engine'
import {
  REMOTE_API,
  type HostPayload,
  type TerminalClientFrame,
  type TerminalServerFrame,
} from './protocol'
import type { HostStore } from './store'

/** Cap on small JSON request bodies (host entries, exec payloads). */
const MAX_JSON_BODY_BYTES = 64 * 1024
/** Cap on file-write bodies (the remote editor save path). */
const MAX_WRITE_BODY_BYTES = 8 * 1024 * 1024

/** One noServer WebSocket server for terminal upgrades. */
const terminalWss = new WebSocketServer({ noServer: true })

/** Pause the shell when the socket's send buffer exceeds this… */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024
/** …and resume once it drains below this. */
const BACKPRESSURE_LOW_WATER = 512 * 1024

/** Loopback literal check plus browser same-origin markers. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body with a byte cap (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Route family dependencies. */
export interface RemoteRoutesDeps {
  store: HostStore
  engine: SshEngine
}

/**
 * Build every /api/dsh-remote-ide route (exact paths) plus the terminal
 * upgrade.
 */
export function makeRoutes(deps: RemoteRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute } {
  const { store, engine } = deps

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** Require a string body field. */
  const bodyString = (body: Record<string, unknown> | undefined, name: string): string => {
    const value = body?.[name]
    return typeof value === 'string' ? value : ''
  }

  const routes: WebRoute[] = [
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: REMOTE_API.hosts,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = engine.upsertHost(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = engine.upsertHost(body as unknown as HostPayload, alias)
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          try {
            const removed = engine.removeHost(alias)
            writeJson(res, 200, { ok: removed })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { result: engine.importSshConfig() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // -------------------------------------------------------------- test
    {
      kind: 'exact',
      path: REMOTE_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = bodyString(body, 'alias')
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, { result: await engine.test(alias) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------------- workspace
    {
      kind: 'exact',
      path: REMOTE_API.connect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = bodyString(body, 'alias')
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, { status: await engine.connect(alias) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.disconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        writeJson(res, 200, { status: engine.disconnect() })
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { status: engine.status() })
      },
    },
    // ---------------------------------------------------------------- fs
    {
      kind: 'exact',
      path: REMOTE_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const path = bodyString(body, 'path')
        if (path === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        const alias = bodyString(body, 'alias')
        try {
          const activeAlias = alias === '' ? engine.status().alias : alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          writeJson(res, 200, { entries: await engine.ls(activeAlias, path) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.read,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const path = bodyString(body, 'path')
        if (path === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        const alias = bodyString(body, 'alias')
        try {
          const activeAlias = alias === '' ? engine.status().alias : alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          writeJson(res, 200, { file: await engine.readFile(activeAlias, path) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.write,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_WRITE_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body (too large or unparseable)' })
          return
        }
        const path = bodyString(body, 'path')
        const content = bodyString(body, 'content')
        if (path === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        const alias = bodyString(body, 'alias')
        try {
          const activeAlias = alias === '' ? engine.status().alias : alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          writeJson(res, 200, { file: await engine.writeFile(activeAlias, path, content) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.mkdir,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const path = bodyString(body, 'path')
        if (path === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        try {
          const activeAlias = engine.status().alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          await engine.mkdir(activeAlias, path)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const path = bodyString(body, 'path')
        if (path === '') {
          writeJson(res, 400, { error: 'path is required' })
          return
        }
        try {
          const activeAlias = engine.status().alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          await engine.remove(activeAlias, path)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: REMOTE_API.rename,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const from = bodyString(body, 'from')
        const to = bodyString(body, 'to')
        if (from === '' || to === '') {
          writeJson(res, 400, { error: 'from and to are required' })
          return
        }
        try {
          const activeAlias = engine.status().alias
          if (activeAlias === '') {
            writeJson(res, 409, { error: 'no active connection' })
            return
          }
          await engine.rename(activeAlias, from, to)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // -------------------------------------------------------------- exec
    {
      kind: 'exact',
      path: REMOTE_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = bodyString(body, 'alias')
        const command = bodyString(body, 'command')
        if (alias === '' || command === '') {
          writeJson(res, 400, { error: 'alias and command are required' })
          return
        }
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        try {
          writeJson(res, 200, { result: await engine.exec(alias, command, { timeoutMs }) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  // ---------------------------------------------- terminal (upgrade)
  const upgrade: WebUpgradeRoute = {
    path: REMOTE_API.terminal,
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      if (alias === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        let session: ShellSession | undefined
        let closed = false
        let paused = false
        // Input received before the shell is ready is buffered and flushed
        // once openShell resolves (a fast typist must not lose keystrokes).
        const pendingInput: string[] = []
        let pendingResizes: Array<{ cols: number; rows: number }> = []
        const flushPending = (): void => {
          if (session === undefined) return
          for (const chunk of pendingInput.splice(0)) session.send(chunk)
          for (const resize of pendingResizes.splice(0)) session.resize(resize.cols, resize.rows)
        }
        const resume = (): void => {
          if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) {
            paused = false
            session?.resume?.()
          }
        }
        const sendFrame = (frame: TerminalServerFrame): void => {
          if (closed || ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify(frame), resume)
          if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
            paused = true
            session?.pause?.()
          }
        }
        const closeSession = (): void => {
          const opened = session
          session = undefined
          if (opened !== undefined) opened.close()
        }
        engine.openShell(alias, Number.isFinite(cols) ? cols : 80, Number.isFinite(rows) ? rows : 24)
          .then((opened) => {
            if (ws.readyState !== WebSocket.OPEN) {
              opened.close()
              return
            }
            session = opened
            sendFrame({ type: 'ready', alias, cwd: engine.status().cwd ?? '' })
            opened.onData = (data) => sendFrame({ type: 'output', data: data.toString('utf8') })
            opened.onExit = (code, error) => {
              sendFrame({ type: 'exit', code, error })
              closed = true
              try { ws.close(1000) } catch { /* already closed */ }
            }
            flushPending()
          })
          .catch((error) => {
            sendFrame({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
            closed = true
            try { ws.close(1000) } catch { /* already closed */ }
          })
        ws.on('message', (data) => {
          let frame: TerminalClientFrame
          try {
            frame = JSON.parse(String(data)) as TerminalClientFrame
          } catch {
            return
          }
          if (frame.type === 'input') {
            if (session !== undefined) session.send(frame.data)
            else pendingInput.push(frame.data)
          } else if (frame.type === 'resize') {
            if (session !== undefined) session.resize(Math.max(2, frame.cols), Math.max(1, frame.rows))
            else pendingResizes.push({ cols: Math.max(2, frame.cols), rows: Math.max(1, frame.rows) })
          }
        })
        ws.on('close', () => {
          closed = true
          closeSession()
        })
        ws.on('error', () => {
          closed = true
          closeSession()
        })
      })
    },
  }

  return { routes, upgrade }
}
