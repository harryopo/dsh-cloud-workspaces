/** Small helpers shared by the panel components. */

import { dictionaries, interpolate, type RemoteIdeKey } from '../locales'

/** Template values accepted by the interpolator. */
export type TranslateValues = Record<string, string | number>

/** Active dictionary, picked by the document language at call time. */
export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? { ...dictionaries.en } : { ...dictionaries.zh }
}

/** Translate a key with optional {name} template params (current language). */
export function tt(key: keyof RemoteIdeKey | string, values?: TranslateValues): string {
  return interpolate(dictionary(), key, values)
}

/** Basename of a POSIX path ('/a/b/c.txt' -> 'c.txt'). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** Dirname of a POSIX path ('/a/b/c.txt' -> '/a/b'; '/c.txt' -> '/'). */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const index = trimmed.lastIndexOf('/')
  if (index === -1) return '/'
  const dir = trimmed.slice(0, index)
  return dir === '' ? '/' : dir
}

/** Join POSIX path segments. */
export function joinPath(...segments: string[]): string {
  const parts = segments.filter(segment => segment !== '')
  if (parts.length === 0) return '/'
  const joined = parts.join('/')
  return joined.startsWith('/') ? joined : '/' + joined
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** Deterministic language tag from navigator (zh variants -> zh). */
export function detectLanguage(): 'zh' | 'en' {
  const raw = navigator.language ?? 'en'
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
