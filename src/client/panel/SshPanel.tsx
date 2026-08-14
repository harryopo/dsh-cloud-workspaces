/** The remote-IDE main panel: host manager when disconnected, and the
 *  workbench (remote explorer + tabbed editor + SSH terminal) once a host is
 *  connected. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SshHostSummary, WorkspaceStatus } from '../../protocol'
import { pollStatus, type RemoteIdeApi } from '../api'
import { basename } from './helpers'
import { HostFormDialog } from './HostFormDialog'
import { RemoteEditor } from './RemoteEditor'
import { RemoteExplorer } from './RemoteExplorer'
import { RemoteTerminal } from './RemoteTerminal'
import { ensurePanelCss, panelClasses as css } from './panel-css'

export interface SshPanelProps {
  api: RemoteIdeApi
  /** Locale-aware text accessor. */
  t: (key: string, vars?: Record<string, string | number>) => string
}

interface OpenFile {
  path: string
}

const MAX_TERMINALS = 4

export function SshPanel(props: SshPanelProps): React.ReactElement {
  const { api, t } = props
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [status, setStatus] = useState<WorkspaceStatus>({ state: 'disconnected', alias: '' })
  const [dialogHost, setDialogHost] = useState<SshHostSummary | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState<string | undefined>(undefined)
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFile, setActiveFile] = useState<string | undefined>(undefined)
  const [terminals, setTerminals] = useState<number[]>([])
  const nextTerminal = useRef(1)
  const [terminalError, setTerminalError] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')

  const refreshHosts = useCallback(async (): Promise<void> => {
    try {
      setHosts(await api.listHosts())
    } catch (error) {
      console.warn('[dsh-remote-ide] list hosts failed:', error)
    }
  }, [api])

  useEffect(() => {
    void refreshHosts()
    // Poll the workspace status (covers reconnects and external disconnects).
    const stop = pollStatus(api, 5000, setStatus)
    return stop
  }, [api, refreshHosts])

  const connect = useCallback(async (alias: string): Promise<void> => {
    setStatus(prev => ({ ...prev, state: 'connecting', alias }))
    setTerminalError(undefined)
    try {
      const next = await api.connect(alias)
      setStatus(next)
      if (next.state === 'connected') {
        setOpenFiles([])
        setActiveFile(undefined)
        setTerminals([])
        nextTerminal.current = 1
      }
    } catch (error) {
      setStatus(prev => ({
        ...prev,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [api])

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.disconnect())
    } catch {
      setStatus({ state: 'disconnected', alias: '' })
    }
    setOpenFiles([])
    setActiveFile(undefined)
    setTerminals([])
  }, [api])

  const openFile = useCallback((path: string): void => {
    setOpenFiles(prev => prev.some(file => file.path === path) ? prev : [...prev, { path }])
    setActiveFile(path)
  }, [])

  const closeFile = useCallback((path: string): void => {
    setOpenFiles(prev => {
      const next = prev.filter(file => file.path !== path)
      return next
    })
    setActiveFile(prev => {
      if (prev !== path) return prev
      const remaining = openFiles.filter(file => file.path !== path)
      return remaining.length > 0 ? remaining[remaining.length - 1]!.path : undefined
    })
  }, [openFiles])

  const newTerminal = useCallback((): void => {
    if (status.alias === '') return
    setTerminals(prev => {
      if (prev.length >= MAX_TERMINALS) return prev
      const id = nextTerminal.current++
      return [...prev, id]
    })
    setTerminalError(undefined)
  }, [status.alias])

  const closeTerminal = useCallback((id: number): void => {
    setTerminals(prev => prev.filter(term => term !== id))
  }, [])

  const testHost = useCallback(async (alias: string): Promise<void> => {
    setTesting(alias)
    try {
      const result = await api.test(alias)
      setTestResult(prev => ({
        ...prev,
        [alias]: result.ok
          ? `✓ ${result.latencyMs ?? '?'}ms`
          : `✗ ${result.error ?? 'failed'}`,
      }))
    } catch (error) {
      setTestResult(prev => ({ ...prev, [alias]: `✗ ${error instanceof Error ? error.message : String(error)}` }))
    } finally {
      setTesting(undefined)
    }
  }, [api])

  const deleteHost = useCallback(async (alias: string): Promise<void> => {
    if (!window.confirm(t('hosts.deleteConfirm', { alias }))) return
    try {
      await api.deleteHost(alias)
      await refreshHosts()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }, [api, refreshHosts, t])

  const importConfig = useCallback(async (): Promise<void> => {
    try {
      const result = await api.importSshConfig()
      window.alert(t('hosts.importResult', {
        parsed: result.parsed,
        added: result.added,
        skipped: result.skipped,
      }))
      await refreshHosts()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }, [api, refreshHosts, t])

  const connected = status.state === 'connected'
  const activeAlias = status.alias
  const filteredHosts = hosts.filter(host =>
    search.trim() === ''
    || host.alias.toLowerCase().includes(search.trim().toLowerCase())
    || host.host.toLowerCase().includes(search.trim().toLowerCase()))

  const stateClass = status.state === 'connected'
    ? css.stateConnected
    : status.state === 'connecting'
      ? css.stateConnecting
      : status.state === 'failed'
        ? css.stateFailed
        : css.stateDisconnected

  const stateLabel = status.state === 'connected'
    ? t('panel.connected')
    : status.state === 'connecting'
      ? t('panel.connecting')
      : status.state === 'failed'
        ? t('panel.failed')
        : t('panel.disconnected')

  return (
    <div className={css.panel}>
      {/* toolbar */}
      <div className={css.toolbar}>
        <span className={css.toolbarTitle}>{t('panel.title')}</span>
        <select
          className={css.hostSelect}
          value={status.alias}
          onChange={e => { if (e.target.value !== '') void connect(e.target.value) }}
        >
          <option value="">— {t('panel.disconnected')} —</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias}</option>)}
        </select>
        {connected ? (
          <button type="button" className={`${css.btn} ${css.btnDanger}`} onClick={() => void disconnect()}>
            {t('panel.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            className={`${css.btn} ${css.btnPrimary}`}
            disabled={status.alias === '' || status.state === 'connecting'}
            onClick={() => status.alias !== '' && void connect(status.alias)}
          >
            {t('panel.connect')}
          </button>
        )}
        <span className={`${css.statePill} ${stateClass}`}>{stateLabel}</span>
        {status.error !== undefined && status.state === 'failed' && (
          <span className={css.errorText} title={status.error}>{status.error}</span>
        )}
        <span className={css.spacer} />
        {connected && (
          <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={newTerminal}>
            + {t('terminal.newTab')}
          </button>
        )}
      </div>

      {!connected ? (
        /* ---------------------------------------------------- host list */
        <div className={css.hostList}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              className={css.formInput}
              style={{ flex: 1, minWidth: 160 }}
              placeholder={t('hosts.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={() => { setDialogHost(undefined); setDialogOpen(true) }}>
              + {t('hosts.add')}
            </button>
            <button type="button" className={css.btn} onClick={() => void importConfig()}>
              {t('hosts.import')}
            </button>
          </div>
          {filteredHosts.length === 0 && (
            <div className={css.explorerEmpty}>{t('panel.noHosts')}</div>
          )}
          {filteredHosts.map(host => (
            <div key={host.alias} className={css.hostCard}>
              <div className={css.hostMain}>
                <div className={css.hostName}>
                  <span className={css.hostAlias}>{host.alias}</span>
                  {host.environment !== undefined && host.environment !== '' && (
                    <span className={css.envBadge}>{host.environment}</span>
                  )}
                  <span className={css.keyBadge}>{host.auth === 'key' ? '🔑 key' : '🔒 pwd'}</span>
                </div>
                <div className={css.hostDetail}>
                  {host.user}@{host.host}:{host.port}
                  {host.proxyJump.length > 0 && ` · ↪ ${host.proxyJump.join(',')}`}
                  {testResult[host.alias] !== undefined && ` · ${testResult[host.alias]}`}
                </div>
              </div>
              <div className={css.hostActions}>
                <button
                  type="button"
                  className={`${css.btn} ${css.btnPrimary}`}
                  disabled={status.state === 'connecting'}
                  onClick={() => void connect(host.alias)}
                >
                  {t('panel.connect')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={testing === host.alias}
                  onClick={() => void testHost(host.alias)}
                >
                  {testing === host.alias ? t('hosts.testing') : t('hosts.test')}
                </button>
                <button type="button" className={css.btn} onClick={() => { setDialogHost(host); setDialogOpen(true) }}>
                  {t('hosts.edit')}
                </button>
                <button type="button" className={`${css.btn} ${css.btnDanger}`} onClick={() => void deleteHost(host.alias)}>
                  {t('hosts.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ---------------------------------------------------- workbench */
        <div className={css.workbench}>
          <RemoteExplorer
            api={api}
            alias={activeAlias}
            root={status.home ?? '/'}
            onOpenFile={openFile}
            t={t}
          />
          <div className={css.mainColumn}>
            {/* editor tabs */}
            {openFiles.length > 0 && (
              <div className={css.tabBar}>
                {openFiles.map(file => (
                  <div
                    key={file.path}
                    className={`${css.tab}${activeFile === file.path ? ' ' + css.active : ''}`}
                    onClick={() => setActiveFile(file.path)}
                  >
                    <span className={css.tabName} title={file.path}>{basename(file.path)}</span>
                    <span
                      className={css.tabClose}
                      role="button"
                      onClick={e => {
                        e.stopPropagation()
                        closeFile(file.path)
                      }}
                    >
                      ×
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* editor */}
            <div className={css.editorArea} style={openFiles.length > 0 ? {} : { display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {activeFile !== undefined && openFiles.some(file => file.path === activeFile) ? (
                <RemoteEditor
                  key={activeFile}
                  api={api}
                  alias={activeAlias}
                  path={activeFile}
                  t={t}
                />
              ) : openFiles.length === 0 ? (
                <span className={css.explorerEmpty}>{t('panel.empty')}</span>
              ) : null}
            </div>
            {/* terminals */}
            {terminals.length > 0 && (
              <div style={{ flex: 'none' }}>
                {terminals.map(id => (
                  <RemoteTerminal
                    key={id}
                    id={id}
                    api={api}
                    alias={activeAlias}
                    t={t}
                    onExited={closeTerminal}
                  />
                ))}
              </div>
            )}
            {terminalError !== undefined && (
              <div className={css.errorText} style={{ padding: '2px 10px' }}>{terminalError}</div>
            )}
          </div>
        </div>
      )}

      {/* host dialog */}
      {dialogOpen && (
        <HostFormDialog
          host={dialogHost}
          api={api}
          t={t}
          onSaved={() => {
            setDialogOpen(false)
            void refreshHosts()
          }}
          onClose={() => setDialogOpen(false)}
        />
      )}

      {/* status bar */}
      <div className={css.statusBar}>
        <span className={css.statusItem}>
          {connected ? `${t('panel.workspace')}: ${activeAlias}@${status.home ?? '/'}` : t('panel.disconnected')}
        </span>
      </div>
    </div>
  )
}
