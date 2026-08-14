/** Remote file editor: CodeMirror 6 over SFTP — open reads the remote file,
 *  Ctrl/Cmd+S (or the save button) writes it back through the SSH connection. */

import { useCallback, useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { css as cssLang } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import type { RemoteFileContent } from '../../protocol'
import type { RemoteIdeApi } from '../api'
import { basename } from './helpers'
import { ensurePanelCss, panelClasses as css } from './panel-css'

export interface RemoteEditorProps {
  api: RemoteIdeApi
  alias: string
  path: string
  /** Locale-aware text accessor. */
  t: (key: string, vars?: Record<string, string | number>) => string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; file: RemoteFileContent }

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }

/** Pick a CodeMirror language extension by file extension. */
function languageFor(path: string): ReturnType<typeof javascript> | ReturnType<typeof python> | ReturnType<typeof json> | ReturnType<typeof html> | ReturnType<typeof cssLang> | ReturnType<typeof sql> | ReturnType<typeof xml> | ReturnType<typeof markdown> | undefined {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.mjs') || name.endsWith('.cjs')) return javascript({ jsx: name.endsWith('x') })
  if (name.endsWith('.py') || name.endsWith('.pyw')) return python()
  if (name.endsWith('.json') || name.endsWith('.jsonc')) return json()
  if (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.vue')) return html()
  if (name.endsWith('.css') || name.endsWith('.scss') || name.endsWith('.less')) return cssLang()
  if (name.endsWith('.sql')) return sql()
  if (name.endsWith('.xml') || name.endsWith('.svg')) return xml()
  if (name.endsWith('.md') || name.endsWith('.markdown')) return markdown()
  return undefined
}

export function RemoteEditor(props: RemoteEditorProps): React.ReactElement {
  const { api, alias, path, t } = props
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    setLoad({ kind: 'loading' })
    setSave({ kind: 'idle' })
    setDirty(false)
    api.readFile(path, alias)
      .then(file => {
        if (cancelled || !mounted.current) return
        setLoad({ kind: 'ready', file })
        setContent(file.content)
      })
      .catch(error => {
        if (cancelled || !mounted.current) return
        setLoad({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [api, alias, path])

  const saveFile = useCallback(async (): Promise<void> => {
    if (load.kind !== 'ready' || save.kind === 'saving') return
    setSave({ kind: 'saving' })
    try {
      await api.writeFile(path, content, alias)
      setSave({ kind: 'saved', at: Date.now() })
      setDirty(false)
    } catch (error) {
      setSave({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api, alias, path, content, load.kind, save.kind])

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [saveFile])

  if (load.kind === 'loading') {
    return <div className={css.terminalOverlay}>{t('explorer.loading')}</div>
  }
  if (load.kind === 'error') {
    return (
      <div className={css.terminalOverlay}>
        <span>{t('editor.readError')}: {load.message}</span>
      </div>
    )
  }

  const language = languageFor(path)
  const extensions = language === undefined ? [keymap.of(defaultKeymap)] : [language, keymap.of(defaultKeymap)]
  const status = save.kind === 'saving'
    ? t('editor.saving')
    : save.kind === 'saved'
      ? t('editor.saved')
      : save.kind === 'error'
        ? `${t('editor.saveError')}: ${save.message}`
        : undefined

  return (
    <div className={css.editorArea}>
      <CodeMirror
        value={content}
        height="100%"
        extensions={extensions}
        onChange={(value) => {
          setContent(value)
          setDirty(true)
        }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          autocompletion: true,
        }}
      />
      {load.file.truncated && (
        <div className={`${css.editorStatus} ${css.error}`}>{t('editor.truncated')}</div>
      )}
      {status !== undefined && !load.file.truncated && (
        <div className={`${css.editorStatus} ${save.kind === 'error' ? css.error : css.ok}`}>{status}</div>
      )}
      {dirty && (
        <button
          type="button"
          className={`${css.btn} ${css.btnPrimary}`}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}
          onClick={() => void saveFile()}
        >
          💾 {t('host.form.save')}
        </button>
      )}
    </div>
  )
}
