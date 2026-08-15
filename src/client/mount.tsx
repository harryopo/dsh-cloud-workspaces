/**
 * Panel view mounting.
 *
 * The IDE workbench lives in a dedicated right-side grid column appended to
 * the shell frame by the layout controller (ide-layout.ts) — the conversation
 * column is never touched, so the chat keeps working while the remote
 * workbench is open. This module mounts the React tree into that column.
 *
 * Discovery uses a light polling loop instead of a whole-tree MutationObserver
 * (the shell re-renders constantly while streaming; observers on document.body
 * with subtree:true run on every mutation and drag the UI).
 */
import { createRoot, type Root } from 'react-dom/client'
import type { RemoteIdeApi } from './api'
import type { IdeLayoutController } from './ide-layout'
import { SshPanel } from './panel/SshPanel'
import { panelClasses as css } from './panel/panel-css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-remote-ide-col]'

const DISCOVER_INTERVAL_MS = 400

/**
 * Mount the panel React tree into the right-side IDE column.
 * @param layout - the layout controller (open state owns the column width).
 * @param api - the remote-IDE API client the panel operates through.
 * @param t - locale-aware translator.
 * @returns disposer unmounting the tree.
 */
export function mountPanel(
  layout: IdeLayoutController,
  api: RemoteIdeApi,
  t: (key: string, vars?: Record<string, string | number>) => string,
): () => void {
  let root: Root | undefined
  let container: HTMLElement | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      // The column was replaced; drop the stale tree and remount.
      root?.unmount()
      root = undefined
      container = undefined
    }
    const col = document.querySelector<HTMLElement>(PANEL_VIEW_SELECTOR)
    if (col === null) return
    container = document.createElement('div')
    container.dataset.dshRemoteIdeView = ''
    container.className = css.view
    col.appendChild(container)
    root = createRoot(container)
    root.render(<SshPanel api={api} t={t} />)
  }

  // Poll until the column appears (the layout controller creates it once the
  // frame mounts), then keep polling at a low frequency to heal a torn-down
  // column after HMR — cheap compared to a subtree observer.
  ensure()
  timer = setInterval(ensure, DISCOVER_INTERVAL_MS)

  return () => {
    if (timer !== undefined) clearInterval(timer)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
