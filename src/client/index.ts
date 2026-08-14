/**
 * Browser-half entry for dsh-remote-ide — runs inside the dsh web GUI.
 *
 * Registers the locale dictionaries and mounts the two DOM surfaces: the
 * sidebar entry row (toggles the panel) and the remote-IDE panel in the
 * center column. Failure policy: DOM mounting problems are logged, never
 * thrown — the web shell fails the whole boot when a plugin apply throws, and
 * an external plugin must not take the GUI down.
 *
 * Export discipline: the /client surface carries what cordis loading needs
 * plus types only — all value exports stay internal.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteIdeApi } from './api'
import { mountBetterSidebar } from './better-sidebar'
import { en, interpolate, zh, type RemoteIdeKey } from './locales'
import { mountPanel } from './mount'
import { PanelController } from './panel/controller'
import { ensurePanelCss } from './panel/panel-css'
import { dictionary } from './panel/helpers'
import { mountSidebarEntry } from './sidebar-entry'

/** Locale namespace this plugin owns. */
const NS = 'dsh-remote-ide'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-remote-ide surface copy. */
    'dsh-remote-ide': RemoteIdeKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { SshPanelProps } from './panel/SshPanel'
export type { RemoteExplorerProps } from './panel/RemoteExplorer'
export type { RemoteEditorProps } from './panel/RemoteEditor'
export type { RemoteTerminalProps } from './panel/RemoteTerminal'
export type { HostFormDialogProps } from './panel/HostFormDialog'
export type { PanelControllerSnapshot } from './panel/controller'
export type { RemoteIdeKey } from './locales'

/** Locale-aware translator bound to the active dictionary. */
function t(key: string, values?: Record<string, string | number>): string {
  return interpolate(dictionary(), key, values)
}

/**
 * Mount the remote-IDE panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-ide: dictionaries')

  const controller = new PanelController()
  const api = new RemoteIdeApi()
  const disposers: Array<() => void> = []
  try {
    ensurePanelCss()
    disposers.push(mountSidebarEntry(controller, t('entry.label'), t('entry.tooltip')))
    disposers.push(mountPanel(controller, api, t))
    // Second track: when dsh-better-sidebar is installed, add a Remote IDE
    // tab to its workbench (additive; absent service => no-op).
    const betterSidebarDispose = mountBetterSidebar(ctx, api, t)
    if (betterSidebarDispose !== undefined) disposers.push(betterSidebarDispose)
  } catch (error) {
    // DOM failures degrade the panel, never the GUI.
    console.warn('[dsh-remote-ide] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-remote-ide: ui mounts')
}
