/**
 * Build src/client/panel/panel-css.ts from src/client/panel/panel.module.css.
 *
 * The web half ships as ONE browser bundle (client.js) with no separate CSS
 * file, so CSS is compiled by Lightning CSS (scoped/hashed class names) and
 * emitted as a TS module: a CSS text constant injected into <style> at
 * runtime (idempotently) plus a class-name map the components import.
 *
 * Run: node scripts/build-css.mjs (also wired into `pnpm build`).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = join(root, 'src', 'client', 'panel', 'panel.module.css')
const outPath = join(root, 'src', 'client', 'panel', 'panel-css.ts')

const source = readFileSync(cssPath, 'utf8')
const result = transform({
  filename: 'panel.module.css',
  code: Buffer.from(source),
  cssModules: { pattern: '_ri_[hash]_[local]' },
})

const css = result.code.toString('utf8').trim()
const exportsMap = result.exports ?? {}
const classes = {}
for (const [local, entry] of Object.entries(exportsMap)) {
  classes[local] = entry.name
}

const escape = (text) => text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const out = `/**
 * Generated file — do not edit. Run \`node scripts/build-css.mjs\` after
 * editing src/client/panel/panel.module.css (wired into \`pnpm build\`).
 */
/** Scoped CSS text; inject once via ensurePanelCss(). */
export const panelCss = \`${escape(css)}\`
/** Scoped class-name map (Lightning CSS CSS modules). */
export const panelClasses = ${JSON.stringify(classes, null, 2)}
/** Idempotent <style> injection (one tag per page). */
let panelCssInjected = false
export function ensurePanelCss(): void {
  if (panelCssInjected) return
  panelCssInjected = true
  const style = document.createElement('style')
  style.dataset.pluginCss = 'dsh-remote-ide/panel.module.css'
  style.textContent = panelCss
  document.head.appendChild(style)
}
`

writeFileSync(outPath, out)
console.log(`wrote ${outPath} (${css.length} css chars, ${Object.keys(classes).length} classes)`)
