/**
 * Panel view mounting.
 *
 * The IDE workbench lives in a dedicated right-side grid column appended to
 * the shell frame by the layout controller (ide-layout.ts) — the conversation
 * column is never touched, so the chat keeps working while the remote
 * workbench is open. This module mounts the React tree into that column and
 * binds the column's open state to the layout controller.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { RemoteIdeApi } from './api'
import type { IdeLayoutController } from './ide-layout'
import { SshPanel } from './panel/SshPanel'
import { panelClasses as css } from './panel/panel-css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-remote-ide-col]'

/** Wait for one selector (the shell/frame mounts after boot settlement). */
function waitForElement(selector: string, onFound: (el: HTMLElement) => void): () => void {
  let disposed = false
  let observer: MutationObserver | undefined
  const tryFind = (): void => {
    if (disposed) return
    const el = document.querySelector<HTMLElement>(selector)
    if (el !== null) {
      observer?.disconnect()
      onFound(el)
    }
  }
  observer = new MutationObserver(() => { tryFind() })
  observer.observe(document.body, { childList: true, subtree: true })
  tryFind()
  return () => {
    disposed = true
    observer?.disconnect()
  }
}

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

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  ensure()

  return () => {
    waitObserver.disconnect()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
