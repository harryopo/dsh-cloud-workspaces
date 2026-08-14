/**
 * Generate src/client/panel/xterm.css.ts from the installed @xterm/xterm CSS
 * so the browser half can inject the official styles at runtime (no CSS file
 * to serve). Run: node scripts/gen-xterm-css.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')
const outPath = join(root, 'src', 'client', 'panel', 'xterm.css.ts')

let css = readFileSync(cssPath, 'utf8')
// Strip sourcemap comment if present.
css = css.replace(/\/\*# sourceMappingURL=.*\*\/\s*$/, '').trim()
// Escape backticks and ${ } for the template literal.
const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const out = `/**
 * Generated file — do not edit. Run \`node scripts/gen-xterm-css.mjs\` after
 * upgrading @xterm/xterm to refresh the bundled official styles.
 */
export const xtermCss = \`${escaped}\`
`

writeFileSync(outPath, out)
console.log(`wrote ${outPath} (${escaped.length} chars)`)
