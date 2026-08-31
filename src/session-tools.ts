/**
 * dsh-remote-ide — 占位工作区会话的透明工具集（免 preset 的核心竞争力）。
 *
 * agent/created 钩子读会话 cwd：落在 ~/.dsh/remote/<hostId>/<b64> 下 → 在
 * agent scope 注册与官方同名的 bash / read / write / edit / glob / grep 遮蔽
 * 工具，execute 全部经共享 SshEngine 直接落在锚定主机上；配合 systemPrompt
 * 的动态段（按会话 cwd 求值）宣告远程身份。本地会话不注册任何东西，零影响。
 *
 * 设计约束：
 * - 参数名与官方 tool-fs / tool-bash 对齐（file_path / content / pattern /
 *   command…），模型无需学新接口；输出 schema 是我们自己的（更简单）。
 * - 所有输出过 jsonSafe —— 工具结果同样要过 lossless-JSON 校验。
 * - 钩子内任何异常都不得影响会话创建（整体 try/catch 吞掉）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExecResult } from './protocol'
import type { SshRuntime } from './ssh-service'
import { quoteSh } from './engine'
import { jsonSafe } from './jsonsafe'
import { resolveRemotePath, routeByCwd } from './workspace'

/** 一个远程会话的路由（钩子时确定，此后全部工具共用）。 */
export interface SessionRoute {
  /** 锚定主机 alias（占位路径第一段）。 */
  hostId: string
  /** 远程工作区绝对路径（占位编码的还原）。 */
  remoteCwd: string
  /** 本地占位目录（占位绝对路径重锚定的基准）。 */
  placeholderCwd: string
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 会话内路径解析：相对 → 远程 cwd 基准；本地占位绝对路径 → 重锚定回远程。 */
function resolveInSession(route: SessionRoute, requested: string): string {
  return resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd)
}

/** 渲染 exec 结果（与 ssh_exec 一致的退出码约定）。 */
function renderExec(result: ExecResult): string {
  const marker = result.timedOut ? '[timed out]' : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** 官方 read 的行号渲染（1-based 制表符分隔）。 */
function renderLines(path: string, offset: number, lines: Array<{ number: number; text: string }>, total: number): string {
  const body = lines.map((line) => `${String(line.number).padStart(6)}\t${line.text}`).join('\n')
  return `${path} (${lines.length}/${total} lines, from ${offset}):\n${body}`
}

/** presentResult 入形的最小形状（dsh-tools ToolResult 的结构子集）。 */
interface PresentedResult {
  content?: ReadonlyArray<{ type?: string; text?: string }>
  isError?: boolean
}

/** 取唯一文本块；非单文本/出错返回 undefined（软落到通用卡）。 */
function singleText(result: PresentedResult): string | undefined {
  if (result.isError === true) return undefined
  const only = result.content !== undefined && result.content.length === 1 ? result.content[0] : undefined
  if (only === undefined || only.type !== 'text') return undefined
  return only.text ?? ''
}

/**
 * bash 渲染文本 → terminal 视图。官方 UI 对名为 bash 的工具走 keyed BashRow，
 * 仅当宿主经 presentCall/presentResult 附上 terminal 视图时该行才可展开——
 * 缺视图则整行 inert（真机「bash 调用无法展开」的根因）。
 */
function bashTerminalView(result: PresentedResult): { card: 'terminal'; output: string; exitCode?: number } | undefined {
  const text = singleText(result)
  if (text === undefined) return undefined
  const kept = text.split('\n').filter((line) => !/^duration: \d+ ms$/.test(line))
  const exit = /^\[exit code: (\d+)\]$/.exec(kept[0] ?? '')
  const output = exit !== null || (kept[0] ?? '') === '[exit code: null]'
    ? kept.slice(1).join('\n')
    : kept.join('\n')
  return {
    card: 'terminal',
    output,
    ...(exit !== null ? { exitCode: Number(exit[1]) } : {}),
  }
}

/** read 渲染文本 → read 视图（keyed read 行同款：无视图不可展开）。 */
function readCardView(result: PresentedResult): {
  card: 'read'
  path: string
  offset: number
  lines: Array<{ number: number; text: string }>
  totalLines: number
  content: Array<{ type: 'text'; text: string }>
} | undefined {
  const text = singleText(result)
  if (text === undefined) return undefined
  const nl = text.indexOf('\n')
  const head = nl === -1 ? text : text.slice(0, nl)
  const match = /^(.*) \((\d+)\/(\d+) lines, from (\d+)\):$/.exec(head)
  if (match === null) return undefined
  const body = nl === -1 ? '' : text.slice(nl + 1)
  const offset = Number(match[4])
  return {
    card: 'read',
    path: match[1],
    offset,
    lines: body === '' ? [] : body.split('\n').map((line, i) => ({ number: offset + i, text: line })),
    totalLines: Number(match[3]),
    content: [{ type: 'text', text: body }],
  }
}

/** 简单 glob → RegExp（支持 **、*、?；其余字符按字面量）。 */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += '\\' + char
    } else {
      source += char
    }
  }
  return new RegExp('^' + source + '$')
}

/** 无 "/" 的 pattern 匹配任意深度的 basename（与官方 glob 语义一致）。 */
function matchGlob(regexp: RegExp, pattern: string, relative: string): boolean {
  if (!pattern.includes('/')) return regexp.test(relative.split('/').pop() ?? '')
  return regexp.test(relative)
}

/** 构建一个远程会话的遮蔽工具集（bash/read/write/edit/glob/grep）。 */
export function buildSessionTools(runtime: SshRuntime, route: SessionRoute) {
  const engine = runtime.engine

  const bashTool = defineTool({
    name: 'bash',
    description: 'Run a bash command on the remote server (this session\'s workspace host) and return stdout/stderr/exit code.',
    parameters: {
      command: { type: 'string', description: 'The bash command to execute.', required: true },
      description: { type: 'string', description: 'Short active-voice description of what the command does (shown in the UI).', required: true },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
      workdir: { type: 'string', description: 'Working directory (relative paths resolve against the session remote workspace).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderExec(value as ExecResult)),
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
      ...(args.description !== undefined && args.description !== '' ? { description: args.description } : {}),
      ...(args.workdir !== undefined && args.workdir !== '' ? { cwd: args.workdir } : {}),
    }),
    presentResult: (_args, result) => bashTerminalView(result),
    async execute(args: { command: string; description?: string; timeoutMs?: number; workdir?: string }) {
      const cwd = args.workdir !== undefined && args.workdir !== '' ? resolveInSession(route, args.workdir) : route.remoteCwd
      const result = await engine.exec(route.hostId, args.command, { cwd, timeoutMs: args.timeoutMs })
      return jsonSafe({ ...result, exitCode: result.exitCode ?? undefined })
    },
  })

  const readTool = defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file on the remote server and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', description: 'Path to read (relative paths resolve against the remote workspace).', required: true },
      offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return. Defaults to 2000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          totalLines: { type: 'integer', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(renderLines(
        String(value.path), Number(value.offset),
        String(value.content).split('\n').map((line, i) => ({ number: Number(value.offset) + i, text: line })),
        Number(value.totalLines),
      )),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read ${args.file_path}`,
      kind: 'read',
      locations: [{ path: args.file_path, line: args.offset ?? 1 }],
    }),
    presentResult: (_args, result) => readCardView(result),
    async execute(args: { file_path: string; offset?: number; limit?: number }) {
      const path = resolveInSession(route, args.file_path)
      const file = await engine.readFile(route.hostId, path)
      const all = file.content.replace(/\n$/, '').split('\n')
      const offset = Math.max(1, Math.trunc(args.offset ?? 1))
      const limit = Math.max(1, Math.trunc(args.limit ?? 2000))
      const slice = all.slice(offset - 1, offset - 1 + limit)
      return jsonSafe({
        path,
        offset,
        totalLines: all.length,
        content: slice.join('\n'),
      })
    },
  })

  const writeTool = defineTool({
    name: 'write',
    description: 'Write full text content to a file on the remote server (overwrites; missing parent directories are created automatically).',
    parameters: {
      file_path: { type: 'string', description: 'Path to write (relative paths resolve against the remote workspace).', required: true },
      content: { type: 'string', description: 'Full UTF-8 text content to write.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          size: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(`wrote ${String(value.path)} (${String(value.size)} bytes)`),
    },
    async execute(args: { file_path: string; content: string }) {
      const path = resolveInSession(route, args.file_path)
      const stat = await engine.writeFile(route.hostId, path, args.content)
      return jsonSafe({ path, size: stat.size })
    },
  })

  const editTool = defineTool({
    name: 'edit',
    description: 'Exact string replacement in a remote file. old_string must appear exactly once unless replace_all is set.',
    parameters: {
      file_path: { type: 'string', description: 'Path to edit (relative paths resolve against the remote workspace).', required: true },
      old_string: { type: 'string', description: 'Exact text to replace.', required: true },
      new_string: { type: 'string', description: 'Replacement text.', required: true },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          replacements: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(`edited ${String(value.path)} (${String(value.replacements)} replacement(s))`),
    },
    async execute(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }) {
      if (args.old_string === '') throw new Error('old_string must be non-empty')
      const path = resolveInSession(route, args.file_path)
      const file = await engine.readFile(route.hostId, path)
      const occurrences = file.content.split(args.old_string).length - 1
      if (occurrences === 0) {
        throw new Error(`old_string not found in ${path}`)
      }
      if (occurrences > 1 && args.replace_all !== true) {
        throw new Error(`old_string appears ${occurrences} times in ${path}; provide more surrounding context or set replace_all`)
      }
      const next = args.replace_all === true
        ? file.content.split(args.old_string).join(args.new_string)
        : file.content.replace(args.old_string, args.new_string)
      await engine.writeFile(route.hostId, path, next)
      return jsonSafe({ path, replacements: occurrences })
    },
  })

  const globTool = defineTool({
    name: 'glob',
    description: 'Find files on the remote server by glob pattern (e.g. "**/*.ts"). A pattern with no "/" matches basenames at any depth.',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "*.md".', required: true },
      path: { type: 'string', description: 'Directory to search (defaults to the remote workspace).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', required: true },
          path: { type: 'string', required: true },
          matches: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text(`${String(value.pattern)} — ${value.matches.length} match(es) under ${String(value.path)}${value.truncated ? ' (truncated)' : ''}:\n${(value.matches as string[]).join('\n')}`),
    },
    async execute(args: { pattern: string; path?: string }) {
      const base = resolveInSession(route, args.path ?? '.')
      const result = await engine.exec(route.hostId, `find ${quoteSh(base)} -type f -print 2>/dev/null | head -n 20000`, { timeoutMs: 30_000 })
      const regexp = globToRegExp(args.pattern)
      const prefix = base === '/' ? '' : base + '/'
      const matches: string[] = []
      let truncated = false
      for (const line of result.stdout.split('\n')) {
        const absolute = line.replace(/\r$/, '')
        if (absolute === '') continue
        const relative = absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute
        if (!matchGlob(regexp, args.pattern, relative)) continue
        if (matches.length >= 2000) { truncated = true; break }
        matches.push(absolute)
      }
      return jsonSafe({ pattern: args.pattern, path: base, matches, truncated })
    },
  })

  const grepTool = defineTool({
    name: 'grep',
    description: 'Search file contents on the remote server with a regex (recursive, skips binary files).',
    parameters: {
      pattern: { type: 'string', description: 'Regular expression (POSIX extended) to search for.', required: true },
      path: { type: 'string', description: 'Directory or file to search (defaults to the remote workspace).' },
      include: { type: 'string', description: 'Glob filter for file names, e.g. "*.ts".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', required: true },
          path: { type: 'string', required: true },
          matches: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text(`${String(value.pattern)} — ${value.matches.length} match(es) under ${String(value.path)}${value.truncated ? ' (truncated)' : ''}:\n${(value.matches as string[]).join('\n')}`),
    },
    async execute(args: { pattern: string; path?: string; include?: string }) {
      const base = resolveInSession(route, args.path ?? '.')
      const includeArg = args.include !== undefined && args.include !== '' ? ` --include=${quoteSh(args.include)}` : ''
      const command = `grep -rInE ${includeArg} -e ${quoteSh(args.pattern)} ${quoteSh(base)} 2>/dev/null | head -n 500`
      const result = await engine.exec(route.hostId, command, { timeoutMs: 30_000 })
      const lines = result.stdout.split('\n').filter((line) => line !== '')
      const truncated = lines.length >= 500
      return jsonSafe({ pattern: args.pattern, path: base, matches: lines, truncated })
    },
  })

  return [bashTool, readTool, writeTool, editTool, globTool, grepTool]
}

/** 会话动态 prompt 段文本（cwd 非占位时返回空串 = 本地会话零注入）。 */
export function sessionSectionText(cwd: string | undefined): string {
  const route = routeByCwd(cwd)
  if (route.kind !== 'remote') return ''
  return [
    '## Remote workspace session',
    `This session's workspace is a remote directory: ${route.remoteCwd} on host "${route.hostId}" (connected over SSH).`,
    'Your bash/read/write/edit/glob/grep tools execute on that server; relative paths resolve against the remote directory. Treat the server as your working machine.',
    'The ssh_exec/ssh_ls/ssh_read/ssh_write tools also target this host automatically (their alias parameter is optional here).',
    'The plugin configuration lives on the DSH host machine, not on the server — do not look for it there.',
  ].join('\n')
}

/** agent/created 订阅的最小形状（避免依赖 dsh-agent 类型）。 */
interface AgentLike {
  session?: { header?: { cwd?: string } }
  ctx?: Context
}

/** 轻量文件诊断日志（scope.logger 不落盘，钩子链路必须自己留痕）。超上限重置文件，避免无限增长。 */
const DEBUG_LOG_LIMIT = 512 * 1024
let debugLogBytes = -1
function debugLog(message: string): void {
  try {
    const file = join(homedir(), '.dsh', 'dsh-remote-ide-debug.log')
    const line = `${new Date().toISOString()} ${message}\n`
    if (debugLogBytes < 0) {
      try { debugLogBytes = statSync(file).size } catch { debugLogBytes = 0 }
    }
    if (debugLogBytes > DEBUG_LOG_LIMIT) {
      writeFileSync(file, line, 'utf8')
      debugLogBytes = Buffer.byteLength(line)
      return
    }
    appendFileSync(file, line, 'utf8')
    debugLogBytes += Buffer.byteLength(line)
  } catch { /* 诊断日志绝不影响主流程 */ }
}

/**
 * 安装会话路由：agent/created 看会话 cwd，占位会话在 agent scope 注册遮蔽
 * 工具。订阅走 cordis 事件总线 **ctx.on(...)**（AgentRegistry 服务上没有
 * on 方法——之前误用 agents.on 被防御分支静默跳过，钩子从未生效）。
 * 任何异常都不得影响会话创建——整体吞掉（最坏情况 = 该会话没有远程工具，
 * 回退 ssh_* 显式工具）。
 *
 * ⚠️ 遮蔽工具只允许注册进 payload.agent.ctx（agent 作用域）。缺失时绝不
 * 退回插件级 ctx——那会让 bash/read 等在全局（含本地会话）遮蔽官方工具。
 */
export function installSessionRouting(ctx: Context, runtime: SshRuntime, isEnabled?: () => boolean): void {
  const emitter = ctx as unknown as {
    on?: (event: string, listener: (payload: { agent: AgentLike }) => void) => unknown
  }
  if (typeof emitter.on !== 'function') {
    debugLog('ctx.on unavailable — session routing disabled')
    return
  }
  const onEvent = emitter.on.bind(emitter)
  ctx.effect(
    () => {
      debugLog('session routing installed (agent/created)')
      const listener = (payload: { agent: AgentLike }): void => {
        try {
          if (isEnabled !== undefined && !isEnabled()) return
          const cwd = payload?.agent?.session?.header?.cwd
          const route = routeByCwd(cwd)
          debugLog(`agent/created: cwd=${cwd ?? '(none)'} → ${route.kind}`)
          if (route.kind !== 'remote') return
          const scope = (payload.agent as { ctx?: Context } | undefined)?.ctx
          if (scope === undefined || scope === ctx) {
            debugLog('agent/created: agent scope unavailable — shadow tools skipped (never register globally)')
            return
          }
          const sessionRoute: SessionRoute = {
            hostId: route.hostId,
            remoteCwd: route.remoteCwd,
            placeholderCwd: cwd ?? '',
          }
          let registered = 0
          for (const tool of buildSessionTools(runtime, sessionRoute)) {
            try {
              scope.tools.register(tool)
              registered += 1
            } catch (error) {
              // 同名遮蔽被拒（如 registry 不允许覆盖）只影响该会话的透明度，
              // 记录后继续注册其余工具。
              debugLog(`shadow register failed for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          // 激活激活连接（切 activeAlias）：ssh_exec/ssh_ls 等全局 ssh_* 工具的
          // 无别名回退读 activeAlias——不切会让同一会话的 ssh_* 全部报
          // "no alias given"。connect 幂等（同池去重），失败由工具调用兜底。
          void runtime.connect(route.hostId).catch((error) => {
            debugLog(`connect ${route.hostId} failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          debugLog(`remote session routed: ${cwd} → ${route.hostId}:${route.remoteCwd} (${registered} shadow tools)`)
        } catch (error) {
          // 路由失败绝不阻塞会话创建。
          debugLog(`session routing skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const dispose = onEvent('agent/created', listener)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    'dsh-remote-ide: session routing',
  )
}
