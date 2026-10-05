/**
 * Executable security verification for client/index.js.
 * Strips comments first so documentation text can't mask a real sink (or fake one).
 */
import fs from 'node:fs'
const raw = fs.readFileSync('client/index.js', 'utf8')
// strip /* */ and // comments (strings kept intact enough for sink detection)
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
let fail = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''))
  if (!cond) fail++
}
console.log('=== A. HTML-writing sinks (code only, comments stripped) ===')
for (const [name, re] of Object.entries({
  'innerHTML assignment': /innerHTML\s*=/,
  'outerHTML': /outerHTML/,
  'insertAdjacentHTML': /insertAdjacentHTML/,
  'document.write': /document\.write/,
  'eval()': /\beval\s*\(/,
  'new Function': /new\s+Function/,
  'dangerouslySetInnerHTML': /dangerouslySetInnerHTML/,
  'srcdoc': /srcdoc/,
  'javascript: URL': /javascript:/,
  'location assignment': /location\s*\.(href|replace|assign)/,
  'window.open': /window\.open/,
})) check('no ' + name, !re.test(code), re.test(code) ? '<<< ' + code.match(re)[0] : '')

console.log('=== B. native dialogs gone (code only) ===')
check('no window.confirm', !/window\.confirm/.test(code))
check('no window.alert', !/window\.alert/.test(code))
check('no window.prompt', !/window\.prompt/.test(code))

console.log('=== C. untrusted remote data stays in text position ===')
check('remote path -> detail prop', /detail:\s*pendingRemove\.fullPath/.test(code))
check('ConfirmDialog renders detail as children', /h\('div',\s*\{\s*className:\s*'dri-confirmPath'\s*\},\s*detail\s*\)/.test(code))
const cdsrc = code.slice(code.indexOf('function ConfirmDialog'), code.indexOf('function HostRow'))
check('no style prop in ConfirmDialog', !/style:\s*\{/.test(cdsrc))
check('no href/src in ConfirmDialog', !/href:|src:/.test(cdsrc))
const rowBlock = code.slice(code.indexOf('for (const e of browser.entries'))
check('remote dir name never in style/href/className', !/(style|href|className)\s*:[^,}]*e\.name/.test(rowBlock))

console.log('=== D. secret hygiene ===')
check('edit form sends empty password', /password:\s*''/.test(code))
check('no localStorage write', !/localStorage\.setItem/.test(code))
check('no sessionStorage write', !/sessionStorage\.setItem/.test(code))
check('password input is type=password', /type:\s*showPw\s*\?\s*'text'\s*:\s*'password'/.test(code))
check('no credential in console.error', !/console\.error\([^)]*,\s*(error|err|e)\s*\)/.test(code))

console.log('=== E. destructive-action safety ===')
check('focus moves into dialog', /confirmRef\.current\.focus\(\)|cancelRef\.current\.focus\(\)/.test(cdsrc))
check('Escape closes dialog', /e\.key === 'Escape'/.test(cdsrc))
check('focus trapped inside dialog', /e\.key === 'Tab'/.test(cdsrc))
check('delete guarded by removing flag (no double-fire)', /if\s*\(!target\s*\|\|\s*removing\)\s*return/.test(code))

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : '✅ ALL ' + 'SECURITY CHECKS PASSED'))
process.exit(fail ? 1 : 0)
