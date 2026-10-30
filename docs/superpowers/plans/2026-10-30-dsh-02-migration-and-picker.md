# DSH 0.2.x 迁移 + 工作区选择器双栏重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件在 DSH 0.2.1-rc.5 上完整可用，并把工作区选择器重构为双栏工作台。

**Architecture:** 先做 host 半契约迁移（设置退场 + 主机存储收敛 + jobs 推模式），再做 client 半契约改名，最后重做选择器 UI；每步独立可测、独立提交。

**Tech Stack:** TypeScript 5.7 · cordis 4.0.5 · ssh2 · tsdown · vitest · 手写 React.createElement client bundle。

**Spec:** `docs/superpowers/specs/2026-10-30-dsh-02-migration-and-picker-design.md`

## Global Constraints

- 只支持 DSH **0.2.1-rc.5**；不做 0.1.x 双版本分支。
- 主机/口令唯一权威 = `~/.dsh/dsh-remote-ide.json`（0600 + ACL）；口令绝不写 settings/日志。
- 跨边界输出必须过 `jsonSafe`；工具 output schema 与返回逐字段对齐。
- client 半只用 `React.createElement`，零 JSX、零 HTML sink；远端目录名只进 children。
- 选择态禁止边线条/描边；颜色只用 `--dsw-alias-*`。
- 同一文件的编辑必须串行；绝不动正在承载会话的 4500 实例。
- 每个任务结束 `pnpm typecheck && pnpm test` 必须绿，再提交。

---

### Task 1: 依赖升级 + 设置面退场 + 主机存储收敛

**Files:**
- Modify: `package.json`
- Modify: `src/index.ts:1-60,145-200`
- Modify: `src/typert.ts:1-60,140-330`
- Create: `src/legacy-import.ts`
- Create: `tests/legacy-import.test.ts`
- Modify: `tests/typert.test.ts`
- Delete: `src/host-settings.ts`
- Move type: `SshHostConfig` → `src/protocol.ts`

**Interfaces:**
- Produces: `importLegacyHosts(opts: { storeFile?: string; settingsFile?: string }): Promise<{ imported: number; skipped: number }>`
- Produces: `SshHostConfig` exported from `src/protocol.ts`.
- Produces: `SshRemoteService.listHosts()` unchanged wire shape `{ hosts, secrets }`.

- [ ] **Step 1: 升级依赖**

`package.json`：devDependencies 全部 `@deepseek-ai/*` 改 `0.2.1-rc.5`（cordis `^4.0.5`）；peerDependencies 全部改 `^0.2.1-rc.5`；新增 `dependencies: { "js-yaml": "^4.1.0" }`，devDependencies 加 `@types/js-yaml`。

```bash
pnpm install
```

- [ ] **Step 2: 先让类型检查暴露全部破坏点**

```bash
pnpm typecheck 2>&1 | head -40
```

Expected: 报 `settingsNamespace`/`installSettingsSection` 不存在、`JobHooks.readOutput` 不存在。

- [ ] **Step 3: 迁移 SshHostConfig 到 protocol.ts**

把 `src/host-settings.ts:25-47` 的 `SshHostConfig` 接口原样移入 `src/protocol.ts`（导出），并让 `src/typert.ts`、`tests/typert.test.ts` 从 `../src/protocol` 导入。`HostConfigSchema` 不再需要（settings 退场），随 `host-settings.ts` 删除。

- [ ] **Step 4: 重写 typert 的主机读写为 store-only**

`src/typert.ts`：删除 `SettingsScope`/`SettingsProvider`/`settingsScope`/`migratePasswordsIntoStore`/`syncStore`/`setSettings`；`hosts()` 改为从 `engine.list()` 投影：

```ts
private summaries(): SshHostSummary[] { return this.runtime.engine.list() }

listHosts(): { hosts: Record<string, Omit<SshHostConfig, 'password'>>; secrets: Record<string, boolean> } {
  const hosts: Record<string, Omit<SshHostConfig, 'password'>> = {}
  const secrets: Record<string, boolean> = {}
  for (const s of this.summaries()) {
    hosts[s.alias] = {
      id: s.alias, name: s.description ?? s.alias, host: s.host, port: s.port, user: s.user,
      authType: s.auth === 'password' ? 'password' : 'key',
      proxyJump: s.proxyJump, description: s.description,
    }
    secrets[s.alias] = s.auth === 'password'
  }
  return jsonSafe({ hosts, secrets })
}
```

`saveHost()` 只保留 `engine.upsertHost(...)` 调用（删除 `settings.update` 分支）；`deleteHost()` 改为 `engine.removeHost(id)`（若 engine 无此方法，用 `upsertHost` 同文件已有删除路径，先 grep 确认）。

- [ ] **Step 5: 写迁移失败测试**

`tests/legacy-import.test.ts`：

```ts
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importLegacyHosts } from '../src/legacy-import'

describe('legacy settings → store import', () => {
  it('imports hosts when store is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
    const settingsFile = join(dir, 'settings.yaml')
    const storeFile = join(dir, 'store.json')
    writeFileSync(settingsFile, [
      'dsh-remote-ide-hosts:',
      '  hosts:',
      '    web-1:',
      '      id: web-1',
      '      name: web-1',
      '      host: 10.0.0.5',
      '      port: 22',
      '      user: root',
      '      authType: key',
      '      privateKeyPath: ~/.ssh/id_ed25519',
    ].join('\n'))
    const result = await importLegacyHosts({ settingsFile, storeFile })
    expect(result.imported).toBe(1)
    const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
    expect(disk.hosts[0].host).toBe('10.0.0.5')
    expect(disk.hosts[0].auth.kind).toBe('key')
  })

  it('is a no-op when store already has hosts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
    const settingsFile = join(dir, 'settings.yaml')
    const storeFile = join(dir, 'store.json')
    writeFileSync(storeFile, JSON.stringify({ hosts: [{ alias: 'keep', host: 'h', port: 22, user: 'u', auth: { kind: 'key', keyPath: '' }, proxyJump: [], tags: [], createdAt: 0, updatedAt: 0 }] }))
    writeFileSync(settingsFile, 'dsh-remote-ide-hosts:\n  hosts: {}\n')
    expect((await importLegacyHosts({ settingsFile, storeFile })).imported).toBe(0)
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

```bash
pnpm vitest run tests/legacy-import.test.ts
```

Expected: FAIL，`importLegacyHosts` 不存在。

- [ ] **Step 7: 实现 legacy-import.ts**

```ts
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { load } from 'js-yaml'

export async function importLegacyHosts(opts: { storeFile: string; settingsFile: string }): Promise<{ imported: number; skipped: number }> {
  if (existsSync(opts.storeFile)) {
    const raw = JSON.parse(readFileSync(opts.storeFile, 'utf8')) as { hosts?: unknown[] }
    if ((raw.hosts?.length ?? 0) > 0) return { imported: 0, skipped: 0 }
  }
  if (!existsSync(opts.settingsFile)) return { imported: 0, skipped: 0 }
  const doc = load(readFileSync(opts.settingsFile, 'utf8')) as Record<string, unknown> | null
  const section = doc?.['dsh-remote-ide-hosts'] as { hosts?: Record<string, Record<string, unknown>> } | undefined
  const hosts = section?.hosts ?? {}
  const entries = Object.entries(hosts).map(([alias, cfg]) => ({
    alias,
    host: String(cfg.host ?? ''),
    port: Number(cfg.port ?? 22),
    user: String(cfg.user ?? ''),
    auth: cfg.authType === 'password'
      ? { kind: 'password', password: String(cfg.password ?? '') }
      : { kind: 'key', keyPath: String(cfg.privateKeyPath ?? '') },
    proxyJump: Array.isArray(cfg.proxyJump) ? cfg.proxyJump : [],
    description: typeof cfg.description === 'string' ? cfg.description : undefined,
    tags: [], createdAt: Date.now(), updatedAt: Date.now(),
  })).filter((e) => e.host !== '' && e.user !== '')
  if (entries.length === 0) return { imported: 0, skipped: 0 }
  mkdirSync(dirname(opts.storeFile), { recursive: true })
  writeFileSync(opts.storeFile, JSON.stringify({ hosts: entries }, null, 2), { mode: 0o600 })
  return { imported: entries.length, skipped: Object.keys(hosts).length - entries.length }
}
```

- [ ] **Step 8: index.ts 接线**

- 删除 `installSettingsSection`、`REMOTE_IDE_SETTINGS_NAMESPACE`、`installHostSettings`、`setSettings`。
- `apply(ctx, config)` 内：`const resolved = (): Config => ({ enabled: config?.enabled ?? DEFAULT_ENABLED, maxReadBytes: config?.maxReadBytes, announceToAgent: config?.announceToAgent ?? DEFAULT_ANNOUNCE })`；`sync()` 用 `resolved()`。
- `ctx.inject(['typert'], ...)` 构造 `new SshRemoteService(scope, runtime)`。
- 启动时调用 `importLegacyHosts({ storeFile: runtime.engine.storeFile, settingsFile: join(dshHome, 'settings.yaml') })`（storeFile 从 engine 暴露；若没有，用 `~/.dsh/dsh-remote-ide.json` 解析函数复用）。

- [ ] **Step 9: 全量验证**

```bash
pnpm typecheck && pnpm test
```

Expected: 全绿（jobs 相关类型错误留到 Task 2，如阻塞则本任务临时用 `as any` 并标注 TODO，Task 2 删除）。

- [ ] **Step 10: 提交**

```bash
git add package.json pnpm-lock.yaml src/protocol.ts src/typert.ts src/index.ts src/legacy-import.ts tests/legacy-import.test.ts tests/typert.test.ts
git rm src/host-settings.ts
git commit -m "feat(host)!: move hosts to the 0600 store and drop the settings namespace for DSH 0.2"
```

---

### Task 2: jobs 生产者改推模式

**Files:**
- Modify: `src/job-runner.ts:30-200`
- Modify: `tests/job-runner.test.ts`

**Interfaces:**
- `startRemoteJob(deps, spec)` 返回不变 `{ kind:'background', jobId }`。
- 生产者内部改用 `job.append(text)`；`done` 解析 `{ status, detail?, result? }`。

- [ ] **Step 1: 改测试（fake jobs）**

`tests/job-runner.test.ts` 的 fake `jobs.start` 捕获 spec，并暴露 `appends: string[]`：

```ts
function makeFakeJobs() {
  const jobs = { appends: [] as string[], start(spec: any) {
    const handle = { id: 'ssh-1', append: (t: string) => jobs.appends.push(t), updateProgress: () => {} }
    const hooks = spec.run(handle)
    jobs.hooks = hooks
    return 'ssh-1'
  } }
  return jobs as any
}
```

新增断言：泵到新日志后 `jobs.appends.join('')` 含 `REMOTE_PROC_OK`；cancel 后 `done` 为 `{ status:'killed' }`。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run tests/job-runner.test.ts
```

Expected: FAIL（`job.append` 未调用 / `done` 形状不符）。

- [ ] **Step 3: 实现推模式**

```ts
const jobId = jobs.start({
  kind: 'ssh',
  label: spec.command,
  outputLimitBytes: OUTPUT_LIMIT_BYTES,
  ...(spec.agent !== undefined ? { owner: spec.agent.id } : {}),
  run: (job) => buildHooks(engine, spec, pidPath, logPath, job),
})
```

`pump()` 成功拉到新字节后：

```ts
if (r.success && r.stdout !== '') {
  cursor += 1
  job.append(r.stdout)
}
```

删除 `pending` 与 `readOutput` 返回；`done` 的 `finish` 不再带 `output`。

- [ ] **Step 4: 全量验证**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 5: 提交**

```bash
git add src/job-runner.ts tests/job-runner.test.ts
git commit -m "feat(jobs)!: adopt the 0.2 push producer API (job.append) for remote background jobs"
```

---

### Task 3: client 契约改名（0.2）

**Files:**
- Modify: `client/index.js:1070-1120`
- Modify: `package.json:50-56`

- [ ] **Step 1: 改名 + inject**

```js
// client/index.js
function workspacesService(ctx) {
  try { return ctx.get('uiWorkspace') } catch { return undefined }
}
```

`package.json`：

```json
"inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-workspace"]
```

- [ ] **Step 2: 验证**

```bash
node scripts/verify-client-security.mjs && pnpm typecheck && pnpm test
```

Expected: 安全断言全过；类型与单测绿。

- [ ] **Step 3: 提交**

```bash
git add client/index.js package.json
git commit -m "fix(client): use the 0.2 uiWorkspace service and drop the removed client-runtime inject edge"
```

---

### Task 4: 双栏工作台选择器

**Files:**
- Modify: `client/index.js:794-965`（WorkspacePicker 及其子组件）
- Modify: `client/index.js:132-390`（CSS 常量，新增 `.dri-rail*` / `.dri-pane*`）

**Interfaces:**
- 保持 `directory-flow` owner props `{ open, busy, onPicked, onCancel, onError }` 不变。
- 复用 `pickerDeps` 的 `pickDirectory/listRemoteDir/mkdirRemote/createPlaceholder/testConnection/saveHost/load`；新增传入 `placeholders`。

- [ ] **Step 1: 数据接线**

`applyInner` 的 slots 注入处，给 `WorkspacePicker` 传 `placeholders: state.placeholders`（或直接让组件读 `useStore().placeholders`）。

- [ ] **Step 2: 拆组件（同一文件内）**

```js
function SourceRail({ hosts, placeholders, activeHost, onPickLocal, onPickRecent, onPickHost, onAddHost, query, setQuery }) { ... }
function DirPane({ path, entries, loading, error, onNavigate, onUse, onCreateDir, busy, creating }) { ... }
```

- 左栏：本机 / 最近（`placeholders` 按 `localPath` 去重）/ 主机（>6 台显示搜索）。
- 右栏：面包屑（`splitPath` + `shortenMiddle`）、路径编辑（Enter 跳转）、列表、空/错/载入态、底栏。
- 选择态：`background: var(--dsw-alias-interactive-bg-hover)`，无边框。

- [ ] **Step 3: CSS**

```css
.dri-picker{display:flex;width:900px;max-width:94vw;height:min(72vh,600px)}
.dri-rail{width:248px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto}
.dri-pane{flex:1;min-width:0;display:flex;flex-direction:column}
.dri-crumb{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dri-dirName{font-family:ui-monospace,Consolas,monospace}
```

- [ ] **Step 4: 文案**

`选择文件夹…` / `使用此目录` / `新建文件夹` / `添加主机` / `正在创建工作区…` / 空态「这个文件夹是空的」+「直接使用，或先新建一个文件夹。」/ 错误行内展示。

- [ ] **Step 5: 验证**

```bash
node scripts/verify-client-security.mjs
```

真机验证在 Task 5。

- [ ] **Step 6: 提交**

```bash
git add client/index.js
git commit -m "feat(client): redesign the workspace picker as a dual-pane workbench"
```

---

### Task 5: 0.2 隔离环境验收

**Files:**
- Modify: `scripts/e2e-real-server.mjs`（如需适配 0.2 的 jobs 形状）

- [ ] **Step 1: 建隔离环境**

```bash
mkdir -p .tmp/dsh02 && npm i --prefix .tmp/dsh02 @deepseek-ai/dsh@0.2.1-rc.5
export DSH_HOME="$PWD/.tmp/dsh02-home"
.tmp/dsh02/node_modules/.bin/dsh web --port 4600
```

- [ ] **Step 2: 单测 + E2E**

```bash
pnpm test
node scripts/e2e-real-server.mjs wsl-e2e   # 若脚本连的是 4500，改用环境变量指向 4600
```

- [ ] **Step 3: 真机截图**

用 headless Edge 打开 `http://127.0.0.1:4600`，创建云端工作区，截取双栏对话框亮/暗两套；目检空态、长路径、选择态无边线。

- [ ] **Step 4: 提交**

```bash
git add scripts/ docs/screenshots/
git commit -m "test: verify the plugin against DSH 0.2.1-rc.5 in an isolated profile"
```

---

### Task 6: 0.4.0 发布准备

**Files:**
- Modify: `package.json`（version 0.4.0）
- Modify: `CHANGELOG.md`
- Modify: `README.md` / `README.zh-CN.md`（定位文案 + 兼容性）
- Modify: `AGENTS.md` / `memory/`（交接同步）

- [ ] **Step 1: 版本与变更日志**

```md
## 0.4.0 — 2026-10-30
### Breaking
- Requires DeepSeek Harness >= 0.2.1-rc.5 (settings namespace API removed upstream).
- Host metadata now lives only in the 0600 store; legacy `dsh-remote-ide-hosts` settings are imported once on first start.
### Added
- Dual-pane workspace picker: local / recent / hosts rail + breadcrumb, editable path, empty/error states.
```

- [ ] **Step 2: README 定位**

首行 tagline 改为 `Remote Linux workspaces over SSH for DeepSeek Harness`（中英一致），安装段加兼容性说明。

- [ ] **Step 3: 验证 + 提交**

```bash
pnpm typecheck && pnpm test && pnpm build
git add -A && git commit -m "release: 0.4.0 — DSH 0.2 support and the dual-pane workspace picker"
```

## Self-Review

- Spec A1-A5 对应 Task 1-3、5；B1-B6 对应 Task 4；发布对应 Task 6。
- 已知风险：`engine.storeFile` 暴露（Task 1 Step 8）需先确认；`removeHost` 方法名需 grep；若不存在则用 store 层删除。
- 测试口径：client 路径纯函数不做假单测，真机截图验收（见 spec B6）。
