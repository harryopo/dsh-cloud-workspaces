/** Remote file explorer: a lazy-loading tree over the active SSH connection
 *  with per-directory cache, inline rename and delete. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteDirEntry } from '../../protocol'
import type { RemoteIdeApi } from '../api'
import { basename, dirname, joinPath } from './helpers'
import { ensurePanelCss, panelClasses as css } from './panel-css'

export interface RemoteExplorerProps {
  api: RemoteIdeApi
  /** The active connection alias ('' when none). */
  alias: string
  /** Initial remote root (usually $HOME). */
  root: string
  /** Open a remote file in the editor. */
  onOpenFile: (path: string) => void
  /** Locale-aware text accessor. */
  t: (key: string, vars?: Record<string, string | number>) => string
}

interface TreeState {
  /** Expanded directory paths. */
  expanded: Set<string>
  /** Loading directory paths. */
  loading: Set<string>
  /** Per-directory error. */
  errors: Map<string, string>
  /** Bump to force a re-render after cache writes. */
  version: number
}

/** One visible tree row. */
interface Row {
  path: string
  name: string
  depth: number
  entry: RemoteDirEntry
  expanded: boolean
  loading: boolean
}

export function RemoteExplorer(props: RemoteExplorerProps): React.ReactElement {
  const { api, alias, root, onOpenFile, t } = props
  // Children cache lives in a ref (mutable, no re-render loops).
  const childrenCache = useRef(new Map<string, RemoteDirEntry[]>())
  const [state, setState] = useState<TreeState>(() => ({
    expanded: new Set(),
    loading: new Set(),
    errors: new Map(),
    version: 0,
  }))
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [renameValue, setRenameValue] = useState('')
  const requestSeq = useRef(0)

  const bump = useCallback((): void => {
    setState(prev => ({ ...prev, version: prev.version + 1 }))
  }, [])

  /** Load one directory's children (cached; force refreshes). */
  const loadDir = useCallback(async (path: string, force = false): Promise<void> => {
    if (!force && (childrenCache.current.has(path) || state.loading.has(path))) return
    const seq = ++requestSeq.current
    setState(prev => {
      const loading = new Set(prev.loading)
      loading.add(path)
      const errors = new Map(prev.errors)
      errors.delete(path)
      return { ...prev, loading, errors }
    })
    try {
      const entries = await api.ls(path, alias)
      if (seq !== requestSeq.current) return
      childrenCache.current.set(path, entries)
      setState(prev => {
        const loading = new Set(prev.loading)
        loading.delete(path)
        return { ...prev, loading, version: prev.version + 1 }
      })
    } catch (error) {
      if (seq !== requestSeq.current) return
      setState(prev => {
        const loading = new Set(prev.loading)
        loading.delete(path)
        const errors = new Map(prev.errors)
        errors.set(path, error instanceof Error ? error.message : String(error))
        return { ...prev, loading, errors, version: prev.version + 1 }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, alias, state.loading])

  /** Expand or collapse a directory. */
  const toggleDir = useCallback((path: string): void => {
    setState(prev => {
      const expanded = new Set(prev.expanded)
      if (expanded.has(path)) expanded.delete(path)
      else expanded.add(path)
      return { ...prev, expanded }
    })
  }, [])

  const openPath = useCallback((path: string, entry: RemoteDirEntry): void => {
    if (entry.type === 'dir') {
      toggleDir(path)
      if (!childrenCache.current.has(path)) void loadDir(path)
    } else if (entry.type === 'file') {
      setSelected(path)
      onOpenFile(path)
    }
  }, [onOpenFile, toggleDir, loadDir])

  /** Expand a directory and load its children. */
  const expandAndLoad = useCallback((path: string): void => {
    setState(prev => {
      const expanded = new Set(prev.expanded)
      expanded.add(path)
      return { ...prev, expanded }
    })
    void loadDir(path)
  }, [loadDir])

  /** Expand ancestors of a path so the file becomes visible. */
  const revealPath = useCallback((path: string): void => {
    let current = dirname(path)
    const chain: string[] = []
    while (current !== '/' && current !== root) {
      chain.unshift(current)
      current = dirname(current)
    }
    for (const dir of chain) expandAndLoad(dir)
  }, [expandAndLoad, root])

  // Reset when the root changes (connection switch).
  useEffect(() => {
    requestSeq.current += 1
    childrenCache.current.clear()
    setState({ expanded: new Set(), loading: new Set(), errors: new Map(), version: 0 })
    setSelected(undefined)
    setState(prev => {
      const expanded = new Set(prev.expanded)
      expanded.add(root)
      return { ...prev, expanded }
    })
    void loadDir(root, true)
  }, [root, loadDir])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  void revealPath
  void bump

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    const walk = (dir: string, depth: number): void => {
      if (!state.expanded.has(dir)) return
      const entries = childrenCache.current.get(dir)
      if (entries === undefined) return
      for (const entry of entries) {
        const path = joinPath(dir, entry.name)
        result.push({
          path,
          name: entry.name,
          depth,
          entry,
          expanded: state.expanded.has(path) && entry.type === 'dir',
          loading: state.loading.has(path),
        })
        if (entry.type === 'dir' && state.expanded.has(path)) walk(path, depth + 1)
      }
    }
    walk(root, 0)
    return result
  }, [state, root])

  /** Rename the selected row. */
  const commitRename = async (): Promise<void> => {
    if (renaming === undefined || renameValue.trim() === '' || renameValue === basename(renaming)) {
      setRenaming(undefined)
      return
    }
    const to = joinPath(dirname(renaming), renameValue.trim())
    try {
      await api.rename(renaming, to)
      setRenaming(undefined)
      const parent = dirname(renaming)
      childrenCache.current.delete(parent)
      void loadDir(parent, true)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  const deletePath = async (path: string): Promise<void> => {
    if (!window.confirm(t('explorer.deleteConfirm', { path }))) return
    try {
      await api.remove(path)
      const parent = dirname(path)
      childrenCache.current.delete(parent)
      if (parent !== path) void loadDir(parent, true)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  const createEntry = async (kind: 'file' | 'dir'): Promise<void> => {
    const parent = root
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name')
    if (name === null || name.trim() === '') return
    const path = joinPath(parent, name.trim())
    try {
      if (kind === 'dir') await api.mkdir(path)
      else await api.writeFile(path, '')
      childrenCache.current.delete(parent)
      await loadDir(parent, true)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  const error = state.errors.get(root)
  const loading = state.loading.has(root)

  return (
    <div className={css.explorer}>
      <div className={css.explorerHeader}>
        <span>{t('explorer.title')}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={`${css.btn} ${css.btnGhost}`}
          title={t('explorer.refresh')}
          onClick={() => void loadDir(root, true)}
        >
          ↻
        </button>
        <button
          type="button"
          className={`${css.btn} ${css.btnGhost}`}
          title={t('explorer.newFile')}
          onClick={() => void createEntry('file')}
        >
          +f
        </button>
        <button
          type="button"
          className={`${css.btn} ${css.btnGhost}`}
          title={t('explorer.newFolder')}
          onClick={() => void createEntry('dir')}
        >
          +d
        </button>
      </div>
      <div className={css.explorerPath} title={root}>{root}</div>
      <div className={css.explorerBody}>
        {error !== undefined && <div className={css.explorerEmpty}>{t('explorer.error')}: {error}</div>}
        {error === undefined && rows.length === 0 && !loading && (
          <div className={css.explorerEmpty}>{t('explorer.empty')}</div>
        )}
        {loading && rows.length === 0 && (
          <div className={css.explorerEmpty}>{t('explorer.loading')}</div>
        )}
        {rows.map(row => (
          <div
            key={row.path}
            className={`${css.treeRow}${selected === row.path ? ' ' + css.selected : ''}`}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            onClick={() => openPath(row.path, row.entry)}
            onDoubleClick={() => { if (row.entry.type === 'dir') expandAndLoad(row.path) }}
            title={row.entry.type === 'dir' ? row.path : `${row.path} · ${formatSize(row.entry.size)}`}
          >
            <span className={css.treeCaret}>
              {row.entry.type === 'dir'
                ? (row.expanded ? '▾' : row.loading ? '…' : '▸')
                : <span className={css.placeholder}>·</span>}
            </span>
            <span className={css.treeIcon}>{row.entry.type === 'dir' ? '📁' : '📄'}</span>
            {renaming === row.path ? (
              <input
                className={css.formInput}
                style={{ flex: 1, minWidth: 0, fontSize: 12 }}
                value={renameValue}
                autoFocus
                onChange={e => setRenameValue(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={e => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') setRenaming(undefined)
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <>
                <span className={css.treeName}>{row.name}</span>
                {row.entry.type === 'file' && row.entry.size > 0 && (
                  <span className={css.treeMeta}>{formatSize(row.entry.size)}</span>
                )}
                <span
                  className={css.treeMeta}
                  role="button"
                  title={t('explorer.rename')}
                  onClick={e => {
                    e.stopPropagation()
                    setRenaming(row.path)
                    setRenameValue(row.name)
                  }}
                >
                  ✎
                </span>
                <span
                  className={css.treeMeta}
                  role="button"
                  title={t('explorer.delete')}
                  onClick={e => {
                    e.stopPropagation()
                    void deletePath(row.path)
                  }}
                >
                  🗑
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`
}
