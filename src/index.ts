/**
 * dsh-remote-ide — host half (standalone tools edition).
 *
 * Provides the remote-development agent tools (ssh_list / ssh_exec / ssh_ls /
 * ssh_read / ssh_write) backed by a persistent ssh2 engine with jump-host
 * support. Together with the `remote` agent preset (agent-presets/remote) this
 * turns the DSH coding agent's working environment into a remote Linux server.
 *
 * No browser half, no UI: everything the model needs rides the tools registry
 * (schemas flow into the system prompt automatically), and host entries live
 * in ~/.dsh/dsh-remote-ide.json (0600, import from ~/.ssh/config).
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SshEngine } from './engine'
import { HostStore } from './store'
import { sshExecTool, sshListTool, sshLsTool, sshReadTool, sshWriteTool } from './tools'

/** Stable cordis plugin name. */
export const name = 'remote-ide'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt']

/**
 * Settings namespace of the remote-IDE capability — the section the web
 * settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const REMOTE_IDE_SETTINGS_NAMESPACE = settingsNamespace('dsh-remote-ide')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (tools). */
  enabled?: boolean
  /** Remote file read cap for ssh_read (bytes). */
  maxReadBytes?: number
  /** When true, announce the remote tools to the agent via a prompt section. */
  announceToAgent?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxReadBytes: z.number().min(64 * 1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  announceToAgent: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true

/** Model-facing announcement: plugin presence and limits. */
export const REMOTE_GUIDANCE = '本机已安装 dsh-remote-ide（服务器开发模式工具）：ssh_list 列出主机、ssh_exec 在远程 Linux 执行命令、ssh_ls 列远程目录、ssh_read/ssh_write 通过 SFTP 读写远程文件。主机配置存 ~/.dsh/dsh-remote-ide.json（可从 ~/.ssh/config 导入）。限制：需先配置主机；远程命令消耗真实服务器资源；密码以明文存在用户主目录私有文件（0600）。用户提到「服务器开发 / SSH / 远程服务器 / 远程开发」时即指本插件。'

/** Tool-guidance band order. */
const SECTION_ORDER = 150

/**
 * Mount the SSH engine and the remote-development tools.
 * @param ctx - host plugin context carrying tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    enabled: current().enabled ?? DEFAULT_ENABLED,
    maxReadBytes: current().maxReadBytes,
    announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
  })

  const store = new HostStore()
  const engine = new SshEngine(store, { maxReadBytes: resolve().maxReadBytes })
  ctx.effect(() => () => { engine.dispose() }, 'dsh-remote-ide: engine')

  const tools = [
    sshListTool(engine),
    sshExecTool(engine),
    sshLsTool(engine),
    sshReadTool(engine),
    sshWriteTool(engine),
  ]
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-remote-ide: tools',
    )
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-ide',
        order: SECTION_ORDER,
        text: REMOTE_GUIDANCE,
      })
    }
  }

  installSettingsSection(ctx, REMOTE_IDE_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
