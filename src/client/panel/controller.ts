/** Tiny pub/sub controller for the panel's open state (avoids a React tree
 *  in the sidebar entry, which is plain DOM). */

export interface PanelControllerSnapshot {
  panelOpen: boolean
}

type Listener = (snapshot: PanelControllerSnapshot) => void

/** Panel open-state controller shared by the sidebar entry and the panel. */
export class PanelController {
  private panelOpen = false
  private readonly listeners = new Set<Listener>()

  getSnapshot(): PanelControllerSnapshot {
    return { panelOpen: this.panelOpen }
  }

  toggle(): void {
    this.panelOpen = !this.panelOpen
    this.emit()
  }

  open(): void {
    if (this.panelOpen) return
    this.panelOpen = true
    this.emit()
  }

  close(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
