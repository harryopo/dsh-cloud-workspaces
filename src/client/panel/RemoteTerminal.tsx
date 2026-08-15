/** Remote terminal: xterm.js over the WebSocket SSH PTY channel. The host
 *  half speaks the frame protocol in src/routes.ts (ready/output/exit). */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { RemoteIdeApi } from '../api'
import type { TerminalClientFrame, TerminalServerFrame } from '../../protocol'
import { ensurePanelCss, panelClasses as css } from './panel-css'
import { xtermCss } from './xterm.css'
import { CloseIcon, TerminalIcon } from './icons'

export interface RemoteTerminalProps {
  api: RemoteIdeApi
  alias: string
  /** Locale-aware text accessor. */
  t: (key: string, vars?: Record<string, string | number>) => string
  onExited: (id: number) => void
  /** Terminal identity (tab id). */
  id: number
}

/** A dark, readable palette close to the DSH dark theme. */
const THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: 'rgba(80,160,255,0.3)',
  black: '#1e1e1e',
  red: '#cd5c5c',
  green: '#4ec46c',
  yellow: '#d8a13c',
  blue: '#5a9bcf',
  magenta: '#b48ead',
  cyan: '#56b6c2',
  white: '#d4d4d4',
  brightBlack: '#6f6f6f',
  brightRed: '#e06c6c',
  brightGreen: '#6fdd8b',
  brightYellow: '#e5c07b',
  brightBlue: '#6ab0ff',
  brightMagenta: '#c678dd',
  brightCyan: '#7fd4dd',
  brightWhite: '#ffffff',
}

/** Lazily inject the official xterm stylesheet once per page. */
let xtermStyleInjected = false
function ensureXtermCss(): void {
  if (xtermStyleInjected) return
  xtermStyleInjected = true
  const style = document.createElement('style')
  style.textContent = xtermCss
  document.head.appendChild(style)
}

export function RemoteTerminal(props: RemoteTerminalProps): React.ReactElement {
  const { api, alias, t, onExited, id } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const statusRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    ensureXtermCss()
    const host = hostRef.current
    if (host === null) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Consolas, "JetBrains Mono", monospace',
      theme: THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    term.open(host)
    // Fit after the container has its final size (next frame).
    requestAnimationFrame(() => {
      try { fit.fit() } catch { /* container not sized yet */ }
    })

    const ws = api.openTerminal(alias, term.cols, term.rows)
    wsRef.current = ws
    let closed = false

    const setStatus = (text: string): void => {
      if (statusRef.current !== null) statusRef.current.textContent = text
    }

    ws.onopen = () => {
      setStatus('')
    }
    ws.onmessage = (event) => {
      let frame: TerminalServerFrame
      try {
        frame = JSON.parse(String(event.data)) as TerminalServerFrame
      } catch {
        return
      }
      if (frame.type === 'output') {
        term.write(frame.data)
      } else if (frame.type === 'ready') {
        setStatus('')
      } else if (frame.type === 'exit') {
        if (!closed) {
          closed = true
          setStatus(frame.error ?? t('terminal.exited', { code: frame.code ?? '?' }))
          try { ws.close(1000) } catch { /* already closed */ }
        }
      }
    }
    ws.onclose = () => {
      if (!closed) {
        closed = true
        setStatus(t('terminal.exited', { code: '?' }))
      }
    }
    ws.onerror = () => {
      setStatus(t('terminal.exited', { code: '?' }))
    }

    const send = (frame: TerminalClientFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
    }

    const inputDisposable = term.onData((data) => send({ type: 'input', data }))
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
        send({ type: 'resize', cols: term.cols, rows: term.rows })
      } catch { /* container gone */ }
    })
    resizeObserver.observe(host)

    // Initial resize sync.
    requestAnimationFrame(() => {
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    })

    return () => {
      closed = true
      inputDisposable.dispose()
      resizeObserver.disconnect()
      try { ws.close(1000) } catch { /* already closed */ }
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, id])

  return (
    <div className={css.terminalWrap} style={{ height: 220 }}>
      <div className={css.terminalHeader}>
        <span><TerminalIcon size={12} /> {t('terminal.title')} #{id}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={`${css.btn} ${css.btnGhost}`}
          title={t('terminal.close')}
          onClick={() => onExited(id)}
        >
          <CloseIcon size={11} />
        </button>
      </div>
      <div className={css.terminalBody}>
        <div ref={hostRef} style={{ height: '100%' }} />
        <div ref={statusRef} className={css.terminalOverlay} />
      </div>
    </div>
  )
}
