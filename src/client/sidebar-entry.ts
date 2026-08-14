/**
 * Sidebar entry injection.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into,
 * so — following the task-board / dsh-ssh precedent of DOM-level extension —
 * the entry row is injected between the shell's New Session button and the
 * workspace browser. The injection self-heals: a MutationObserver watches the
 * sidebar root and re-inserts the row whenever a React re-render displaces it.
 *
 * The row is plain DOM (no React tree) so it can never disturb the shell's
 * reconciliation; the panel view it toggles is a separate React root mounted
 * in the right-side IDE column (see mount.tsx).
 */
import type { IdeLayoutController } from './ide-layout'
import { ensurePanelCss, panelClasses as css } from './panel/panel-css'

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-remote-ide-entry]'

/** Inline icon (matches the shell's 16px nav-icon look): a server glyph. */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11"/><circle cx="5" cy="9" r="0.8" fill="currentColor"/><circle cx="7.5" cy="9" r="0.8" fill="currentColor"/><circle cx="10" cy="9" r="0.8" fill="currentColor"/></svg>'

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(layout: IdeLayoutController, label: string, tooltip: string): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshRemoteIdeEntry = ''
  entry.className = css.entry
  entry.setAttribute('aria-label', label)
  entry.setAttribute('title', tooltip)
  entry.innerHTML = '<span class="' + css.entryIcon + '">' + ICON + '</span><span class="' + css.entryLabel + '">' + label + '</span>'
  entry.addEventListener('click', () => { layout.toggle() })
  return entry
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    // Position relative to the family block (entries injected by sibling
    // plugins), never relative to transient logoRow geometry.
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement
        && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-remote-ide-entry]'),
    )
    const anchor = family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param layout - the layout controller the entry toggles.
 * @param label - entry label text.
 * @param tooltip - entry tooltip text.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(layout: IdeLayoutController, label: string, tooltip: string): () => void {
  const entry = createEntry(layout, label, tooltip)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry)
    }
  })

  const syncActive = (): void => {
    if (layout.isOpen()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = layout.subscribe(syncActive)
  syncActive()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}
