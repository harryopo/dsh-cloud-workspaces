/**
 * dsh-remote-ide — host half. Mounts the remote-IDE SSH engine (persistent
 * ssh2 connections, exec / PTY shell / SFTP file operations), the
 * /api/dsh-remote-ide route family plus the terminal WebSocket upgrade, and
 * the host config store (~/.dsh/dsh-remote-ide.json, import from
 * ~/.ssh/config). The browser half (./client) renders the remote IDE
 * workspace: host manager, remote file explorer, remote editor and the
 * SSH terminal. Everything rides official NPM SDK packages — no dsh source
 * changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SshEngine } from './engine'
import { makeRoutes } from './routes'
import { HostStore } from './store'

/** Stable cordis plugin name. */
export const name = 'remote-ide'

/** Services required before the surfaces can mount. */
export const inject = ['webServer']

/**
 * Settings namespace of the remote-IDE capability — the section the web
 * settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const REMOTE_IDE_SETTINGS_NAMESPACE = settingsNamespace('dsh-remote-ide')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, terminal, panel). */
  enabled?: boolean
  /** Remote file read cap for the editor (bytes). */
  maxReadBytes?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxReadBytes: z.number().min(64 * 1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ENABLED = true

/**
 * Mount the SSH engine, routes, and settings.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    enabled: current().enabled ?? DEFAULT_ENABLED,
    maxReadBytes: current().maxReadBytes,
  })

  const store = new HostStore()
  const engine = new SshEngine(store, { maxReadBytes: resolve().maxReadBytes })
  ctx.effect(() => () => { engine.dispose() }, 'dsh-remote-ide: engine')

  // The /api/dsh-remote-ide route family + terminal upgrade.
  const { routes, upgrade } = makeRoutes({ store, engine })
  let disposeRoutes: (() => void) | undefined

  const sync = (): void => {
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (!resolve().enabled) return
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
        }
      },
      'dsh-remote-ide: routes',
    )
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
