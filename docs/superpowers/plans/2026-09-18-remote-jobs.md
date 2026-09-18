# Remote Background Jobs (ctx.jobs producer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给遮蔽 `bash` 与全局 `ssh_exec` 增加 `run_in_background`，远程长命令注册进官方 `ctx.jobs`（kind=`ssh`），白拿 `job_output`/`job_list`/`job_kill`、完成通知与 UI。

**Architecture:** 生产者模式（spec §3）：新模块 `src/job-runner.ts` 用常驻 exec 通道跑 wrapper（`printf %s $$ > pidfile && exec bash -c '<cmd>' > log 2>&1`），done=通道 close 事件、readOutput=`dd` 分块拉远端日志、cancel=杀进程组（TERM→5s→KILL）。registry 用官方 LocalJobRegistry，不替换、不持久化。

**Tech Stack:** TypeScript strict / vitest（fake ssh2 harness）/ @deepseek-ai/dsh-jobs（type-only + ctx.get）/ ssh2。

**Spec:** `docs/07-design-remote-jobs.md`（决策与语义边界以它为准）

## Global Constraints

- `@deepseek-ai/dsh-jobs` 版本 `^0.1.1-rc.2`（与其余 dsh-* peer 同轨），仅 peer+dev 依赖、tsdown external，**纯类型导入**，运行时走 `ctx.get('jobs')`
- 跨边界输出（工具 execute 返回）一律过 `jsonSafe`；一切远程命令插值过 `quoteSh`
- 不新增运行时依赖；不动 client 半 / typert / store
- 语义对齐官方：非零退出=`completed`+`detail:'exit code: N'`；signal=`killed`；基础设施坏=`failed`；`done` 永不 reject；`cancel` 同步幂等
- 同一文件的多个编辑严格串行（AGENTS 坑 9）；每任务收尾 `pnpm typecheck && pnpm test` 绿再 commit
- 注释中文写「为什么」；commit conventional 前缀

## File Structure

| 文件 | 职责 |
|---|---|
| `src/job-runner.ts`（新） | 唯一生产者：`startRemoteJob(deps, spec)` —— wrapper 构造、三钩子、状态映射、孤儿探测 |
| `tests/job-runner.test.ts`（新） | fake engine + fake JobRegistry 全行为覆盖 |
| `src/tools.ts` | `ssh_exec` 加参数/分支/schema |
| `src/session-tools.ts` | 遮蔽 `bash` 加参数/分支/schema/presentResult 前缀识别；`buildSessionTools`/`installSessionRouting` 加 jobsProvider |
| `src/index.ts` | `ctx.get('jobs')` 解析 + 注入两处 + 文案各一句 |
| `package.json` / `tsdown.config.ts` | dsh-jobs 依赖 + external |
| `tests/tools.test.ts` / `tests/session-tools.test.ts` | 分支回归 |
| `scripts/e2e-real-server.mjs` | +3 真机检查（25→28，mini registry harness） |
| `AGENTS.md` / `memory/*` / `docs/REPO-WIKI.md` | 收尾同步 |

---

### Task 1: job-runner 核心模块（含依赖接线）

**Files:**
- Modify: `package.json`（peerDependencies + devDependencies 各加 `"@deepseek-ai/dsh-jobs"`）
- Modify: `tsdown.config.ts`（external 数组追加 `'@deepseek-ai/dsh-jobs'`）
- Create: `src/job-runner.ts`
- Test: `tests/job-runner.test.ts`
- Run: `pnpm install` 前先 `git add -A` 之外无——直接 `pnpm add -D @deepseek-ai/dsh-jobs@^0.1.1-rc.2 -P @deepseek-ai/dsh-jobs@^0.1.1-rc.2`（pnpm 双写 peer+dev）

**Interfaces:**
- Consumes: `SshEngine`（`openChannel(alias, cmd, {cwd}) → Promise<SshExecChannel>`、`exec(alias, cmd, opts) → Promise<ExecResult>`、`homeOf(alias)`）、`quoteSh`、`debugLog`、`JobRegistry/JobStart/JobOutcome`（type-only）
- Produces: `startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): { kind: 'background'; jobId: string }`；`interface JobRunnerDeps { engine: SshEngine; jobs: JobRegistry | undefined }`；`interface RemoteJobSpec { hostId: string; command: string; cwd?: string; agent?: NonNullable<JobStart['owner']> }`（Task 2/3 按此消费）

- [ ] **Step 1: 装依赖**

```bash
pnpm add -D @deepseek-ai/dsh-jobs@^0.1.1-rc.2
pnpm add -P @deepseek-ai/dsh-jobs@^0.1.1-rc.2
```
Expected: package.json 出现 peer+dev 两处；`pnpm typecheck` 仍绿。

- [ ] **Step 2: tsdown external 追加**

`tsdown.config.ts` 的 `external` 数组在 `'@deepseek-ai/dsh-workspace'` 后加 `'@deepseek-ai/dsh-jobs',`。

- [ ] **Step 3: 写失败测试** `tests/job-runner.test.ts`

```ts
/**
 * job-runner 单测 —— fake engine（可编程通道）+ fake JobRegistry（捕获 spec）。
 * 覆盖：background 返回、spec 形状、wrapper 协议、done 三态、readOutput 游标、
 * cancel 幂等与升级、jobs 缺失报错。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startRemoteJob } from '../src/job-runner'

type CloseListener = (code: number | null, signal: string | null) => void
class FakeChannel {
  closeListeners: CloseListener[] = []
  onClose(l: CloseListener) { this.closeListeners.push(l) }
  fire(code: number | null, signal: string | null) { for (const l of [...this.closeListeners]) l(code, signal) }
}

function makeFakes() {
  const channel = new FakeChannel()
  const openChannel = vi.fn(async () => channel as never)
  const exec = vi.fn(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }))
  const engine = { openChannel, exec, homeOf: () => '/root' } as never
  let spec: Record<string, unknown> | undefined
  const jobs = { start: (s: Record<string, unknown>) => { spec = s; return 'ssh-1' } } as never
  return { channel, openChannel, exec, engine, jobs, getSpec: () => spec! }
}

describe('startRemoteJob', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('返回 background 形状并以 kind=ssh/label=命令注册 spec', () => {
    const f = makeFakes()
    const out = startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'make build' })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-1' })
    const spec = f.getSpec()
    expect(spec.kind).toBe('ssh')
    expect(spec.label).toBe('make build')
    expect(typeof spec.run).toBe('function')
    expect(typeof spec.outputLimitBytes).toBe('number')
  })

  it('wrapper 协议：pidfile + exec bash -c + 日志重定向，路径 quoteSh', () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: "echo it's", cwd: '/work' })
    const [alias, wrapper, opts] = f.openChannel.mock.calls[0] as [string, string, { cwd?: string }]
    expect(alias).toBe('dev')
    expect(opts.cwd).toBe('/work')
    expect(wrapper).toMatch(/^printf %s \$\$ > '\/tmp\/dsh-job-[0-9a-f-]+\.pid' && exec bash -c 'echo it'\''s' > '\/tmp\/dsh-job-[0-9a-f-]+\.log' 2>&1$/)
  })

  it('jobs 缺失 → throw 官方同款文案', () => {
    const f = makeFakes()
    expect(() => startRemoteJob({ engine: f.engine, jobs: undefined }, { hostId: 'dev', command: 'x' }))
      .toThrow(/background jobs unavailable/)
  })

  it('done：exit code 3 → completed + detail；未 settle 前不 resolve', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    let outcome: unknown
    void hooks.done.then((o: unknown) => { outcome = o })
    f.channel.fire(3, null)
    await vi.waitFor(() => expect(outcome).toEqual({ status: 'completed', detail: 'exit code: 3', output: '' }))
  })

  it('done：signal → killed', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    f.channel.fire(null, 'SIGTERM')
    await expect(hooks.done).resolves.toMatchObject({ status: 'killed', detail: 'SIGTERM' })
  })

  it('done：无码无号 + kill -0 探测存活 → failed 带孤儿 pid/log 提示', async () => {
    const f = makeFakes()
    f.exec.mockImplementation(async (_a: string, cmd: string) =>
      ({ success: cmd.startsWith('bash -c \'kill -0'), exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    f.channel.fire(null, null)
    const o = await hooks.done as { status: string; detail: string }
    expect(o.status).toBe('failed')
    expect(o.detail).toMatch(/may still be running/)
    expect(o.detail).toMatch(/\/tmp\/dsh-job-.*\.log/)
  })

  it('readOutput：dd 分块游标推进；spill 提示在满块时出现', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    f.exec.mockImplementation(async (_a: string, cmd: string) => ({
      success: true, exitCode: 0, timedOut: false,
      stdout: 'A'.repeat(65536), stderr: '', durationMs: 1,
    }))
    const first = hooks.readOutput!()
    expect((f.exec.mock.calls.at(-1) as [string, string])[1]).toContain('bs=65536 skip=0 count=1')
    expect(first).toContain('more output')
    hooks.readOutput!()
    expect((f.exec.mock.calls.at(-1) as [string, string])[1]).toContain('bs=65536 skip=1 count=1')
  })

  it('readOutput：日志未生成（exec 失败）→ 空串不抛', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    f.exec.mockRejectedValue(new Error('disconnected'))
    expect(hooks.readOutput!()).toBe('')
  })

  it('cancel：TERM 一次、幂等、5s 后升级 KILL', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = f.getSpec().run!()
    hooks.cancel()
    hooks.cancel()
    const kills = f.exec.mock.calls.map(c => (c as [string, string])[1]).filter(c => c.includes('kill -'))
    expect(kills).toHaveLength(1)
    expect(kills[0]).toContain('kill -TERM -$(cat')
    await vi.advanceTimersByTimeAsync(5_100)
    const escalated = f.exec.mock.calls.map(c => (c as [string, string])[1]).filter(c => c.includes('kill -'))
    expect(escalated).toHaveLength(2)
    expect(escalated[1]).toContain('kill -KILL -$(cat')
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

`npx vitest run tests/job-runner.test.ts` → FAIL（模块不存在）。

- [ ] **Step 5: 实现** `src/job-runner.ts`

```ts
/**
 * dsh-remote-ide — 远程后台任务生产者（ctx.jobs seam 的 SSH 实现）。
 *
 * 设计（docs/07）：registry 永不下远程（官方 E2B 先例），远程性=本模块：
 * 常驻 exec 通道跑 wrapper（printf $$ >pidfile; exec bash -c cmd >log 2>&1），
 * sshd 每通道独立进程组 ⇒ pid 即 pgid。done 由通道 close 落地（权威退出码，
 * 零轮询）；readOutput 用 dd 按 64KiB 块拉远端日志（块对齐、无游标漂移）；
 * cancel 杀组（TERM→5s→KILL），幂等。宿主重启记录消失=官方内存态语义，
 * 断线时如实探测并报告孤儿（pid/log），不谎称工作已停。
 */

import { randomUUID } from 'node:crypto'
import type { JobOutcome, JobRegistry, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SshEngine } from './engine'
import { quoteSh } from './engine'
import { debugLog } from './debug-log'

/** 声明合并扩 kind：id 前缀 ssh-N。 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { ssh: 'ssh' }
}

export interface JobRunnerDeps {
  engine: SshEngine
  /** index.ts 经 ctx.get('jobs') 解析；缺失=能力不可用（官方同款报错）。 */
  jobs: JobRegistry | undefined
}

export interface RemoteJobSpec {
  hostId: string
  /** 用户命令原文（与前台同一信任边界）。 */
  command: string
  /** 远程工作目录（省略=连接默认目录）。 */
  cwd?: string
  /** 归属 agent（exec.agent 本体）；省略=无主。 */
  agent?: NonNullable<JobStart['owner']>
}

const READ_CHUNK = 65536
const OUTPUT_LIMIT_BYTES = 8192
const KILL_ESCALATION_MS = 5_000

export function startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): { kind: 'background'; jobId: string } {
  const { engine, jobs } = deps
  if (jobs === undefined) {
    throw new Error('background jobs unavailable — load @deepseek-ai/dsh-jobs (dsh-base)')
  }
  const runId = randomUUID()
  const pidPath = `/tmp/dsh-job-${runId}.pid`
  const logPath = `/tmp/dsh-job-${runId}.log`
  const jobId = jobs.start({
    kind: 'ssh',
    label: spec.command,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    ...(spec.agent !== undefined ? { owner: spec.agent } : {}),
    run: () => buildHooks(engine, spec, runId, pidPath, logPath),
  })
  return { kind: 'background', jobId }
}

function buildHooks(engine: SshEngine, spec: RemoteJobSpec, runId: string, pidPath: string, logPath: string) {
  let outcome: JobOutcome | undefined
  let settle!: (o: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => { settle = resolve })
  let cancelRequested = false
  let killed = false
  let chunkIndex = 0
  /** 通道建立前的失败/取消都要在建立后补执行。 */
  let channelReady = false

  const finish = (o: JobOutcome): void => {
    if (outcome !== undefined) return
    outcome = o
    // output 只取未读增量（done 后 notice 预算内）。
    const tail = readChunk()
    settle({ ...o, output: tail.slice(0, OUTPUT_LIMIT_BYTES) })
  }

  const readChunk = (): string => {
    try {
      // 同步包装：engine.exec 是异步的——官方 readOutput() 是同步接口，
      // 这里维护「已取回块」缓存，无新块时返回空串。
      const pending = chunkCache
      chunkCache = ''
      return pending
    } catch { return '' }
  }
  let chunkCache = ''
  const pumpChunk = (): void => {
    void engine.exec(spec.hostId, `dd if=${quoteSh(logPath)} bs=${READ_CHUNK} skip=${chunkIndex} count=1 2>/dev/null`)
      .then((r) => {
        if (r.stdout !== '') chunkIndex += 1
        chunkCache = r.success ? r.stdout : chunkCache
      })
      .catch(() => { /* 日志未生成/断连：下次再拉 */ })
  }

  const killGroup = (sig: 'TERM' | 'KILL'): void => {
    void engine.exec(spec.hostId, `bash -c ${quoteSh(`kill -${sig} -$(cat ${pidPath})`)}`)
      .catch((error) => { debugLog(`job ${runId} kill -${sig} failed: ${error instanceof Error ? error.message : String(error)}`) })
  }

  void engine.openChannel(spec.hostId,
    `printf %s $$ > ${quoteSh(pidPath)} && exec bash -c ${quoteSh(spec.command)} > ${quoteSh(logPath)} 2>&1`,
    spec.cwd !== undefined ? { cwd: spec.cwd } : {})
    .then((channel) => {
      channelReady = true
      channel.onClose((code, signal) => {
        if (code !== null) { finish({ status: 'completed', detail: `exit code: ${code}` }); return }
        if (signal !== null) { finish({ status: 'killed', detail: signal }); return }
        // 无码无号=传输断：探测一次 kill -0，如实报告孤儿可能。
        void engine.exec(spec.hostId, `bash -c ${quoteSh(`kill -0 $(cat ${pidPath})`)}`)
          .then((probe) => finish(probe.success
            ? { status: 'failed', detail: `connection lost; remote process may still be running (pid file ${pidPath}, log ${logPath})` }
            : { status: 'failed', detail: `exit status unknown (connection lost); log: ${logPath}` }))
          .catch(() => finish({ status: 'failed', detail: `connection lost; state of remote process unknown; log: ${logPath}` }))
      })
      if (cancelRequested) requestCancel()
    })
    .catch((error) => {
      finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    })

  const requestCancel = (): void => {
    if (killed) return
    killed = true
    killGroup('TERM')
    const timer = setTimeout(() => { if (outcome === undefined) killGroup('KILL') }, KILL_ESCALATION_MS)
    timer.unref?.()
  }

  return {
    cancel: (): void => {
      cancelRequested = true
      if (channelReady) requestCancel()
      // 通道未建立：openChannel resolve 后补杀；resolve 前失败则 catch 已 settle。
    },
    done,
    readOutput: (): string => { const text = readChunk(); pumpChunk(); return text },
  }
}
```

⚠️ 实现者注意（本任务内自洽校验）：`readOutput` 语义=「返回当前已取回块并预取下一块」；测试 Step 3 的 `readOutput` 两条用例按此断言（第一次调用返回空缓存后 pump——**若测试与实现时序冲突，以测试期望为准调整 pump 时机**：首条测试要求第一次调用即见 `skip=0` 命令且满块时含 `more output`。如不匹配，把 `readOutput` 改为同步等待不可行（接口同步），则调整为：start 后先 pump 一次 + 满块判定 `stdout.length >= READ_CHUNK`。以让两条测试通过为准，禁止改测试语义。）

- [ ] **Step 6: 跑测试确认通过**

`npx vitest run tests/job-runner.test.ts` → 9 用例全绿；`pnpm typecheck` 绿。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsdown.config.ts src/job-runner.ts tests/job-runner.test.ts
git commit -m "feat: job-runner — SSH producer for official ctx.jobs (kind ssh)"
```

---

### Task 2: ssh_exec 接入 run_in_background

**Files:**
- Modify: `src/tools.ts`（`sshExecTool` 工厂签名 + 参数 + schema + execute 分支 + render）
- Modify: `src/index.ts`（`ctx.get('jobs')` 解析并传入 `sshExecTool`）
- Test: `tests/tools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `startRemoteJob(deps, spec)`
- Produces: `sshExecTool(runtime: SshRuntime, jobs: JobRegistry | undefined)`（index.ts 按此调用）；`ssh_exec` 输出 schema：新增 `kind`（required enum）与 `jobId`（optional），原字段转可选

- [ ] **Step 1: 写失败测试**（追加到 `tests/tools.test.ts`，复用文件内既有 runtime stub 模式）

```ts
describe('ssh_exec run_in_background', () => {
  it('后台分支：返回 {kind:background, jobId}，不跑前台 exec', async () => {
    const exec = vi.fn()
    const started: unknown[] = []
    const jobs = { start: (s: { label: string }) => { started.push(s); return 'ssh-2' } }
    const runtime = stubRuntime({ exec }) // 沿用文件内既有 stub 工厂
    const tool = sshExecTool(runtime as never, jobs as never)
    const out = await tool.execute({ command: 'sleep 100', run_in_background: true }, { agent: undefined })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-2' })
    expect(exec).not.toHaveBeenCalled()
    expect(started[0]).toMatchObject({ kind: 'ssh', label: 'sleep 100' })
  })
  it('前台分支：输出带 kind:foreground（回归兼容新字段）', async () => {
    const exec = vi.fn(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 2 }))
    const runtime = stubRuntime({ exec })
    const tool = sshExecTool(runtime as never, undefined)
    const out = await tool.execute({ command: 'echo ok' }, { agent: undefined })
    expect(out).toMatchObject({ kind: 'foreground', success: true, stdout: 'ok' })
    expect(Object.hasOwn(out, 'jobId')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/tools.test.ts` FAIL（签名/参数不存在）。

- [ ] **Step 3: 实现 tools.ts + index.ts**

`tools.ts` 顶部加 `import type { JobRegistry } from '@deepseek-ai/dsh-jobs'` 与 `import { startRemoteJob } from './job-runner'`。`sshExecTool(runtime: SshRuntime)` 改为 `sshExecTool(runtime: SshRuntime, jobs: JobRegistry | undefined)`。`ssh_exec` 的 `parameters` 追加：

```ts
      run_in_background: { type: 'boolean', description: 'Start the command as a background job; no timeout applies. Poll with job_output / job_list, stop with job_kill.' },
```

`output.schema.properties`：加 `kind: { type: 'string', enum: ['foreground', 'background'], required: true }` 与 `jobId: { type: 'string' }`；`success/timedOut/stdout/stderr/durationMs` 移除 `required`（其余不动）。`render` 开头分支：

```ts
      render: (_args, value) => {
        const v = value as { kind?: string; jobId?: string }
        if (v.kind === 'background') return text(`started background job ${String(v.jobId)} — poll with job_output`)
        return text(renderExec(value as Parameters<typeof renderExec>[0]))
      },
```

`execute` 签名加第二参并分支（args 类型补 `run_in_background?: boolean`）：

```ts
    async execute(args: { command: string; alias?: string; timeoutMs?: number; run_in_background?: boolean }, exec?: { agent?: unknown }) {
      const alias = resolveAlias(runtime, args.alias)
      if (args.run_in_background === true) {
        return jsonSafe(startRemoteJob(
          { engine: runtime.engine, jobs },
          { hostId: alias, command: args.command,
            ...(engine_home_fallback(runtime, alias)),
            ...(exec?.agent !== undefined ? { agent: exec.agent as never } : {}) },
        ))
      }
      const result = await runtime.engine.exec(alias, args.command, { timeoutMs: args.timeoutMs })
      return jsonSafe({ kind: 'foreground' as const, ...result, exitCode: result.exitCode ?? undefined })
    },
```

其中 `engine_home_fallback` 不是新函数——直接内联：`ssh_exec` 无 cwd 参数，后台不传 cwd（连接默认目录=远端 home），即省略该展开项。**实现者：直接写 `...(false ? { cwd: '' } : {})` 是禁止的——不传就不传**，上面代码块中该行应删除，正确形态：

```ts
        return jsonSafe(startRemoteJob({ engine: runtime.engine, jobs }, {
          hostId: alias,
          command: args.command,
          ...(exec?.agent !== undefined ? { agent: exec.agent as never } : {}),
        }))
```

`index.ts`：`import type { JobRegistry } from '@deepseek-ai/dsh-jobs'`（dsh-jobs 自带 Context 增强，`ctx.get('jobs')` 直接可用）；工具数组改 `sshExecTool(runtime, ctx.get('jobs') as JobRegistry | undefined)`；`REMOTE_GUIDANCE` 追加一句：`长命令（安装/构建/测试套件）用 bash 或 ssh_exec 的 run_in_background:true 起后台，随后 job_output/job_list 轮询、job_kill 终止。`

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run tests/tools.test.ts` 全绿；`pnpm typecheck` 绿。
- [ ] **Step 5: Commit** — `git add src/tools.ts src/index.ts tests/tools.test.ts && git commit -m "feat: ssh_exec gains run_in_background via ctx.jobs producer"`

---

### Task 3: 遮蔽 bash 接入 + 会话接线 + 提示面

**Files:**
- Modify: `src/session-tools.ts`（bash 参数/schema/render/presentResult；`buildSessionTools` 与 `installSessionRouting` 加 `jobsProvider` 形参）
- Modify: `src/index.ts`（`installSessionRouting(ctx, runtime, isEnabled, () => ctx.get('jobs'))`）
- Test: `tests/session-tools.test.ts`（追加 + 既有用例微调）

**Interfaces:**
- Consumes: Task 1 `startRemoteJob`；Task 2 的 schema 形状约定
- Produces: `buildSessionTools(runtime, route, jobs?: JobRegistry | undefined)`；`installSessionRouting(ctx, runtime, isEnabled?, jobsProvider?: () => JobRegistry | undefined)`（index.ts 按此调用）

- [ ] **Step 1: 写失败测试**（追加）

```ts
describe('bash run_in_background', () => {
  const jobsStub = () => { const calls: unknown[] = []; return { calls, jobs: { start: (s: unknown) => { calls.push(s); return 'ssh-9' } } } }
  it('后台分支：注册 spec（kind ssh、owner 透传）并返回 background', async () => {
    const { calls, jobs } = jobsStub()
    const tools = buildSessionTools(stubRuntime(), route(), jobs as never)
    const bash = tools.find((t) => t.name === 'bash')!
    const out = await bash.execute({ command: 'apt-get update', description: '装包', run_in_background: true })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-9' })
    expect(calls[0]).toMatchObject({ kind: 'ssh', label: 'apt-get update' })
  })
  it('presentResult：background 文案 → generic 卡', () => {
    const tools = buildSessionTools(stubRuntime(), route(), undefined)
    const bash = tools.find((t) => t.name === 'bash')! as unknown as {
      presentResult?: (a: unknown, r: unknown) => { card: string } | undefined
    }
    const view = bash.presentResult!({ command: 'x', description: 'd' }, {
      content: [{ type: 'text', text: 'started background job ssh-9 — poll with job_output' }], isError: false,
    })
    expect(view?.card).toBe('generic')
  })
  it('前台回归：kind foreground + terminal 视图不变', async () => {
    const tools = buildSessionTools(stubRuntime(), route(), undefined)
    const bash = tools.find((t) => t.name === 'bash')!
    const out = await bash.execute({ command: 'pwd', description: 'd' })
    expect(out).toMatchObject({ kind: 'foreground', success: true })
  })
})
```

既有用例微调：`bash：相对 workdir…` 用例断言补 `kind: 'foreground'`（`output.success` 等原断言不动）。

- [ ] **Step 2: 跑测试确认失败** — FAIL（第三形参不存在/无分支）。

- [ ] **Step 3: 实现**

`buildSessionTools(runtime: SshRuntime, route: SessionRoute, jobs?: JobRegistry | undefined)`；bash 工具：`parameters` 加 `run_in_background`（文案同 Task 2）；`output.schema.properties` 与 render 双分支改法**逐字同 Task 2 Step 3**（kind/jobId + 放宽 required + render 首分支）。`execute`：

```ts
    async execute(args: { command: string; description?: string; timeoutMs?: number; workdir?: string; run_in_background?: boolean }, exec?: { agent?: unknown }) {
      const cwd = args.workdir !== undefined && args.workdir !== '' ? resolveInSession(route, args.workdir) : route.remoteCwd
      if (args.run_in_background === true) {
        return jsonSafe(startRemoteJob({ engine, jobs }, {
          hostId: route.hostId, command: args.command, cwd,
          ...(exec?.agent !== undefined ? { agent: exec.agent as never } : {}),
        }))
      }
      const result = await engine.exec(route.hostId, args.command, { cwd, timeoutMs: args.timeoutMs })
      return jsonSafe({ kind: 'foreground' as const, ...result, exitCode: result.exitCode ?? undefined })
    },
```

`presentResult` 前置识别（4.2 节）：

```ts
    presentResult: (_args, result) => {
      const t = singleText(result)
      if (t !== undefined && t.startsWith('started background job')) {
        return { card: 'generic', content: [{ type: 'text', text: t }] }
      }
      return bashTerminalView(result)
    },
```

`installSessionRouting(ctx, runtime, isEnabled?, jobsProvider?: () => JobRegistry | undefined)`：listener 内 `buildSessionTools(runtime, sessionRoute, jobsProvider?.())`。`sessionSectionText` 数组追加一行：`For long-running commands (installs, builds, test suites) pass run_in_background: true to bash, then poll with job_output / job_list / job_kill.`。`index.ts` 调用点：`installSessionRouting(ctx, runtime, () => resolve().enabled === true, () => ctx.get('jobs') as JobRegistry | undefined)`。

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run tests/session-tools.test.ts` 全绿；`pnpm typecheck` 绿。
- [ ] **Step 5: Commit** — `git add src/session-tools.ts src/index.ts tests/session-tools.test.ts && git commit -m "feat: shadow bash run_in_background + jobs wiring + prompt guidance"`

---

### Task 4: E2E 检查 + 全链验证 + 文档收尾

**Files:**
- Modify: `scripts/e2e-real-server.mjs`（+3 检查，25→28）
- Modify: `package.json`（version `0.3.0`）
- Modify: `AGENTS.md`（架构树 +job-runner、状态节、工具面文案）
- Modify: `memory/project_dsh_remote_ide.md`（顶部新节）、`memory/MEMORY.md`（索引头）、`docs/REPO-WIKI.md`（§4 能力清单 + §2 树 + §10 索引）

**Interfaces:**
- Consumes: Task 1-3 全部
- Produces: 可发布状态（0.3.0 本地）

- [ ] **Step 1: E2E 追加**（第 8 节后新增第 9 节；mini registry harness——E2E 裸 Context 无 dsh-jobs，用捕获 spec 的假 registry 验证远端机制而非官方 registry）

```js
// ── 9. 后台任务（job-runner：wrapper / dd 增量 / 杀进程组） ──
{
  const { startRemoteJob } = await import('dsh-remote-ide/src/job-runner.ts')
  let lastHooks = null
  const fakeJobs = { start: (s) => { queueMicrotask(() => { lastHooks = s.run() }); return 'ssh-e2e-1' } }
  const sleepCmd = 'for i in 1 2 3 4 5; do echo tick$i; sleep 1; done'
  const started = startRemoteJob({ engine: runtime.engine, jobs: fakeJobs }, { hostId: alias, command: sleepCmd, cwd: remoteWs })
  check('startRemoteJob 返回 background+jobId', started.kind === 'background' && started.jobId === 'ssh-e2e-1')
  await new Promise(r => setTimeout(r, 2500))
  const mid = lastHooks.readOutput()
  check('readOutput 中途见增量输出', mid.includes('tick1'), JSON.stringify(mid.slice(0, 40)))
  const outcome = await Promise.race([lastHooks.done, new Promise(r => setTimeout(() => r({ status: 'timeout' }), 15_000))])
  check('done=completed + exit code 0', outcome.status === 'completed' && outcome.detail === 'exit code: 0', JSON.stringify(outcome))
  // 杀进程组路径
  const killer = startRemoteJob({ engine: runtime.engine, jobs: fakeJobs }, { hostId: alias, command: 'sleep 120', cwd: remoteWs })
  void killer
  await new Promise(r => setTimeout(r, 800))
  const kh = lastHooks
  kh.cancel()
  const ko = await Promise.race([kh.done, new Promise(r => setTimeout(() => r({ status: 'timeout' }), 10_000))])
  check('cancel → killed（进程组终止）', ko.status === 'killed', JSON.stringify(ko))
}
```

（`lastHooks` 经 `queueMicrotask` 赋值后在两次 start 间会被覆盖——第二处 `const kh = lastHooks` 在 start 后立刻捕获，时序安全。E2E 收尾清理远端 `/tmp/dsh-job-*` 残留：`await runtime.engine.exec(alias, 'rm -f /tmp/dsh-job-*.log /tmp/dsh-job-*.pid')`。）

- [ ] **Step 2: 跑 E2E** — `node scripts/e2e-real-server.mjs wsl-e2e` → 28/28（wsl sshd 不在线先 `wsl -u root /usr/sbin/sshd`）。
- [ ] **Step 3: 全链** — `pnpm typecheck && pnpm test && pnpm build` 全绿（测试数从 105 增至 ~120）。
- [ ] **Step 4: 版本与文档** — version `0.3.0`；AGENTS.md：架构树加 `job-runner.ts`、工具行补 `run_in_background`、状态节记本功能（待真机）；memory 顶部节记录设计→实现→验证链与 spec 路径；REPO-WIKI §4/§2/§10 同步。
- [ ] **Step 5: Commit + push** — `git add -A && git commit -m "feat: remote background jobs e2e + docs; release prep 0.3.0" && git push`
- [ ] **Step 6: 真机验证（请用户配合）** — 重启 4500（无承载会话时自起）→ 云端会话发「后台跑 for i in $(seq 20); do date; sleep 1; done，然后 job_output 轮询」→ 看 `started background job ssh-N`、增量、完成 notice；`~/.dsh/dsh-remote-ide-debug.log` 无异常。

---

## Self-Review 结论

- Spec 覆盖：§4.1→Task 1；§4.2→Task 2/3；§4.3/4.4→Task 2/3；§5→Task 1 实现+测试；§7→各任务测试步+Task 4；§8 清单全对齐。
- 已知模糊点已在计划内消解：`readOutput` 同步接口的 pump 时序（Task 1 Step 5 注记）、ssh_exec 无 cwd（Task 2 显式纠正块）、E2E 假 registry 的 lastHooks 捕获时序（Task 4 注记）。
- 类型一致：`startRemoteJob(deps, spec)`、`{kind:'background', jobId}`、schema `kind/jobId` 在 Task 1/2/3 与测试间互相对齐。
