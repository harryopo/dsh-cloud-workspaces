# DSH 插件开发方法论（详细教程）

> 面向对象：DSH（DeepSeek Harness）插件开发者，尤其是「服务器开发模式」（dsh-remote-ide）项目组
> 资料来源：官方文档（deepseek-harness.github.io）+ 本地源码 `.research/dsh-source/deepseek-harness-master/`（docs/ 权威文档 + packages/ 源码 + e2b 官方远程先例）
> 撰写日期：2026-08-15

---

## 〇、速读结论（30 秒版）

- **DSH = Agent = Model + Harness**，`Everything is a plugin`——所有能力（模型/工具/skill/会话/沙箱/存储/循环/调度/UI）都是插件，可换可重组。
- **内核是 Cordis**（vendored 插件框架）：插件贡献服务、类型化事件、可逆 effect 到共享 context。
- **能力 seam 三件套**：Service Definition（抽象接口）→ Service Provider（实现，每 context 单实例）→ Consumer（模型面工具）。替换 provider = 换掉整个产品行为。
- **官方远程先例 = e2b 家族**（`ctx.e2b` + `fs-e2b` + `subprocess-e2b`）：我们的 SSH 方案应整体复刻其架构骨架。
- **改 host 半后重启 dsh web**（4500 实例除外，会断会话）；preset 改后复制到 `~/.dsh/.agent-presets/remote/` 热发现。
- **当前遗留问题根因**：preset 未显示几乎可断定是 4500 实例为旧版本长期进程（agent-presets 服务未装载），而非 preset 组合问题（详见第八章）。

---

## 一、DSH 是什么：定位与运行模式

### 1.1 一句话定位

DeepSeek Harness 是 **agent harness**（智能体框架/工作台）：模型是灵魂，harness 让 agent 理解环境、用工具、在真实环境持续工作。现在处于 **developer preview**，源码开放（88.4k stars）。

### 1.2 设计哲学

- **Everything is a plugin**：一切能力都是插件，可换可重组，不改 DSH 源码。
- **Every run is traceable**：模型看到的一切都记录在 append-only 会话日志中（system prompt、推理、工具调用与结果、子 agent 调度、每次上下文注入）。Trajectory 视图按来源检查；resume/fork/search/replay 都基于同一事件流。
- **Compose with configuration**：用配置选择/替换/扩展能力，不动源码。

### 1.3 四种运行模式（runtime modes）

| 模式 | 能力集 | 用途 |
|---|---|---|
| **Standard** | 全量工具：文件编辑、shell、文件/网页搜索、skills、planning、goals、subagents、workflows | 完整编码 agent |
| **Code** | Standard 全部 + 工具以 Code Mode SDK 暴露，模型可写一个 TS 程序组合多步操作 | 模型编排多轮工具调用 |
| **Minimal** | 仅两个工具：持久 bash + str_replace_editor | 基准测试模型 |
| **Creator** | Standard 全部 + 运行时检查、内存中测试 Cordis 插件、preset 编写引导 | 创建自定义 preset |

> 我们的「服务器开发模式」= 以 preset 形式给 agent 换上 SSH 远程执行能力（Standard 能力集 + 远程 fs/subprocess/shell）。

---

## 二、内核与架构

### 2.1 Cordis 五概念（必须内化）

1. **插件 = 实现 Service 的对象**：函数形式（可选 `inject`/`apply(ctx)`）或 `Service` 子类（生命周期由 Cordis 挂载）。
2. **context = 服务仓库**：服务认领稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），其他插件按 key 找服务，不 import 具体实现。
3. **`inject` 声明依赖**：命名了所需服务的插件会等这些服务就绪后才加载——加载顺序由服务需求表达，而非手动 boot 排序。
4. **类型化事件**：通过 TS declaration merging 声明事件名，按 `emit`/`waterfall`/`parallel`/`serial` 分发。
5. **注册是可逆 effect**：prompt 段、工具 schema、adapter、provider、listener 都通过 `ctx.effect()`/`ctx.on()` 安装，重载/卸载时自动逆序回滚。

### 2.2 事件分发模式（dispatch modes）

| Mode | Awaited? | 顺序 | 返回值 | 用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册顺序观察 | 无 | fire-and-forget 记录（`fs/observed`、`tools/result`） |
| `waterfall` | 否 | 注册顺序 | 有 | around-middleware，`next()` 委托可短路（`tools/pre-execute`、`agent/request`） |
| `parallel` | 是 | 并发 | 无 | 并发 fan-out |
| `serial` | 是 | 注册顺序 | 有 | 按序直到 bail |

**Waterfall 语义**：listener 收 `(...args, next)`；调 `next()` 委托（可选包裹结果），不调 = 短路独占决策（policy listener 的写法）。`prepend: true` 仅在必须最先跑时用。

**实用规则**：行为封装进插件，工具管道事件归 `ctx.tools`，模型流归 `ctx.llm`，实时 agent 协调归 `ctx.agents`。策略/拦截用事件，直接能力调用用服务方法。每个注册都要有 disposer（`ctx.effect()` 返回 disposer 或 Cordis helper 代办）。

### 2.3 Profile 与 Bundle（组合机制）

- **profile**：`$DSH_HOME/profiles/<name>/` 下的命名组合。含 `package.json`（`dsh.profile.bundles` 有序列表 + 树外依赖）+ 用户自己的 `cordis.patch.yml`。`web`/`headless` 是内置模板。
- **bundle**：分发格式（npm 包 + `dsh.bundle.patch` 指向的 patch 文件）。patch 可插入/覆盖行。
- **层顺序**（后层按行胜出，patch **替换整行 config** 而非深合并）：profile bundles 按序 → profile 的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。
- **查看实际组合**：`dsh --profile web --dump-config`——打印的每行都可以用你自己的 patch 替换。
- 推论：patch 覆盖前层行必须重述该行全部键；给用户的默认值应取用户大概率保留的值。

### 2.4 核心包与 ctx key 一览

| 包 | 拥有 | ctx key |
|---|---|---|
| `core/session` | append-only SessionEvent 日志 + 内存存储 | `ctx.sessions` |
| `core/system-prompt` | prompt 段 + 工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域工具注册表 + 守卫执行管道 | `ctx.tools` |
| `core/agent` | Agent 接口、live 注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 默认驱动 | `ctx.agentLoop` |
| `core/scope` | per-agent 作用域注册原语 | 无 key（库） |
| `llm/llm` | 消息/流词汇 + adapter seam | `ctx.llm` |

### 2.5 事件三域（选域是大多数改动的第一个决策）

- **Session events**：durable 事实，追加进日志并广播 `session/event`（要跨重载存活就用它）。
- **Agent events**（`agent/*`）：携带 live `Agent`（inbox/step/status/request/validation/continuation）——观察或拦截进行中的工作。
- **Capability events**：给 seam 挂策略/adapter（`fs/*`、`tools/*`、`telemetry/*`），不 import loop。

### 2.6 Turn 流程（step/turn）

- **step** = 一次模型请求 + 它调用的工具；**turn** = 零或多个 step，开于首个输入被认领，闭于无所欠。
- 关键链：`turn/start → claim input → 组装 prompt+schema → agent/pre-step（可改写/拒绝）→ step/start → 从日志派生 model history → agent/request → llm/stream → assistant/chunk* → assistant/message → tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result* → step/end`。
- `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是 durable session events；`agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 waterfall（必须 `next()` 委托）；`agent/turn-stopping` 是 serial。
- 输入经单一 inbox；注入的上下文在 inbox 等待下一条消息唤醒（`agent.inject()` 不是 wake-up）。

### 2.7 Session log 铁律

**Model-visible means logged**：任何到达模型请求的东西必须能从日志重建（运行时 invariant 断言）。新增模型可见输入 = 必须新增 session event（扩展 `SessionEventMap` 并从日志渲染）。

### 2.8 能力 seam 与「新行为放哪」速查表

seam = 可换能力，三件套：**Service Definition**（声明接口）→ **Service Provider**（实现）→ **Consumer**（通常是模型面工具）。一个角色不成 seam；加能力 = 设计全部三件。

| 目标 | 机制 |
|---|---|
| 加模型 provider | 注册 adapter 到 `ctx.llm` |
| 加模型面能力 | 注册到 `ctx.tools`（schema 自动进 prompt） |
| 给某会话不同能力集 | 组 agent preset；服务行需要 `isolate` realm |
| 加 shell 执行 | 注册 `ctx.shell` 后端（local 的经 `ctx.subprocess` spawn） |
| 加持久终端执行 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 加人类命令 | 注册到 `ctx.commands`（不经模型 turn） |
| 加后台工作 | 注册到 `ctx.jobs`（`job_*` 工具收集/停止） |
| 加文件系统访问/策略 | 注册 `ctx.fs` provider 或监听 `fs/*` |
| 限制派生进程 | `ctx.sandbox` 后端（consumer 在 spawn 前 wrap argv） |
| 拦截请求/工具/turn | `agent/*` 或 `tools/*` 事件 |
| 加模型面上下文 | `agent.inject()`（下次被承认的请求落地） |
| 加 UI/编辑器集成 | 驱动 `ctx.agents` + 从 `session/event` 渲染 |
| 加 durable 会话状态 | 扩展 `SessionEventMap` |
| fork live 会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| scope 注册到单 agent | 用该 agent 的 `agent.ctx` |

---

## 三、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript | Host 半在 Node 进程；Client 半在浏览器 |
| 插件内核 | Cordis（vendored） | `@deepseek-ai/cordis` |
| 配置 schema | Schemastery | `@deepseek-ai/schemastery`，Standard Schema |
| 构建 | tsdown + tsc | tsc 先发声明到 `lib/types`，tsdown 出 `lib/*.js` |
| 包管理 | pnpm（Corepack） | 仓库钉 `pnpm@11.7.0`；workspace 用 `@` 引号坑 |
| Node | 22.19+ / 24（CI 覆盖 22.19/24/26） | |
| 类型反射 | Typert | Host 构建期生成 Remote 声明与 Host-for-Client 投影 |
| 测试 | vitest | 纯逻辑测试（store/engine 层） |
| 双聚合 | `tsconfig.host.json` / `tsconfig.client.json` | Host/Client 两侧对 `Context` 接口声明合并，一个 ts.Program 见两者会冲突 |

### 构建顺序（根目录）

```sh
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

### 日常命令

```sh
pnpm run typecheck   # Host lib 阶段 + 生成 Typert 契约 + Client tsc
pnpm run build       # 全量（含 Client tsdown + web）
pnpm run hygiene     # publint 等
pnpm run test        # vitest
pnpm dsh --profile headless "..."   # headless 演示（需 DEEPSEEK_API_KEY）
```

---

## 四、插件开发全流程（四步走）

### 4.1 第一步：第一个插件

插件 = 导出 `apply` 函数的 TS 模块，框架加载时调用并传 `ctx`。

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] plugin loaded!')
}
```

挂载到 `cordis.yml`（路径必须绝对；patch 不改 loader 的 profile 解析目录）：

```yaml
- insert:
  - id: hello
    name: '/absolute/path/to/my-plugin.ts'
```

启动验证：

```sh
pnpm dsh web --patch ./cordis.yml
```

打开 `http://127.0.0.1:3080`，终端打印插件加载日志即成功。

**自动清理**：ctx 注册的一切（事件/工具/定时器）在插件卸载时自动清理。手动资源用 `ctx.effect()` 返回 disposer：

```ts
ctx.effect(() => {
  const timer = setInterval(() => {}, 5000)
  return () => clearInterval(timer)   // 插件卸载时执行
})
```

**声明依赖**（插件必须等工具服务就绪）：

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}
```

**三种形态**：函数（默认）→ 对象（`{ name, inject, apply }`）→ 类（`extends Service`，`super(ctx, 'myService')`，向其他插件提供服务时用）。

### 4.2 第二步：开发一个 Tool（核心契约）

最小形态（[官方教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool)）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',          // 模型看到什么
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args 由 schema 推断类型：{ name: string }
      return `Hello, ${args.name}!`
    },
  }))
}
```

**execute() 契约硬规则**：

1. **参数替你校验**：`defineTool` 按 `ParameterSchemaSpec` 校验模型生成的 arguments（类型/必填/字面量/oneOf/嵌套），execute 内 args 匹配 `InferArgs`；DSL 表达不了的约束（非空串、正数、跨字段）自己手查。
2. **只返回一个 canonical JSON 值**：`output.schema`（`ValueSchemaSpec`，根可为 object/array/scalar/null）；registry 快照 lossless JSON → 校验 → 冻结 → `output.render(args, value)`。**不要在 body 里返回 content blocks**。
3. **抛错/非法值 = isError**：registry 捕获 throws 并包含 schema/renderer/projector 失败；基础设施失败就 throw；成功领域结果（如非零退出码）放进 canonical value。
4. **遵守 `exec.signal`**：异步工作观察/转发 AbortSignal，只在自身 quiescence 后 settle。
5. **`exec.agent` 用于异步通知**：`agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` 追加到下一模型请求（非 wake-up；对已 dispose agent try/catch）。
6. **注册是 effect 化**：dispose 插件 fiber 即注销；schema 自动进 system prompt；`output`/`execute`/`present*` 绝不泄漏到模型请求。

**UI 卡（可选，纯函数）**：`presentCall(args) => ToolCallView`（pending：`generic`/`terminal`/`diff`）+ `presentResult(args, { content, isError, meta? })`（completed：`generic`/`terminal`/`diff`/`search`/`web`）。**禁止 I/O、禁止读 session 状态、禁止时钟/随机**（live streaming 与 replay 都会调用）；`defineTool` 对畸形参数软校验返回 `undefined` 走通用卡。

**后台工作**：`ctx.jobs.start({ kind, label, owner: exec.agent, run })`；成功后台分支返回 `{ kind: 'background', jobId }`；已发布的工作用任务所有权的取消信号（`job_kill`/owner dispose/service teardown），外层取消只停等待不杀任务。

**Code Mode 免费集成**：注册过的工具自动可用 `await tools.<name>(args)`，类型从同一 schema 派生。

### 4.3 第三步：插件配置（Config + Schemastery）

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)   // 用户值或 schema 默认值
}
```

配置原则：
- **无硬编码可调参数**：凡不同部署可能取不同值的参数必须为配置字段。检验：能否在 cordis.yml 改它而不改代码？
- **配置错误要响亮**：schema 表达完备约束，无效配置在加载时失败。
- **配合 HMR**：改 cordis.yml 的 config 触发插件热替换（旧实例卸载、新实例加载，注册自动清理）。

### 4.4 第四步：打包与安装（bundle / profile）

**两个概念两种 manifest**：
- **组合包（bundle）** = 附带配置层的 npm 包，`package.json` 声明 `dsh.bundle.patch`，回答"贡献什么"。
- **profile** = `$DSH_HOME/profiles/<name>/` 的可启动组合，`dsh.profile.bundles` 有序列表，回答"由哪些包按什么顺序组成"。由 `dsh plugin` 创建维护，勿手写。

bundle 结构：

```
hello-plugin/
├── package.json          # dsh.bundle: { patch: './cordis.patch.yml' }
├── cordis.patch.yml      # 配置层（插件行按包名引用，不按路径）
└── index.js
```

```json
{
  "name": "dsh-hello-plugin",
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

安装：

```sh
dsh plugin --profile demo add ./hello-plugin        # 本地
dsh plugin --profile demo add github:you/hello-plugin   # git
dsh plugin --profile demo add your-package          # npm
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz  # tarball
```

- **git 安装拉源码不构建**：作者必须提供自包含 `prepare` 脚本（如 turtle-ui：专用 tsdown 配置直接转译 src/）；用户需在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { <pkg>: true }` 授权构建，**并锁定 commit sha**。
- 验证层：`dsh --profile demo --dump-config` 看 `# == dsh-hello-plugin` 层。

---

## 五、能力 seam 开发（方案 B 的核心方法论）

### 5.1 三件套与替换原理

seam 三件套 = **Service Definition → Provider → Consumer**。替换 provider 改变整个产品：fs 和 subprocess provider 共享同一执行世界，**把它们指向远程沙箱，bash/PTY/LSP 全部跟随，无需 fork**。

**铁律**：Service 子类作为插件加载时注册 `ctx.<name>`；**每个 context 只能有一个实现，加载第二个 throw**（cordis 标准 duplicate-service）。所以替换 = 不加载本地实现、加载我们的实现（放 local 的位置）。

### 5.2 官方远程先例：e2b 家族（复刻其骨架）

| 包 | ctx key | 角色 |
|---|---|---|
| `e2b`（`@deepseek-ai/dsh-e2b`） | `ctx.e2b` | 创建一个 sandbox、准备 working/runtime 目录、暴露共享 SDK handle、超时/dispose 删除 |
| `fs-e2b` | `ctx.fs` | 在 E2B Filesystem API 上实现 fs seam |
| `subprocess-e2b` | `ctx.subprocess` | 在 E2B Commands/PTY API 上实现可执行查找、受管进程组、stdio、远程 spill、终端会话 |

**对应 SSH**：`ctx.<ssh>`（连接池/会话生命周期，类比 `ctx.e2b`）+ `fs-ssh`（`ctx.fs`）+ `subprocess-ssh`（`ctx.subprocess`）。

**替换方式**：`fs-e2b` 加载在 `dsh-fs-local` 的位置，`subprocess-e2b` 加载在 `dsh-subprocess-local` 的位置。消费者零改造——`dsh-bash-local`/`dsh-terminal-bash`/`dsh-lsp-stdio` 委托 `ctx.fs`/`ctx.subprocess`，挂两个 adapter 就把可变工作放进同一远程世界。**边界**：harness 进程/Cordis 对象/模型调用/agent-session 状态/持久化/skills/高层协议/SDK 缓冲区都不迁移——只迁移"执行世界坐标"。

### 5.3 ctx.fs 完整接口（13 个抽象方法）

```ts
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract processPath(target: FsTarget): string
abstract fileUrl(target: FsTarget): string
abstract contains(parent: FsTarget, child: FsTarget): boolean
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
```

语义要点：
- `FsTarget = { targetKey: FsTargetKey; displayPath: string }`：targetKey 是 branded 不透明 id，**消费者禁止解析**（远程后端可用 workspace URI / file id）；displayPath 仅展示。
- `FsVersion`：文件版本令牌（本地 `dev:ino:size:mtimeNs:ctimeNs`；远程用 revision id），消费者只做守卫不解释。
- `writeText`：省略 expected = 无条件 create-or-overwrite；`createIfAbsent` 撞文件报 `FS_NOT_OBSERVED`；`replaceIfVersion` 版本不符报 `FS_STALE_VERSION`。
- `editText` 是 **provider 级原子读-改-写**（不是 consumer 组合 read+write）。
- 错误码 taxonomy：`FS_NOT_FOUND | FS_NOT_DIRECTORY | FS_NOT_TEXT | FS_NOT_REGULAR_FILE | FS_TOO_LARGE | FS_PERMISSION_DENIED | FS_SANDBOX_DENIED | FS_IO_ERROR | FS_STALE_VERSION | FS_NOT_OBSERVED | FS_AMBIGUOUS_EDIT | FS_EDIT_NOT_FOUND | FS_ABORTED`。
- **文件 IO 无 timeoutMs**；取消经 tool-execution signal 传播到 syscall 边界。
- `fs/*` 事件（policy 门控）：`fs/write-intent`（waterfall）、`fs/edit-intent`（waterfall）、`fs/observed`（emit 纯记录）。policy 由 `fs-observation-policy` 提供，**我们无需实现**。
- fs-local 参考：原子写 = 随机 staging 目录（0700）+ `wx, 0600` 独占临时文件 + fsync + rename 发布；`createIfAbsent` 用 hard-link 发布；editText 带 per-target mutation lock。

### 5.4 ctx.subprocess 完整接口（3 个抽象方法）

```ts
abstract resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

关键语义：
- 可执行文件路径与已挂载 fs provider **共享同一 execution world**。
- `spawn` 立即返回 live handle；`done` 进程关闭时带 exit facts resolve，**仅 spawn 级失败 reject**。
- `terminate()`（唯一终止动词）+ spec 的 abort signal：SIGTERM → grace → SIGKILL 树级升级；`waitForExit()` 观察整树存活。
- **服务 dispose 时终止所有受管进程并等待退出**。
- `SubprocessSpawnSpec` 全显式无默认：`argv`（绝不做 shell 解释）、`cwd`、`stdio`（stdin/stdout/stderr 全显式）、`graceMs`、`signal?`、`env?`（credential scrub 后合并，`undefined` = tombstone 移除）。
- `CollectedOutput = { text; truncated; spillPath? }`：溢出保留 TAIL，全流 spill 文件。**远程 provider 必须支持 spillPath**（远程 spill，宿主只拿 locator）。
- 环境边界：丢弃 ambient credential-shaped 名（`*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`）与全部 ambient `DSH_*`，再合并显式 env。
- `DSH_*` 命名空间：`DshEnvironmentKey = ${DSH_ENV_PREFIX}${string}`；每模型 shell 调用重建快照（`ctx.shellEnv.collect()`）。
- subprocess-e2b 参考（直接借鉴为 SSH 版风险清单）：异步远程启动期间 `pid = -1`；`setsid --wait` wrapper 记录真实进程组；terminate 对负 pgid 发信号；spawnTerminal 用私有 0600 状态文件 + 剥离 bootstrap prompt；沙箱消失 = 按 quiescent 处理清理。

### 5.5 ctx.terminals（持久 PTY，若做 ssh_terminal）

- `TerminalSessionService`（in-process 注册表）：`registerBackend(backend) / spawn(owner, request) / startSend / read / signal / kill / list`。
- `TerminalBackend = { type; spawn(spec): Promise<TerminalBackendSession> }`；session 在 spawn 设置成功后发布。
- 授权比较**精确 owner `Agent` 对象**，跨 agent 访问拒绝。
- **分工**：terminal-bash 拥有 prompt 检测/readiness/scrollback/sandbox policy；`ctx.subprocess.spawnTerminal` 拥有 PTY 分配/环境 scrub/前台进程组/信令/整会话清理。**同一 PTY 后端可与本地或远程 execution-world provider 组合**——我们实现 `subprocess-ssh.spawnTerminal` 后 terminal-bash 不用改。
- tool-terminal 6 工具（open/send/read/signal/close/list）无需改，只消费 `ctx.terminals`。

### 5.6 其余 seam 关键契约（速查）

- **`ctx.shell`**（`ShellExecutor` 抽象 seam）：`resolve(request) → spec`、`run(spec) → ShellRunResult`、`start(spec) → ShellProcess`。run 只对基础设施失败 reject（非零退出/超时/abort 都是正常 resolve）；ShellRunResult 把 `timedOut`/`aborted`/`signal`/`exitCode` 作为正交字段独立报告。**我们不需要实现它**——bash-local 消费 subprocess，替换 fs+subprocess 即可。官方注释："sandboxed, remote, or PowerShell executors replace bash-local without touching them"。
- **`ctx.approval`**：`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`，**fail-closed**（缺失/抛错/不合规一律 unavailable）；`'approval/request'` 是 waterfall、scope-filtered；会话级 `ApprovalPolicy = 'ask'|'never'`（never 在 waterfall 前确定性 rejected）。ApprovalRequest 不携带工具参数，经 callId 关联。
- **`ctx.sandbox`**：`confine(argv, policy) → ConfinedArgv` 唯一抽象方法；**静默无限制直通永远非法**；`SandboxMode = 'read-only'|'workspace-write'|'danger-full-access'`（danger 直接 spawn 原 argv 不调 sandbox）。**关键：远程执行是 whole-capability-seam 的兄弟实现，不是 ctx.sandbox 的 provider——我们不需要也不应该实现 ctx.sandbox**。
- **`ctx.jobs`**：`JobRegistry`（start/list/get/read/kill/wait/onJobDone/attachController）；`JobStart = { kind; label; outputLimitBytes?; owner?; run() }`；`JobHooks = { cancel; done; readOutput? }`（done 绝不 reject，reject 转 failed）；id 可预测（`<kind>-N`）→ 授权靠 owner session 比较。直接复用官方实现 + `tool-jobs`。
- **`ctx.skills`**：`registerProvider(create)`（同步注册，远程初始化放 await 的 `list()` 里）；注册表 host+per-scope 分层，同名胜出；`get` 每次重读完整 body。**`ctx.fs` 可用时 git-root 行走查走 filesystem service**——远程 fs 不会掉回宿主边界（正面案例）。

### 5.7 Cordis 继承 API 速查（开发常用）

```ts
ctx.on(name, listener, options?)          // → () => boolean disposer；options: { prepend?; global? }
ctx.emit(name, ...args)                   // fire-and-forget
ctx.waterfall(name, ...args, next)        // around-middleware
ctx.parallel(name, ...args)               // 并发等待
ctx.serial(name, ...args)                 // 按序等待
ctx.effect(fn, label?)                    // 注册 + disposer；fiber 卸载逆序执行
ctx.inject(deps, callback)                // 函数式依赖注入
ctx.plugin(plugin, ...config)             // 加载任意形态插件
ctx.get(name, strict = true)              // 可选服务读取（返回 undefined）
ctx.provide(name, value)                  // 注册当前 fiber 拥有的实现（同 scope 重名 throw）
ctx.isolate(name, label?)                 // 独立 service scope
ctx.intercept(name, config)               // 为下方插件合并服务 intercept config
// Service 类：class X extends Service { constructor(ctx){ super(ctx, 'name') } }
```

**inject 声明**：插件级 `export const inject = ['tools']`（数组）或 `{ tools: { ... } }`（带 intercept config）；`provide?: string[]` 声明插件提供的服务。

---

## 六、Agent Preset 开发（含遗留问题根因）

### 6.1 机制与扫描

- 常量：`COMPOSITION_FILE = 'agent.cordis.yml'`（`discovery.ts:26`）；`USER_PRESET_DIR = '.agent-presets'`（`discovery.ts:41`）；`PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`（目录名即 preset id）。
- roots 组装（`index.ts:130-135`）：配置 roots 按序 → 追加 `$DSH_HOME/.agent-presets`（`trust: 'user'`），`includeUserRoot` 默认 true。
- `$DSH_HOME` 解析优先级：显式配置 > `$DSH_HOME` 环境变量 > `~/.dsh`。
- CLI 注入：`profile-boot.ts:159` 仅当组合存在 `id: agent-presets` 行时注入 shipped root（`apps/cli/config/agent-presets/`）。
- **识别条件**：目录名合法 + 存在 `agent.cordis.yml` + 可解析且形状合法（顶层数组、每行 map 带非空字符串 name）。`preset.yml` 是可选元数据（name/description/order），读失败不影响挂载。

### 6.2 挂载与 isolate realm

- `mountPreset`：把 `agent.cordis.yml` 作为 entry 子树挂进 standing scope（每 preset 每进程一次）；每个 agent 把 scope 挂到 standing 下继承注册。
- **两道校验**：
  - `inactiveRows()`：任一 enabled 行等一个组合内没人提供的服务 → `"N row(s) did not activate"` 拒绝挂载。
  - `leakedServices()`：preset 内服务**必须放 `isolate` realm**（`cordis:group` + `isolate: { xx: true }`），否则报 `"row(s) published process-global service(s)"`。
- `name` 字段解析（`PresetTree.override import()`）：`./x` 相对 preset 目录；`cordis:xxx` 内置；**包名/子路径（`dsh-remote-ide/remote-tools`）从 host composition base（harness 安装处）解析**，经 profile 模块 fallback（`$DSH_HOME/profiles/node_modules`）。
- **重要区分**：roster 的 health check **只做形状校验、不解析包名**（`discovery.ts:46-50`）——即使行里包名解析不了，preset 也照常显示在选择器，直到首次会话 mount 才失败。包名解析失败 ≠ 不显示。

### 6.3 模式选择器 UI 链路

UI chip（`ui-agent-preset`）→ `api.agentPresets.list({})` RPC → `api-proxy.ts:3061-3081`：`ctx.get('agentPresets') === undefined` 时**静默返回 `{ presets: [], authorable: false }` 不报错**；否则 `presets.list()` 每次实时重扫磁盘（无缓存），过滤 broken 后作为选项。

### 6.4 本机遗留问题根因（~/.dsh/.agent-presets/remote/ 不显示）

已核实事实：npx 缓存装载 `@deepseek-ai/dsh@0.1.0-rc.6`，其中 agent-presets 机制**完整存在**；remote 目录静态条件全绿（目录名合法、两文件存在、形状合法）；profile/cordis.patch.yml 无冲突。

按可能性排序的根因：

1. **【最可能】4500 实例是旧版本 dsh 的长期进程，进程内存中没有 agent-presets 服务**。`ctx.get('agentPresets') === undefined` → list 恒返回空 → **shipped presets（standard/code/minimal/cordis）也会一起消失**。验证：打开 4500 新会话页，若 standard 等 shipped preset 也不出现即坐实。修法：用户手动重启 4500（铁律：不代劳）。
2. **npx 缓存把 `@deepseek-ai/dsh@latest` 钉死在 rc.6**（`start-dsh-web.ps1` 用 npx -y 命中缓存不刷新），与根因 1 常叠加。修法：删 `%LOCALAPPDATA%\npm-cache\_npx\*` 后重跑脚本。
3. **【次可能】运行时 `$DSH_HOME`/环境差异**：4500 由 Start-Process 继承启动时环境，若与当前 shell 不同则 user root 指向别处。验证：list 响应 `authorable: false` 说明 user root 没扫到。

已排除：broken 标记（形状合法不会）、UI 单独扫盘（UI 数据源就是 RPC）、插件 patch 干扰。

### 6.5 preset 最佳实践

```
<root>/<preset-id>/          # 目录名 = preset id，匹配 /^[a-z0-9][a-z0-9-]*$/
  agent.cordis.yml           # 必填：顶层 plugin 行列表
  preset.yml                 # 可选：name / description / order（仅显示文本）
```

- 服务行必须 `cordis:group` + `isolate:` realm（如 `isolate: { planMode: true }`）；只注册工具/提示词、不发布服务的行不需要 realm。
- 行支持 `disabled: !!js 表达式`（如 `process.platform === 'win32'`）、`group: true` 嵌套。
- 改动 `agent.cordis.yml` 让新会话起新 generation（按 mtime+size 打戳），运行中会话不受影响。
- 用户 preset 可被 `copy()`/`remove()` 管理（仅 user root 可写），复制时重写 preset.yml。

---

## 七、工程实践与坑

### 7.1 项目结构（dsh-remote-ide 现状对照）

```
src/
  index.ts      # 入口：注册工具 + 引擎生命周期 + 设置
  tools.ts      # defineTool 工具
  engine.ts     # ssh2 引擎
  store.ts      # 主机配置
  protocol.ts   # 共享类型
agent-presets/remote/   # preset 模板
cordis.patch.yml        # bundle patch（挂载 remote-ide）
```

### 7.2 构建与验证

```sh
pnpm install          # 首次
pnpm build            # tsc 声明 + tsdown 产物
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm watch            # tsdown watch
```

- host 依赖 external（tsdown `external`）：`@deepseek-ai/*` 运行时从 profile 解析，不打包。
- **改 host 半需重启 dsh web**（4500 例外）；preset 热发现无需重启。
- 插件 link 装入 profile：junction `C:\Users\Lenovo\dsh-remote-ide-dev` → 仓库，改后 `pnpm build` 生效。

### 7.3 已知坑（AGENTS.md 沉淀）

1. Windows WinNAT 保留端口（4035-4234）→ listen EACCES；用 4500 或 `--port 0`。
2. 路径含空格 → `dsh plugin add link:...` 拆词；用 junction。
3. pnpm-workspace.yaml 里 `@xxx/yyy` 开头要加引号（YAML tag 解析）。
4. modlens 需 latest dsh（rc.6 不加载）；`@liustack/modlens` 3.16.6 已装 profile。
5. GitHub push 偶发网络中断 → 重试。
6. tsdown clean 会删 tsc 的 d.ts → build 脚本先统一删 lib，tsdown `clean: false`。
7. 连不上 GitHub clone 大仓库 → 用 codeload tarball。

### 7.4 开发纪律（借鉴 TDSF 复用清单）

- 4 级复用分级：🟢 直接依赖（MIT/Apache-2.0/BSD）/ 🟡 借鉴架构（文件头 `Borrowed from` 注释）/ ⚪ 待评估 / 🔴 红线（GPL/AGPL/SSPL）。
- License 首行核实，源码分析前置。
- 本插件依赖：`ssh2`（MIT，🟢）——已验证。

---

## 八、dsh-remote-ide 实战映射（方案 B 落地路线）

| 阶段 | 动作 | 依赖知识 |
|---|---|---|
| M0 排查 | 确认 4500 旧进程问题（第六章 6.4）；若需升级由用户手动重启 | §6.4 |
| M1 远程引擎 | `ctx.<ssh>` 连接池（类比 `ctx.e2b`）：连接管理/ProxyJump/PTY/会话生命周期 | §5.2 |
| M2 远程 fs | `fs-ssh` 实现 `ctx.fs` 13 方法，加载在 `dsh-fs-local` 位置 | §5.3 |
| M3 远程 subprocess | `subprocess-ssh` 实现 `ctx.subprocess` 3 方法（含 spawnTerminal） | §5.4-5.5 |
| M4 preset 完善 | 修复 agent.cordis.yml 组合（isolate realm 校验）；复制到 `~/.dsh/.agent-presets/remote/` | §6.2-6.5 |
| M5 端到端验证 | bash/terminal/lsp 自动跟随远程；工具无需改动 | §5.2 |

**替代路线（当前已实现）**：5 个独立工具（ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write）注册到 `ctx.tools`——不与官方 bash/fs 工具打通，但已形成闭环。未来演进到方案 B（seam 替换）时保留工具层兼容。

**方案 B 的核心优势**（官方背书）：`docs/architecture.md` 明言"Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks"。

---

## 参考资源（本地）

- 官方文档站：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
- 源码：`.research/dsh-source/deepseek-harness-master/docs/`（architecture.md、capability-seams.md、cordis-primer.md、agent-lifecycle.md、subsystems/*、cookbook/*、cordis-api/*）
- 官方远程先例：`packages/e2b/{README.md, fs-e2b/README.md, subprocess-e2b/README.md}`
- 官方 preset 范本：`apps/cli/config/agent-presets/{standard,code,cordis,minimal}/agent.cordis.yml`
- 社区：GitHub topic `dsh-plugin`（1891 仓库）；精选列表 `awesome-dsh-plugin/awesome-dsh-plugin`
- 社区参考插件：modlens（视觉）、dsh-web-ui、dsh-TUI、deepseek-harness-desktop、mobius（Agent OS）

---

**撰写**：DSH 开发组 · **日期**：2026-08-15
