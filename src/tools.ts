/**
 * Remote-development agent tools: the model's hands on the connected Linux
 * server (ssh_list / ssh_exec / ssh_ls / ssh_read / ssh_write / ssh_workspace).
 * Registered globally by the host half; cloud-workspace sessions additionally
 * get same-name shadow tools (session-tools) routed by the session cwd.
 *
 * The tools consume the shared SshRuntime (ctx.ssh, host plane): one engine
 * serves the tools and the legacy preset-scoped adapters (fs-ssh /
 * subprocess-ssh), so a connection established by one is visible to the others.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ExecResult, RemoteDirEntry, SshHostSummary } from './protocol'
import type { SshRuntime } from './ssh-service'
import { createPlaceholderDir, listPlaceholders } from './workspace'
import { jsonSafe } from './jsonsafe'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Host row subset the output schema models (the engine reports more). */
type HostRow = Pick<SshHostSummary,
  'alias' | 'host' | 'port' | 'user' | 'auth' | 'keyReady' | 'proxyJump' | 'tags' | 'description' | 'environment'>

/** Host table render shared by list surfaces. */
function renderHosts(hosts: readonly HostRow[]): string {
  if (hosts.length === 0) return 'no hosts configured — run ssh_list and ask the user to add one in the panel, or add via ssh_config'
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    host.user,
    host.auth,
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: { success: boolean; exitCode?: number | null; timedOut: boolean; stdout: string; stderr: string; durationMs: number; error?: string }): string {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Render one directory listing. */
function renderEntries(entries: RemoteDirEntry[]): string {
  if (entries.length === 0) return '(empty directory)'
  const rows = entries.map(e => [
    e.type === 'dir' ? 'd' : e.type === 'file' ? '-' : '?',
    String(e.size),
    e.name,
  ].join('\t'))
  return ['type\tsize\tname', ...rows].join('\n')
}

/** Resolve the target alias: explicit wins, else the active connection. */
function resolveAlias(runtime: SshRuntime, alias: string | undefined): string {
  const explicit = alias?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const active = runtime.engine.status().alias
  if (active !== '') return active
  throw new Error('no alias given and no active connection — pick one from ssh_list')
}

/** The host-list tool. */
export function sshListTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_list',
    description: 'List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias. ' +
      'Triggers: SSH, remote server, server IP/hostname, connect/login, check server/status, deploy, upload/download, jump host.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password'], required: true },
                keyReady: { type: 'boolean', required: true },
                proxyJump: { type: 'array', items: { type: 'string' }, required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
          total: { type: 'integer', required: true, description: 'All configured hosts count (before query filter).' },
        },
      },
      render: (args, value) => {
        if (value.hosts.length === 0) {
          const query = (args as { query?: string }).query?.trim() ?? ''
          if (value.total > 0 && query !== '') {
            return text(`no hosts match query "${query}" — call ssh_list without query to see all ${value.total} host(s)`)
          }
          return text('no hosts configured — ask the user to add one in the DSH settings panel (设置 → SSH 连接), or place an entry in ~/.ssh/config on the DSH host and call ssh_list again to import')
        }
        return text(renderHosts(value.hosts))
      },
    },
    async execute(args: { query?: string }) {
      // createdAt/updatedAt 对模型无价值且 output schema 未声明
      // （additionalProperties: false 会拒绝）——显式剥离。
      const hosts = runtime.engine.list(args.query).map((host) => ({
        alias: host.alias,
        host: host.host,
        port: host.port,
        user: host.user,
        auth: host.auth,
        keyReady: host.keyReady,
        proxyJump: host.proxyJump,
        description: host.description,
        environment: host.environment,
        tags: host.tags,
      }))
      return {
        hosts: jsonSafe(hosts),
        total: runtime.engine.list().length,
      }
    },
  })
}

/** Run a shell command on the remote server. */
export function sshExecTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_exec',
    description: 'Run a shell command on the remote Linux server over SSH and return stdout/stderr/exit code. ' +
      'This is the model\'s shell on the server: use it for building, installing toolchains (apt/npm/pip), running tests, ' +
      'inspecting processes, and any other server-side work. The server is Linux; POSIX shell syntax applies. ' +
      'Triggers: run a command on the server, deploy, build, test on remote, install packages, check server state.',
    parameters: {
      command: { type: 'string', description: 'The shell command to run (POSIX sh).', required: true },
      alias: { type: 'string', description: 'Host alias from ssh_list. Defaults to the active connection.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 60000).' },
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
      render: (_args, value) => text(renderExec(value)),
    },
    async execute(args: { command: string; alias?: string; timeoutMs?: number }) {
      const alias = resolveAlias(runtime, args.alias)
      const result = await runtime.engine.exec(alias, args.command, { timeoutMs: args.timeoutMs })
      // The output schema models exitCode as optional (undefined when the
      // channel died without one); the engine reports null for that case.
      // jsonSafe strips the undefined own-key — lossless-JSON validation
      // rejects explicit undefined values.
      return jsonSafe({ ...result, exitCode: result.exitCode ?? undefined })
    },
  })
}

/** List a remote directory. */
export function sshLsTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_ls',
    description: 'List a directory on the remote server (entries sorted: directories first, then files, alphabetically). ' +
      'Use before reading or writing files to locate paths. Triggers: browse the server, list remote directory, find files on the server.',
    parameters: {
      path: { type: 'string', description: 'Remote directory path, e.g. /home/user or /var/www.', required: true },
      alias: { type: 'string', description: 'Host alias from ssh_list. Defaults to the active connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', enum: ['dir', 'file', 'other'], required: true },
                size: { type: 'integer', required: true },
                mtimeMs: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(`${value.path}:\n${renderEntries(value.entries)}`),
    },
    async execute(args: { path: string; alias?: string }) {
      const alias = resolveAlias(runtime, args.alias)
      return jsonSafe({ path: args.path, entries: await runtime.engine.ls(alias, args.path) })
    },
  })
}

/** Read a remote file (text, capped at 2 MiB). */
export function sshReadTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_read',
    description: 'Read a text file on the remote server over SFTP and return its content (cap: 2 MiB; binary files are refused). ' +
      'Use to inspect server-side code, configs, and logs. Triggers: read a file on the server, view remote config, cat a remote file.',
    parameters: {
      path: { type: 'string', description: 'Remote file path.', required: true },
      alias: { type: 'string', description: 'Host alias from ssh_list. Defaults to the active connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          size: { type: 'integer', required: true },
          mtimeMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(value.truncated
        ? `${value.path} (${value.size} bytes, truncated to 2 MiB):\n${value.content}`
        : `${value.path} (${value.size} bytes):\n${value.content}`),
    },
    async execute(args: { path: string; alias?: string }) {
      const alias = resolveAlias(runtime, args.alias)
      const file = await runtime.engine.readFile(alias, args.path)
      return jsonSafe({ path: args.path, ...file })
    },
  })
}

/** Write a remote file (text over SFTP). */
export function sshWriteTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_write',
    description: 'Write text content to a file on the remote server over SFTP (overwrites; missing parent directories are created automatically). ' +
      'Use for editing server-side code and configs. Triggers: edit a file on the server, save remote file, deploy a config.',
    parameters: {
      path: { type: 'string', description: 'Remote file path.', required: true },
      content: { type: 'string', description: 'Full file content to write.', required: true },
      alias: { type: 'string', description: 'Host alias from ssh_list. Defaults to the active connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          size: { type: 'integer', required: true },
          mtimeMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(`wrote ${value.path} (${value.size} bytes)`),
    },
    async execute(args: { path: string; content: string; alias?: string }) {
      const alias = resolveAlias(runtime, args.alias)
      const stat = await runtime.engine.writeFile(alias, args.path, args.content)
      return jsonSafe({ path: args.path, ...stat })
    },
  })
}

/** Create or list placeholder workspaces (a remote dir mapped to a local dir). */
export function sshWorkspaceTool(runtime: SshRuntime) {
  return defineTool({
    name: 'ssh_workspace',
    description: 'Bind a remote directory as a DSH workspace: create a local placeholder directory (~/.dsh/remote/<host>/<encoded>) ' +
      'the user can pick in the "select workspace" dialog; sessions started there run entirely on that host and directory ' +
      '(file tools, search, editor and terminals all target it). Also lists existing placeholder workspaces. ' +
      'Triggers: use a server directory as workspace, work on /path/on/server, which workspace, set up remote workspace.',
    parameters: {
      action: { type: 'string', enum: ['create', 'list'], description: 'create = bind a remote dir; list = show existing bindings.', required: true },
      host: { type: 'string', description: 'Host alias from ssh_list (required for create).' },
      path: { type: 'string', description: 'Absolute remote directory path, e.g. /home/user/project (required for create).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          localPath: { type: 'string' },
          host: { type: 'string' },
          remotePath: { type: 'string' },
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                host: { type: 'string', required: true },
                remotePath: { type: 'string', required: true },
                localPath: { type: 'string', required: true },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.action === 'list') {
          if (value.workspaces === undefined || value.workspaces.length === 0) {
            return text('no placeholder workspaces yet — call create with a host and an absolute remote path')
          }
          return text(['host | remotePath | localPath', '--- | --- | ---',
            ...value.workspaces.map(w => `${w.host} | ${w.remotePath} | ${w.localPath}`)].join('\n'))
        }
        return text(`placeholder workspace ready:\n  host: ${value.host}\n  remote: ${value.remotePath}\n  local: ${value.localPath}\n${value.hint ?? ''}`)
      },
    },
    async execute(args: { action: 'create' | 'list'; host?: string; path?: string }) {
      if (args.action === 'list') {
        const workspaces = await listPlaceholders()
        return jsonSafe({
          action: 'list' as const,
          workspaces: workspaces.map(w => ({ host: w.hostId, remotePath: w.remotePath, localPath: w.localPath })),
        })
      }
      const alias = resolveAlias(runtime, args.host)
      // Host must exist; connect eagerly so a typo fails here instead of at
      // the next session.
      await runtime.getConnectionFor(alias)
      const remotePath = args.path?.trim() ?? ''
      if (remotePath === '' || !remotePath.startsWith('/')) {
        throw new Error('path must be an absolute remote directory path (e.g. /home/user/project)')
      }
      const created = await createPlaceholderDir({ hostId: alias, remotePath })
      return jsonSafe({
        action: 'create' as const,
        localPath: created.localPath,
        host: created.hostId,
        remotePath: created.remotePath,
        hint: 'In the DSH UI use "select workspace" on this local path (or start a new session with it) — the session will run on the remote directory.',
      })
    },
  })
}
