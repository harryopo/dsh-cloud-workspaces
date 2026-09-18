# 07 · 设计：SSH 远程后台任务（ctx.jobs 生产者）

**日期**：2026-09-18 · **状态**：待评审 · **基线**：`51a7e10`（v0.2.2，105/105 测试全绿）
**决策记录见 §9；验收标准见 §10。**

---

## 1. 背景与目标

云端工作区会话里，agent 跑长命令（`apt/npm install`、编译、测试套件）会撞 `bash` 前台执行 60s 默认超时与 2MiB 输出帽——目前只能靠 `nohup` 土办法，且拿不到结构化状态。目标：**让远程长任务获得与本地完全一致的后台体验**——起任务、拿 job id、增量读输出、终止、完成自动通知。

**非目标**：
- 不做跨宿主重启的 job 持久化/恢复（官方 jobs 即纯内存语义，已拍板对齐，§9-3）
- 不自建 `ssh_job_*` 工具面、不替换 `ctx.jobs` registry（§9-1/2）
- 不做输出实时推流（拉取式增量已满足 agent 工作流）

## 2. 官方机制现状（已核验，npm 0.1.1-rc.2 d.ts）

- **`@deepseek-ai/dsh-jobs`** = 契约包：`ctx.jobs: JobRegistry`（抽象 Service）。关键接口：

```ts
abstract class JobRegistry extends Service {
  abstract start(spec: JobStart): JobId          // 同步返回 id；预检不过 throw
  abstract read(id, caller?): JobRead            // { text, snapshot }
  abstract kill(id, caller?, reason?): 'requested' | 'already-finished'
  abstract wait(id, timeoutMs, caller?, signal?): Promise<JobSnapshot>
  abstract onJobDone(listener): () => void       // 完成通知投递源
  abstract attachController(name): () => void
  // list/get/onJobsChanged 略
}
interface JobStart {
  kind: JobKind                                  // 亦 id 前缀（ssh-N）；JobKindMap 可声明合并扩展
  label: string                                  // 模型可见的一行摘要（命令本身）
  outputLimitBytes?: number                      // notice/read 的字节预算
  owner?: Agent                                  // 传 exec.agent 本体；省略=无主
  run(): JobHooks                                // 预检通过后同步调用一次
}
interface JobHooks {
  cancel(reason?): void                          // 同步、幂等、最终必须 settle done
  done: Promise<JobOutcome>                      // 永不 reject；资源释放完成的时点
  readOutput?(): string                          // 消费式增量游标
}
type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
interface JobOutcome { status: 'completed'|'killed'|'failed'; detail?; output? }
```

- **provider**：`dsh-jobs-local` 的 `LocalJobRegistry`（纯内存、传输无关，每 owner 默认上限 10），由 `dsh-base` 装入 → 官方 web profile 里 `ctx.get('jobs')` 恒可得。
- **消费面（全部现成，白拿）**：`dsh-tool-jobs` 提供 `job_output`（wait?/timeout_ms）/ `job_list` / `job_kill`（reason?）三工具 + 完成 notice（`onJobDone` → owner idle 时 wakeup，否则 inject；有连醒预算）+ systemPrompt 段（禁 busy-poll）+ 官方 jobs UI。
- **官方先例**：`dsh-tool-bash` 的 `run_in_background` 就是 `jobs.start({kind:'bash', owner:exec.agent, run:()=>hooks})`，返回 `{kind:'background', jobId}`，渲染 `started background job <id>`；E2B 路线证明**远程性下沉执行层、registry 永不下远程**（官方无 jobs-e2b，e2b 把远程性塞进 ctx.subprocess）。
- 语义对齐点：非零退出 = `completed` + `detail:'exit code: N'`（不是 failed）；被杀 = `killed`；基础设施坏 = `failed`。

## 3. 总体设计

```
模型 ──bash{run_in_background:true}──► session-tools / tools.ts
        │                                   │ startRemoteJob(deps, spec)
        │                                   ▼
        │                            src/job-runner.ts（新，~150 行）
        │                              jobs.start({kind:'ssh', owner, run})
        │                                   │ run() 同步返回 hooks：
        │        engine.openChannel ────────┤  · 常驻通道跑 wrapper（done=close 事件）
        │        engine.exec（按需小命令）──┤  · readOutput=tail 增量   · cancel=杀进程组
        ▼                                   ▼
  job_output/job_list/job_kill ◄──── LocalJobRegistry（官方，宿主内存）
  （官方工具面 + notice + UI，零新代码）
```

我们只新增：生产者模块 + 两个工具的 `run_in_background` 参数 + 接线与文案。

## 4. 详细设计

### 4.1 `src/job-runner.ts`

```ts
export interface JobRunnerDeps {
  engine: SshEngine
  jobs: JobRegistry | undefined     // index.ts 经 ctx.get('jobs') 注入
}
export interface RemoteJobSpec {
  hostId: string
  command: string                   // 用户命令原文（与前台 bash 同一信任边界）
  cwd: string                       // 已解析的远程绝对路径
  agent?: Agent                     // exec.agent，作 owner
}
/** 起远程后台 job；返回官方同款 background 结果。jobs 缺失/预检失败 → throw（工具错误面）。 */
export function startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): { kind: 'background'; jobId: string }
```

**远端协议**：`runId = crypto.randomUUID()`；路径 `/tmp/dsh-job-<runId>.log` 与 `.pid`。经 `engine.openChannel(hostId, wrapper, { cwd })` 下发：

```
printf %s $$ > <pidfile> && exec bash -c '<command>' > <logfile> 2>&1
```

- sshd 为每条 exec 通道建独立进程组；`$$`（exec 前后同一 pid）即 pgid。
- 通道不挂 data 监听（输出以远端日志文件为准），`close(code, signal)` 是唯一权威退出事实。

**三钩子**：
| 钩子 | 实现 |
|---|---|
| `done` | `Promise<JobOutcome>`，由 `onClose` settle：`code≠null` → `completed`（非零码进 `detail:'exit code: N'`）；`code=null 且 signal` → `killed`（detail=signal）；通道 error/传输断 → `failed` + 诚实 detail（§5）。settle 时从当前游标再读一次（**只取未读增量**）填 `outcome.output`（截 `outputLimitBytes`） |
| `readOutput()` | 内部游标 `cursor`（字节）；发 `tail -c +<cursor+1> <log> \| head -c 65536`；游标 += `Buffer.byteLength(返回文本,'utf8')`；返回文本。exec 失败（断连）→ 返回一行提示文本而非 throw（消费式接口不容异常）；spill 提示照官方模式：达到单次上限时附 `[more output; full log: <远端路径>]` |
| `cancel()` | 同步置 `cancelRequested` 幂等标记；fire-and-forget `bash -c 'kill -TERM -$(cat <pidfile>)'`（进程组即 wrapper 的 `$$`，由 wrapper 自己写入 pidfile，无需生产者预知）；5s 后升级同命令 `-KILL`；全程 `.catch` 进 `debugLog`；done 仍由通道 close 落地 |

常量：`READ_CHUNK = 65536`、`OUTPUT_LIMIT_BYTES = 8192`、`KILL_ESCALATION_MS = 5000`。
类型合并（本模块内）：`declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { ssh: 'ssh' } }`。

### 4.2 工具面改动

**遮蔽 `bash`（session-tools.ts）与全局 `ssh_exec`（tools.ts）各加参数**：
- `run_in_background: { type: 'boolean', description: 'Start the command as a background job; no timeout applies. Poll with job_output / job_list, stop with job_kill.' }`
- execute 分支：true 时 `return startRemoteJob(...)`；false/缺省走现路径，返回加 `kind:'foreground'`。
- **输出 schema**：加 `kind`（required，enum foreground/background）与 `jobId`（optional string）；bash 原 stdout/stderr/exitCode/timedOut/durationMs/success 全部放宽为可选（仅前台分支填充；jsonSafe 剥缺省）。render 双分支：background → `started background job <jobId> — poll with job_output (job kind: ssh)`；foreground 渲染不变。
- `presentCall/presentResult`：background 结果对齐官方——识别 `started background job` 前缀即返回 `{card:'generic', content:[{type:'text', text}]}`；其余文本走现有 `bashTerminalView`（无 exit 头时保持 terminal 卡渲染全文，软降级安全）。
- 超时语义：background 分支完全不吃 `timeoutMs`（对齐官方「No timeout applies」）。

### 4.3 接线与依赖

- `index.ts`：`const jobs = ctx.get('jobs')`（可选服务，一次解析）→ `() => jobs` getter 传入 `sshExecTool(runtime, jobsProvider)` 与 `installSessionRouting(ctx, runtime, isEnabled, jobsProvider)` → `buildSessionTools`。
- `package.json`：`@deepseek-ai/dsh-jobs` 进 peerDependencies + devDependencies（`^0.1.1-rc.2`，与其余 dsh-* 同轨）；`tsdown.config.ts` external 列表追加。
- 纯类型导入 + 运行时 `ctx.get`，无 value 依赖进 bundle。

### 4.4 提示面（各一句）

- `sessionSectionText` 追加：`For long-running commands (installs, builds, test suites) pass run_in_background: true to bash, then poll with job_output / job_list / job_kill.`
- `REMOTE_GUIDANCE` 同步补一句（中文面）。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `ctx.jobs` 缺失（无 base 的 headless） | 工具 throw：`background jobs unavailable — load @deepseek-ai/dsh-jobs (dsh-base)`（照官方文案） |
| `start()` 预检拒绝（无 controller 服务该 owner / 超每 owner 上限） | 异常原样上抛为工具错误；不产生半截 job（run() 未被调） |
| 传输断线（job 通道 error/无 exit-status close） | 尽力一次 `kill -0` 探测：活着 → `failed` + `detail:'connection lost; remote process may still be running (pid <p>, log <path>)'`；死了/探不到 → `failed` + `detail:'exit status unknown (connection lost)'` |
| 宿主重启/插件卸载 | 记录随内存消失；dispose 路径尽力 kill 进程组，失败在 debugLog 留痕（远端可能孤儿——已选语义，不谎称停止） |
| agent 销毁 | 官方 `disposeOwned` 调 cancel → 远端进程组 TERM→KILL |
| 日志 UTF-8 边界 | 64KiB 切点可能劈开多字节字符（官方同样 lossy）——接受，代码注释注明 |
| cancel 后重复 cancel / settle 后 cancel | 幂等标记，直接返回 |
| 并发 | 不自设上限，吃 LocalJobRegistry 默认（每 owner 10） |

## 6. 兼容性影响

- 遮蔽 bash / ssh_exec 的**前台**输出对象新增 `kind:'foreground'` 字段、原字段转可选——模型可见 schema 变化但渲染文本不变；对既有会话历史无影响（工具结果是一次性文本）。
- 不动 typert 端点、client 半、store/settings——无数据迁移。
- 官方 `job_output` 等工具在标准 profile 恒在（dsh-base），无新增部署要求。

## 7. 测试计划

1. **单测 `tests/job-runner.test.ts`**（复用 fake ssh2 harness 模式 + fake JobRegistry 捕获 spec）：wrapper 命令形状（pid/log 路径、quoteSh）；done 三态映射（code / signal / 断连+kill -0 分支）；readOutput 游标推进与 spill 提示；cancel 幂等与 TERM→KILL 时序（fake timers）；jobs 缺失 throw。
2. **回归**：session-tools/tools 各加 `run_in_background:true` 分支用例 + 前台不变用例（含 presentCall/presentResult 对 background 的 generic 软降级）。
3. **E2E**（`scripts/e2e-real-server.mjs` 追加 3 项，wsl-e2e）：起 `sleep 5 && echo done` → 中途 readOutput 见增量 → 终态 completed+exit code；起长命令 cancel → killed；起 `exit 3` → completed + detail `exit code: 3`。
4. **真机**：4500 云端会话发「后台跑 apt-style 长命令」，看 job_output 轮询与完成 notice（用户额度内最小验证）。
5. 全链 `pnpm typecheck && pnpm test && pnpm build`。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/job-runner.ts` | 新增 ~150 行 |
| `src/session-tools.ts` | bash 参数/分支/schema/render + jobsProvider 形参 |
| `src/tools.ts` | ssh_exec 同上 |
| `src/index.ts` | ctx.get('jobs') + 两处注入 + 文案一句 |
| `package.json` / `tsdown.config.ts` | dsh-jobs 依赖 + external |
| `tests/job-runner.test.ts`（新）/ `tests/session-tools.test.ts` / `tests/tools.test.ts` | §7.1-2 |
| `scripts/e2e-real-server.mjs` | +3 检查（25→28） |
| `AGENTS.md` / `memory/` / `docs/REPO-WIKI.md` | 收尾更新 |

## 9. 决策记录

1. **不自建 ssh_jobs_* 工具面**：`job_output/job_list/job_kill`、notice 投递、wakeup 预算、UI 全依赖 `ctx.jobs` 契约，自建=重写四件事并自养 prompt 段。
2. **不替换 ctx.jobs**：LocalJobRegistry 传输无关且 dsh-base 已装；替换撞 cordis duplicate-service throw，收益为零。E2B 先例同结论：远程性下沉执行层。
3. **内存态生命周期**（用户拍板）：与官方语义一致；持久化属另一功能，偏离 seam 语义，需要时另立设计。
4. **入口 = 遮蔽 bash + ssh_exec 都加**（用户拍板）：与官方 `run_in_background` 同形，模型零学习成本。
5. **跟踪机制方案 A 常驻通道**（用户批准）：done 事件驱动零轮询、复用 engine.openChannel；否掉 B（从 1495 行 legacy 提取 wrapper 协议，重且轮询延迟）与 C（nohup+纯轮询，其断线重接管卖点与内存态语义矛盾）。

## 10. 验收标准（DoD）

- [ ] §7 全部测试绿（单测 + 回归 + E2E 28/28 + typecheck + build）
- [ ] 真机：云端会话一条后台命令 → `job_output` 增量可见 → 完成 notice 到达（用户执行，机制层日志实锤）
- [ ] 断连/孤儿路径 detail 如实（不谎称停止）
- [ ] AGENTS.md 状态节、memory 顶部节、REPO-WIKI §4/§8 同步更新
- [ ] 分主题提交并推送
