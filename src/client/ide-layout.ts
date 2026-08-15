/**
 * The IDE side-panel layout controller: extends the web shell's three-column
 * frame (a grid) with ONE trailing grid track — the remote-IDE workbench —
 * by mirroring the shell's own inline grid-template-columns string and
 * re-appending the panel track on every shell update (MutationObserver, same
 * frame before paint). The conversation column is never touched: the IDE
 * lives beside the chat, so the agent keeps working in the conversation
 * while the remote workbench (explorer / editor / terminal) stays open.
 *
 * Architecture follows the dsh-aionui-panel layout controller (Apache-2.0,
 * re-implemented): the shell's inline style is the source of truth for its
 * own tracks; this controller never guesses them. Collapse = width 0 while
 * staying mounted; the drag handle is out-of-flow (absolute), so appending
 * the track never disturbs the shell's own children.
 */

/** The frame grid element (portals target it). */
let frameElement: HTMLElement | null = null

/** Read the current frame element (undefined while the shell is not mounted). */
export function getFrameElement(): HTMLElement | null {
  return frameElement
}

/** Locate the frame grid element the panel column appends into. */
function findFrame(): HTMLElement | null {
  const stamped = document.querySelector<HTMLElement>('[data-dsh-frame]')
  if (stamped !== null) return stamped
  return document.querySelector<HTMLElement>('[class*="sidebarCol"]')?.parentElement ?? null
}

/** Parse an inline grid-template-columns string into its tracks. */
export function parseGridTracks(input: string): string[] {
  const tracks: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ' ' && depth === 0) {
      if (current !== '') {
        tracks.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') tracks.push(current)
  return tracks
}

/** Extract a px width from one track (0 for fr/minmax/non-px tracks). */
export function trackPx(track: string): number {
  const match = /^(-?[\d.]+)px$/.exec(track.trim())
  return match === null ? 0 : Number(match[1])
}

/** Width knobs. */
export const DEFAULT_IDE_WIDTH_PX = 640
export const MIN_IDE_WIDTH_PX = 400
export const MAX_IDE_WIDTH_PX = 1000
export const IDE_HANDLE_WIDTH = 12
const WIDTH_STORAGE_KEY = 'dsh-remote-ide:width'

/** Read the persisted width (clamped; fallback to the default). */
export function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY)
    const value = Number.parseInt(raw ?? '', 10)
    if (Number.isFinite(value) && value >= MIN_IDE_WIDTH_PX && value <= MAX_IDE_WIDTH_PX) return value
  } catch {
    // storage unavailable — use the default
  }
  return DEFAULT_IDE_WIDTH_PX
}

/** One pointer drag session on a handle. */
function handlePointerDragStart(
  event: PointerEvent,
  handle: HTMLElement,
  options: {
    getStartWidth: () => number
    compute: (startWidth: number, deltaX: number) => number
    onFrame: (width: number) => void
    onEnd: (width: number) => void
  },
): void {
  event.preventDefault()
  handle.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startWidth = options.getStartWidth()
  let lastWidth = startWidth
  const onMove = (move: PointerEvent): void => {
    const deltaX = move.clientX - startX
    lastWidth = options.compute(startWidth, deltaX)
    options.onFrame(lastWidth)
  }
  const onUp = (up: PointerEvent): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.releasePointerCapture(up.pointerId)
    options.onEnd(lastWidth)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
}

/** The layout controller: frame sync, one panel column, one drag handle. */
export class IdeLayoutController {
  private frame: HTMLElement | null = null
  private col: HTMLDivElement | null = null
  private handle: HTMLDivElement | null = null
  private styleObserver: MutationObserver | null = null
  private sizeObserver: ResizeObserver | null = null
  private waitObserver: MutationObserver | null = null
  private frameWidth = 0
  /** The shell's own 3 tracks (sidebar, center, details) — mirror of its inline style. */
  private shellTracks: string[] = []
  private width = readStoredWidth()
  private open = false
  private readonly listeners = new Set<() => void>()

  /** Current panel width in px (0 when collapsed). */
  getWidth(): number {
    return this.open ? this.width : 0
  }

  /** Whether the IDE workbench is open. */
  isOpen(): boolean {
    return this.open
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Toggle the workbench open state (kept mounted; no transition). */
  toggle(): void {
    this.open = !this.open
    this.applyGrid()
    this.emit()
  }

  openPanel(): void {
    if (this.open) return
    this.open = true
    this.applyGrid()
    this.emit()
  }

  closePanel(): void {
    if (!this.open) return
    this.open = false
    this.applyGrid()
    this.emit()
  }

  /** Start watching for the frame and attach once it appears. */
  mount(): void {
    const tryAttach = (): void => {
      if (this.frame !== null) return
      const frame = findFrame()
      if (frame === null) return
      this.attach(frame)
    }
    this.waitObserver = new MutationObserver(() => { tryAttach() })
    this.waitObserver.observe(document.body, { childList: true, subtree: true })
    tryAttach()
  }

  /** Attach to the frame: the panel column, the handle, observers. */
  private attach(frame: HTMLElement): void {
    this.frame = frame
    frameElement = frame

    // The single trailing grid item (track 4).
    const col = document.createElement('div')
    col.dataset.dshRemoteIdeCol = ''
    col.style.minWidth = '0'
    col.style.overflow = 'hidden'
    col.style.display = 'flex'
    col.style.flexDirection = 'column'
    col.style.borderLeft = '1px solid var(--ri-border, rgba(128,128,128,0.3))'
    col.style.background = 'var(--ri-bg, #1e1e1e)'
    frame.appendChild(col)
    this.col = col

    // The absolute drag handle (left edge of the panel; drag left widens).
    const handle = document.createElement('div')
    handle.className = 'dsh-remote-ide-handle'
    handle.style.position = 'absolute'
    handle.style.top = '0'
    handle.style.bottom = '0'
    handle.style.zIndex = '30'
    handle.style.cursor = 'col-resize'
    handle.style.width = `${IDE_HANDLE_WIDTH}px`
    handle.style.marginLeft = `-${IDE_HANDLE_WIDTH / 2}px`
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      handlePointerDragStart(event, handle, {
        getStartWidth: () => this.width,
        compute: (startWidth, deltaX) => Math.min(MAX_IDE_WIDTH_PX, Math.max(MIN_IDE_WIDTH_PX, startWidth + deltaX)),
        onFrame: (width) => {
          this.width = width
          this.applyGrid()
        },
        onEnd: (width) => {
          try {
            localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)))
          } catch {
            // best-effort persistence
          }
        },
      })
    })
    // Double-click resets the width to the default.
    handle.addEventListener('dblclick', () => {
      this.width = DEFAULT_IDE_WIDTH_PX
      this.applyGrid()
    })
    frame.appendChild(handle)
    this.handle = handle

    // Sync the shell's inline grid: any shell write re-appends our track.
    const syncGrid = (): void => {
      const el = this.frame
      if (el === null) return
      const inline = el.style.gridTemplateColumns
      if (inline === '') return
      const tracks = parseGridTracks(inline)
      if (tracks.length >= 2 && tracks.length <= 3) {
        // The shell's own write (2-3 tracks) — remember it and re-append ours.
        this.shellTracks = tracks
        this.applyGrid()
        return
      }
      if (tracks.length === 4 && this.shellTracks.length === 3) {
        // Our own write — keep it.
        return
      }
    }
    this.styleObserver = new MutationObserver(syncGrid)
    this.styleObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })

    // Keep the handle positioned on frame resize.
    this.sizeObserver = new ResizeObserver(() => {
      this.frameWidth = frame.getBoundingClientRect().width
      this.applyGrid()
    })
    this.sizeObserver.observe(frame)

    // Initial sync: read the shell's inline style (already applied).
    const initial = frame.style.gridTemplateColumns
    if (initial !== '') {
      const tracks = parseGridTracks(initial)
      if (tracks.length >= 2 && tracks.length <= 3) {
        this.shellTracks = tracks
      } else if (tracks.length === 4 && trackPx(tracks[0]) > 0) {
        // Our own previous 4-track write (HMR re-materialization).
        this.shellTracks = tracks.slice(0, 3)
      }
    }
    this.frameWidth = frame.getBoundingClientRect().width
    this.applyGrid()
  }

  /** Re-write the frame grid and reposition the handle. */
  private applyGrid(): void {
    const frame = this.frame
    if (frame === null) return
    // Never guess the shell tracks: without a mirrored shell write, skip.
    if (this.shellTracks.length < 2 || this.shellTracks.length > 3) return
    const width = this.open ? this.width : 0

    // Four tracks: shell sidebar, center, shell details, IDE workbench.
    frame.style.gridTemplateColumns =
      `${this.shellTracks[0]} minmax(0, 1fr) ${this.shellTracks.length === 3 ? this.shellTracks[2] : '0px'} ${Math.round(width)}px`

    if (this.col !== null) {
      this.col.style.visibility = width > 0 ? 'visible' : 'hidden'
    }
    if (this.handle !== null) {
      const frameWidth = this.frameWidth > 0 ? this.frameWidth : frame.getBoundingClientRect().width
      this.handle.style.left = `${Math.round(frameWidth - width)}px`
      this.handle.style.display = width > 0 ? 'block' : 'none'
    }
  }

  /** Detach everything (plugin unload). */
  dispose(): void {
    this.waitObserver?.disconnect()
    this.styleObserver?.disconnect()
    this.sizeObserver?.disconnect()
    this.col?.remove()
    this.handle?.remove()
    this.col = null
    this.handle = null
    if (frameElement === this.frame) frameElement = null
    this.frame = null
  }
}
