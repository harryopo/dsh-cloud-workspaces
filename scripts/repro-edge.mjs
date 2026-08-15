/* Reproduce the Edge freeze: load dsh web, open the Remote IDE panel, connect
 * to the configured host, then measure main-thread lag + DOM mutation rate. */
import { chromium } from 'file:///C:/Users/Lenovo/AppData/Roaming/npm/node_modules/browser-use/node_modules/playwright/index.mjs'

const URL = 'http://127.0.0.1:4100'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(`[${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`))
page.on('response', (res) => {
  if (res.status() >= 400) console.log(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`)
})

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('goto warn:', e.message))

// Instrument: event-loop lag via rAF gaps + mutation counter.
await page.evaluate(() => {
  window.__stats = { maxLag: 0, frames: 0, last: performance.now(), mutations: 0, samples: [] }
  window.__lagLoop = () => {
    const now = performance.now()
    const lag = now - window.__stats.last - (1000 / 60)
    if (lag > window.__stats.maxLag) window.__stats.maxLag = lag
    window.__stats.frames++
    window.__stats.samples.push(Math.round(lag))
    if (window.__stats.samples.length > 600) window.__stats.samples.shift()
    window.__stats.last = now
    window.__lagRaf = requestAnimationFrame(window.__lagLoop)
  }
  window.__lagRaf = requestAnimationFrame(window.__lagLoop)
  window.__mutObs = new MutationObserver(() => { window.__stats.mutations++ })
  window.__mutObs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const stats = () => page.evaluate(() => {
  const s = window.__stats
  const sorted = [...s.samples].sort((a, b) => a - b)
  return {
    maxLagMs: Math.round(s.maxLag),
    avgLagMs: Math.round(s.samples.reduce((a, b) => a + b, 0) / Math.max(1, s.samples.length)),
    p95LagMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    mutations: s.mutations,
    frames: s.frames,
  }
})

console.log('--- phase 1: idle 10s ---')
await sleep(10000)
console.log(await stats())

// Open the Remote IDE panel.
const entry = page.getByRole('button', { name: '远程 IDE' }).first()
if (await entry.count()) {
  await entry.click().catch(e => console.log('click entry failed:', e.message))
}
console.log('--- phase 2: after opening IDE panel, idle 10s ---')
await sleep(10000)
console.log(await stats())

// Connect to the first host (option in the status-bar select).
try {
  const select = page.locator('select').first()
  const options = await select.locator('option').allTextContents()
  console.log('host options:', options)
  if (options.length > 1) {
    await select.selectOption({ label: options[1] })
    await page.getByRole('button', { name: /连接/ }).first().click().catch(() => {})
  }
} catch (e) { console.log('connect step failed:', e.message) }

console.log('--- phase 3: after connect, idle 10s ---')
await sleep(10000)
console.log(await stats())
console.log('explorer mounted:', await page.locator('[data-dsh-remote-ide-col] .explorerBody, [data-dsh-remote-ide-col] [class*="explorerBody"]').count())

// Open a terminal.
try {
  const newTerm = page.getByRole('button', { name: /新建终端|New terminal/i }).first()
  if (await newTerm.count()) {
    await newTerm.click()
    console.log('terminal opened')
  }
} catch (e) { console.log('terminal open failed:', e.message) }

// Type into the terminal (xterm input).
try {
  const termHost = page.locator('[data-dsh-remote-ide-col] .xterm, [data-dsh-remote-ide-col] textarea').first()
  if (await termHost.count()) {
    await termHost.click()
    await page.keyboard.type('echo crash-test; ls -la; uname -a\n', { delay: 20 })
    console.log('typed into terminal')
  }
} catch (e) { console.log('terminal input failed:', e.message) }

console.log('--- phase 4: with terminal + commands, idle 12s ---')
await sleep(12000)
console.log(await stats())

console.log('--- console errors ---')
console.log(consoleErrors.slice(0, 30).join('\n') || '(none)')

await browser.close()
