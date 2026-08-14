/**
 * Optional better-sidebar integration (second track).
 *
 * When the user also has dsh-better-sidebar installed, this registers a
 * "Remote IDE" tab into its sidebar workbench so the remote workspace lives
 * next to the local explorer/git/terminal. Everything here is additive:
 * absent better-sidebar, the standalone panel (mount.tsx) carries the whole
 * experience and this module never runs.
 *
 * Runtime interaction happens ONLY through `ctx.betterSidebar` methods and
 * the plugin's own HTTP API — no value imports of other plugins (the client
 * bundle purity gate).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ctx.betterSidebar service type via type merging.
import type {} from 'dsh-better-sidebar'
import { createElement, useState } from 'react'
import type { WorkspaceStatus } from '../protocol'
import type { RemoteIdeApi } from './api'
import { SshPanel } from './panel/SshPanel'
import { panelClasses as css } from './panel/panel-css'

/** Better-sidebar service shape (avoid depending on its runtime exports). */
interface BetterSidebarLike {
  registerTab(descriptor: unknown): () => void
}

/** A standalone React entry inside a better-sidebar tab. */
function RemoteIdeTab(props: { api: RemoteIdeApi; t: (key: string, vars?: Record<string, string | number>) => string }): React.ReactElement {
  const { api, t } = props
  // Re-render when the connection state changes so the tab shows the right
  // view; the panel polls status itself, this just bumps React.
  const [, setStatus] = useState<WorkspaceStatus | undefined>(undefined)
  void setStatus
  return createElement('div', { className: css.tabHost }, createElement(SshPanel, { api, t }))
}

/**
 * Register the better-sidebar surfaces when the service is present.
 * @param ctx - client root context.
 * @param api - the remote-IDE API client.
 * @param t - locale-aware translator.
 * @returns disposer, or undefined when better-sidebar is absent.
 */
export function mountBetterSidebar(
  ctx: ClientContext,
  api: RemoteIdeApi,
  t: (key: string, vars?: Record<string, string | number>) => string,
): (() => void) | undefined {
  // Dynamic feature detection: better-sidebar is an optional peer; when it is
  // missing (or loads later), the standalone panel remains the entry point.
  const service = (ctx as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar
  if (service === undefined) return undefined

  const disposers: Array<() => void> = []
  try {
    disposers.push(service.registerTab({
      id: 'dsh-remote-ide:workspace',
      title: () => t('entry.label'),
      icon: createElement('span', { style: { fontSize: 14 } }, '🖥️'),
      order: 60,
      single: true,
      component: () => createElement(RemoteIdeTab, { api, t }),
    }))
  } catch (error) {
    console.warn('[dsh-remote-ide] better-sidebar registration failed:', error)
  }
  if (disposers.length === 0) return undefined
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
