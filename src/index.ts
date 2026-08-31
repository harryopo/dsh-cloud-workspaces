/**
 * dsh-remote-ide — host half.
 *
 * 免 preset 的「云端工作区」模式：工作区选择器（client 半双 tab）选定远程
 * 目录后，会话内官方同名工具（bash/read/write/edit/glob/grep）经 agent/created
 * 钩子在 agent scope 遮蔽为 SSH 实现（session-tools），另有全局 ssh_* 工具
 * （tools）、设置卡主机管理（host-settings + typert）。agent-presets/remote-legacy
 * 保留 fs/subprocess 真 seam 替换路线作参考，不再部署。
 *
 * Host entries live in ~/.dsh/dsh-remote-ide.json (0600, import from
 * ~/.ssh/config) plus the settings namespace the web settings card edits.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import SshRuntime from './ssh-service'
import { sshExecTool, sshListTool, sshLsTool, sshReadTool, sshWorkspaceTool, sshWriteTool } from './tools'
import { installHostSettings } from './host-settings'
import { HOST_TYPERT_CONTRIBUTION, REMOTE_SERVICE, SshRemoteService } from './typert'
import { installSessionRouting, sessionSectionText } from './session-tools'
import { routeByCwd } from './workspace'

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
export const REMOTE_GUIDANCE = '本机已安装 dsh-remote-ide（远程工作区）：在「添加工作区」里选「云端（SSH）」即可把服务器目录绑定为工作区——该会话的 bash/read/write/edit/glob/grep 与 ssh_* 工具会自动在该服务器上执行，和本地一样。也可用 ssh_list 列出已配置主机、ssh_workspace 绑定远程目录。限制：需先在 设置 → SSH 连接 配置主机；远程命令消耗真实服务器资源；密码以明文存在用户主目录私有文件（0600）。用户提到「SSH / 远程服务器 / 远程开发 / 云端工作区」时即指本插件。'

/** Tool-guidance band order. */
const SECTION_ORDER = 150

/**
 * Mount the shared SSH runtime and the remote-development tools.
 *
 * The SshRuntime (ctx.ssh) is the ONE connection owner on the host plane: the
 * ssh_* tools registered here and the preset-scoped adapters (fs-ssh /
 * subprocess-ssh, mounted by agent-presets/remote in an isolate realm that
 * injects `ssh`) all consume the same engine, so a connection established by
 * one is visible to the others.
 * @param ctx - host plugin context carrying tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    enabled: current().enabled ?? DEFAULT_ENABLED,
    maxReadBytes: current().maxReadBytes,
    announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
  })

  // Host-plane shared SSH runtime; its own effect owns engine disposal.
  // Fetch via ctx.get (store read without the inject requirement): newer
  // cordis refuses direct ctx.ssh property access that is not declared in
  // `inject`, and `ssh` cannot be declared there — we provide it ourselves,
  // which would self-deadlock. ctx.plugin() alone returns the Fiber, not the
  // service instance.
  await ctx.plugin(SshRuntime, { maxReadBytes: resolve().maxReadBytes })
  const runtime = ctx.get('ssh')
  if (!runtime) throw new Error('dsh-remote-ide: SshRuntime did not provide ctx.ssh')

  const tools = [
    sshListTool(runtime),
    sshExecTool(runtime),
    sshLsTool(runtime),
    sshReadTool(runtime),
    sshWriteTool(runtime),
    sshWorkspaceTool(runtime),
  ]
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let disposeSessionSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeSessionSection !== undefined) {
      disposeSessionSection()
      disposeSessionSection = undefined
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
      // 会话级动态段：cwd 落在 ~/.dsh/remote/ 下的会话获得远程身份宣告；
      // 本地会话该函数返回空串，零注入（免 preset 透明模式的一半）。
      disposeSessionSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-ide:session',
        order: SECTION_ORDER + 1,
        text: (context) => {
          const agent = (context as { agent?: { session?: { header?: { cwd?: string } } } }).agent
          return sessionSectionText(agent?.session?.header?.cwd)
        },
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

  // Settings-card host config namespace + Typert endpoints. Mounted only when
  // the official settings/typert services exist (the web profile supplies
  // both; headless runs simply skip them — tools keep working via the store).
  ctx.inject(['typert', 'settings'], (scope) => {
    const settingsScope = installHostSettings(scope)
    const remote = new SshRemoteService(scope, runtime)
    remote.setSettings(settingsScope)
    // 严格描述符注册（face:'host' + invocations）；gateway 的 claimsEndpoint
    // 按 local 注册表命中端点，SRC 回退无需装饰器。
    scope.typert.register(HOST_TYPERT_CONTRIBUTION)
    scope.logger?.info('[dsh-remote-ide] typert remote ' + REMOTE_SERVICE + ' registered')
  })

  // 免 preset 的透明会话路由（核心竞争力）：agent/created 看会话 cwd，占位
  // 工作区会话在 agent scope 注册与官方同名的 bash/read/write/edit/glob/grep
  // 遮蔽工具（经共享 SshEngine 落远程）。enabled 开关在事件时求值——设置面
  // 的启停即时生效。工具注册仍走上面的 sync()（announceToAgent 开关）。
  installSessionRouting(ctx, runtime, () => resolve().enabled === true)

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
