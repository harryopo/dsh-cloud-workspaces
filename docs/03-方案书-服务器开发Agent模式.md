# DSH「服务器开发 Agent 模式」完整方案书

> **版本**：v1.0（整合定稿）· **日期**：2026-08-15
> **定位**：让 DSH 的 coding agent 以**远程 Linux 服务器**为生产开发环境——对话界面不变，agent 的命令执行、文件读写、编辑器、后台任务全部发生在服务器上（VS Code Remote-SSH / GitHub Codespaces 的 **agent 版**）
> **一句话架构**：e2b 式三层——`ctx.<ssh>` 连接池 + `fs-ssh`（ctx.fs 远程 provider）+ `subprocess-ssh`（ctx.subprocess 远程 provider），官方消费者（bash/terminal/fs 工具/LSP）零改造自动跟随远程

---

## 〇、文档索引（本方案书关联的全部资产）

| 文档 | 内容 | 对方案书的作用 |
|---|---|---|
| [docs/01-调研报告-SSH-IDE插件.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/01-调研报告-SSH-IDE插件.md) | 插件生态盘点（dsh-ssh/better-sidebar）、双面插件架构 | 历史：IDE 路线已废弃，引擎资产来源 |
| [docs/02-调研报告-服务器开发Agent模式.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/02-调研报告-服务器开发Agent模式.md) | 方案 A/B/C 可行性对比、preset 机制源码确认 | 可行性论证（§四） |
| [docs/04-调研报告-开源远程开发方案对比.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/04-调研报告-开源远程开发方案对比.md) | 四条路线（Trae/Cursor/e2b/OpenHands/claude-remote） | 路线选择依据（§4.2） |
| [docs/05-调研报告-TDSF项目群知识吸收.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/05-调研报告-TDSF项目群知识吸收.md) | OpenHands 沙箱源码、SSH 生态交叉验证、安全机制灵感 | 安全设计（§5.6） |
| [docs/06-DSH插件开发方法论.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/06-DSH插件开发方法论.md) | 官方开发教程：seam 契约、接口签名、e2b 先例、preset 机制 | **开发依据**（§4.3-4.5） |
| 本地源码 `.research/dsh-source/deepseek-harness-master/` | 官方权威文档 + packages 源码 | 一切契约的最终裁决 |

---

## 一、项目概述

### 1.1 定位演变（为什么从 IDE 插件变成 Agent 模式）

| 阶段 | 形态 | 结局 |
|---|---|---|
| 起点 | SSH IDE 插件（资源管理器变远程目录、终端即 SSH 终端） | 多轮 UI 迭代用户不满意（丑/乱/不稳定），client 半已删除 |
| 现在 | **「服务器开发」Agent preset**——agent 的开发环境整体 = 远程 Linux 服务器 | 聚焦 agent 能力开发，做「大」 |

### 1.2 用户已拍板的核心决策

| 决策点 | 结论 |
|---|---|
| 实现路线 | **直接方案 B（执行层）**：provider 替换，不做工具层浅集成 |
| 连接方式 | 首次对话输入连接，**两种都支持**：贴 `ssh user@host` 字符串 / agent 分项询问 |
| 工具边界 | **纯远程**（preset 不注册本地 bash/fs） |
| 验证目标 | **真实远程 Linux 服务器** |
| 终端形态 | **持久终端**（PTY，状态跨命令保留） |
| 编辑器 | **str_replace 编辑器**（远程） |
| 工作目录 | 默认目录 + 可指定 |
| 遗留问题 | **已忽略**（DSH 自举开发噪音，不排查不修复） |

---

## 二、需求理解（技术解读）

| 用户表述 | 技术解读 |
|---|---|
| "保持正常的对话界面" | 不新增 UI；复用 DSH 现有对话界面 |
| "agent 在服务器环境里编辑、开发、阅读" | agent 的工具（bash/fs/editor）执行目标是远程服务器 |
| "转变 tool call" | 本质 = 把 shell/fs/subprocess 能力 seam 的 **provider 换成 SSH 远程实现**（DSH 原生支持 provider 替换） |
| "ssh 连接进去" | 复用 dsh-remote-ide 已实现的 ssh2 引擎（连接池/exec/SFTP/PTY） |
| "下载可开发编辑的插件等" | 服务器上安装开发工具链由 agent 通过远程 shell 完成 |

---

## 三、可行性论证：为什么方案 B 成立（调研结论整合）

### 3.1 DSH 机制事实（源码级，docs/02 + docs/06）

1. **agent preset 机制存在**：`~/.dsh/.agent-presets/<id>/`（agent.cordis.yml 必填 + preset.yml 元数据），isolate realm 可 shadow 宿主默认执行层（minimal preset 先例）。
2. **能力 seam 三件套**：Service Definition → Provider → Consumer；provider 每 context 单实例（加载第二个 throw）→ 替换 = 放在 local 实现的位置。
3. **官方金句**（architecture.md）："Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks."

### 3.2 开源路线对比（docs/04）：我们走的是生态标准解法

| 路线 | 代表 | 结论 |
|---|---|---|
| ① 服务端部署型 | Trae/Cursor Remote-SSH | 闭源 IDE 专属，需远程装服务端；**仅借鉴连接交互**（贴 `ssh user@host`） |
| ② **执行后端替换型** | DSH 官方 e2b、OpenHands Runtime | ★ 与方案 B 同构，**双份官方先例背书** |
| ③ 工具拦截+同步 | claude-remote（Mutagen） | 有同步冲突/路径翻译坑；SFTP 直连天然无此问题 |
| ④ 单命令转发 | remote-launcher | 反例 |

### 3.3 官方远程先例：e2b 家族（docs/06 §5.2，必须复刻其骨架）

```
dsh-e2b            → ctx.<ssh> 连接池/会话生命周期所有者（我们）
dsh-fs-e2b         → fs-ssh（ctx.fs 远程 provider）
dsh-subprocess-e2b → subprocess-ssh（ctx.subprocess 远程 provider）
```

官方明确分工边界：agent/会话状态/LLM/skills 全部留宿主进程，只有执行世界坐标迁移远程。

### 3.4 SSH 生态交叉验证（docs/05）：技术选型被独立验证

TDSF 项目群的 SSH 深度调研与我们的已用技术栈逐项吻合：ssh2（事实标准）✅、ssh2-sftp-client（SFTP CRUD）✅、xterm.js/node-pty（PTY 生态）✅、JumpServer（会话审计参考）、Tabby（连接管理参考）。

### 3.5 遗留问题：已忽略，不阻塞

preset 未出现在模式选择器——用户确认忽略（DSH 自举开发噪音）。本方案不依赖 preset 选择器展示即可推进执行层开发。

### 3.6 结论

**方案 B 成立，且有四重背书**：DSH 官方 e2b POC + OpenHands RemoteSandboxService + minimal preset isolate 先例 + SSH 生态成熟组件。开发依据以 docs/06 为纲。

---

## 四、技术方案（e2b 式三层）

### 4.1 总体架构

```
对话界面 + 会话/LLM/skills（宿主，不变）
   │
   ▼
remote preset（agent.cordis.yml，isolate realm 自包含执行层）
   ├─ dsh-ssh             ← ctx.<ssh> 连接池/会话生命周期所有者（类比 ctx.e2b，复用 engine.ts）
   ├─ fs-ssh              ← ctx.fs 远程 provider（13 抽象方法，SFTP；加载在 dsh-fs-local 的位置）
   ├─ subprocess-ssh      ← ctx.subprocess 远程 provider（3 抽象方法：resolveExecutable/spawn/spawnTerminal）
   ├─ 官方消费者（零改造，自动跟随远程）：
   │   ├─ dsh-bash-local       ← bash 工具（消费 ctx.subprocess）
   │   ├─ dsh-terminal-bash    ← 持久终端/PTY（消费 ctx.subprocess.spawnTerminal）
   │   ├─ dsh-tool-fs          ← 文件工具/str_replace_editor（消费 ctx.fs）
   │   └─ dsh-lsp-stdio        ← LSP（可选，消费 ctx.subprocess）
   └─ persona            ← "You are a coding agent on a remote Linux server via SSH"
```

**关键设计原则**：
- **不实现 ctx.shell**：bash-local 消费 ctx.subprocess，替换 fs+subprocess 两个 seam 即可。
- **不实现 ctx.sandbox**：远程执行是 whole-capability-seam 的兄弟实现，不是 sandbox provider（官方明言）。
- **消费者零 fork**：官方工具层全部复用，我们只写执行世界。

### 4.2 连接生命周期（ctx.\<ssh\>）

- **连接建立**：会话首个对话由用户给出连接信息（贴 `ssh user@host` 字符串，含 `-p`/`-i`/`-J` 选项；或 agent 用 `ask_user` 分项询问）
- **连接复用**：连接池在 preset realm 内共享，所有 provider 复用同一条连接
- **断线处理**：掉线 → 工具报错 → agent 提示重连；`ssh_status` 检查连接状态
- **安全**：凭证存 `~/.dsh/dsh-remote-ide.json`（0600）；私钥只用于连接、**绝不暴露给模型**

### 4.3 模块与资产复用

| 新模块 | 复用资产 | 参照实现 |
|---|---|---|
| `dsh-ssh`（ctx.\<ssh\> 连接池） | engine.ts 连接池/ProxyJump/PTY | dsh-e2b（packages/e2b/e2b） |
| `fs-ssh`（ctx.fs，13 方法） | engine.ts SFTP CRUD | fs-e2b / fs-local（packages/fs/） |
| `subprocess-ssh`（ctx.subprocess，3 方法） | engine.ts exec/PTY | subprocess-e2b / subprocess-local |
| 官方消费者（bash/terminal/fs/LSP） | **零改造复用** | dsh-bash-local / dsh-terminal-bash / dsh-tool-fs / dsh-lsp-stdio |
| persona + preset 组合 | agent.cordis.yml（isolate realm） | minimal preset |

### 4.4 接口契约（开发依据 docs/06，最终以本地源码为准）

**ctx.fs 13 个抽象方法**（fs-ssh 必须实现）：

```ts
resolve(path, opts?) → FsTarget                    // targetKey 不透明 branded id，禁止解析
processPath(target) → string                       // 执行世界内规范绝对路径（远程 POSIX）
fileUrl(target) → string                           // 远程 file: URI
contains(parent, child) → boolean
stat(target, signal?) → FsInfo | undefined
lstat(path, opts?, signal?) → FsPathInfo | undefined
readText(target, signal?) → string                 // UTF-8 only，FS_NOT_TEXT 语义
streamText(target, signal?) → AsyncIterable<string>
readBytes(target, signal, maxBytes) → Uint8Array   // 有界读，FS_TOO_LARGE
listDir(target, signal?) → FsDirEntry[]            // 稳定名称序
writeText(target, content, expected?, signal?, sandboxPolicy?) → FsWriteOutcome
editText(target, edit, expected?, signal?, sandboxPolicy?) → FsEditOutcome  // provider 级原子读改写
```

错误码 taxonomy：`FS_NOT_FOUND / FS_NOT_DIRECTORY / FS_NOT_TEXT / FS_NOT_REGULAR_FILE / FS_TOO_LARGE / FS_PERMISSION_DENIED / FS_SANDBOX_DENIED / FS_IO_ERROR / FS_STALE_VERSION / FS_NOT_OBSERVED / FS_AMBIGUOUS_EDIT / FS_EDIT_NOT_FOUND / FS_ABORTED`

**ctx.subprocess 3 个抽象方法**（subprocess-ssh 必须实现）：

```ts
resolveExecutable(command, env?, signal?) → Promise<string>
spawn(spec: SubprocessSpawnSpec) → SubprocessHandle     // 立即返回 live handle；terminate 树级升级
spawnTerminal(spec) → Promise<SubprocessTerminalHandle> // PTY 分配/前台进程组/整会话清理
```

**Spill 必做**：`CollectedOutput = { text; truncated; spillPath? }`——远程 provider 必须支持 spill 文件路径（远程 spill，宿主只拿 locator）。

### 4.5 remote preset 组合蓝图

```yaml
# agent-presets/remote/agent.cordis.yml（草案）
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent working on a REMOTE Linux server via SSH.
      All commands, files, and edits operate on the remote server.

- id: execution-world
  name: cordis:group
  group: true
  isolate: { sshConnection: true }
  config:
    - id: dsh-ssh
      name: 'dsh-remote-ide/ssh'              # ctx.<ssh> 连接池/会话生命周期
    - id: fs-ssh
      name: 'dsh-remote-ide/fs-ssh'           # ctx.fs 远程 provider（13 方法，SFTP）
    - id: subprocess-ssh
      name: 'dsh-remote-ide/subprocess-ssh'   # ctx.subprocess 远程 provider（exec/PTY）
# 消费者：官方零改造（dsh-tool-fs / dsh-tool-bash / dsh-terminal-bash），实际组合以 dump-config 为准
```

### 4.6 安全设计（借鉴 TDSF/OpenHands/全生态共识）

| 层 | 措施 |
|---|---|
| 凭证 | 0600 配置文件；私钥绝不暴露给模型；支持专用低权限用户 |
| 作用域 | 默认固定项目目录 + 可指定 |
| 高危命令 | 远程模式比本地更危险（真实生产/教学服务器）→ 高危命令确认（`rm -rf`/`fdisk`/`mkfs`/`systemctl restart` 等，远期接入 ctx.approval） |
| 留痕 | 每次 ssh 执行记录「命令 + 输出摘要 + 时间戳」，可追溯可回放（对齐 JumpServer 会话录制思想，远期） |

### 4.7 与现有 5 个工具的关系

`ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write` **保留为补充能力**（调试、一次性操作），主力是「原生 bash/editor 工具跑在远程」。工具层兼容，渐进演进。

---

## 五、交互设计（连接流程）

1. 新会话 → 选择「服务器开发」模式
2. 首条消息：`ssh user@host`（或回答 agent 的连接询问）
3. agent 建立连接并自检（`ssh_status`：cwd、系统信息、工具链）→ 向用户确认"已连接 xx，工作目录 /home/xx"
4. 后续全部工具调用（bash/fs/editor/terminal）落在远程；对话界面与平时一致
5. 断线时工具报错 → agent 提示重连

---

## 六、里程碑与开发规划（宗旨：先调研后开发，框架先行）

> **开发宗旨**：每一步动工前先做前置调研（读官方源码/文档），先确定接口类型骨架（框架层），验证编译通过，再填充实现。禁止跳过调研直接写码。

| 阶段 | 内容 | 前置调研（必须先行） | 框架先行产物 | 验收标准 |
|---|---|---|---|---|
| **M0** | 引擎与连接池 `ctx.<ssh>` | 读 `packages/e2b/e2b/` 源码 + engine.ts 现状；明确连接池 API（connect/acquire/release/keepalive/断线重连） | `src/ssh-service.ts` 类型定义（Cordis Service 骨架） | agent 可建立/复用连接，`ssh_status` 可查 |
| **M1** | `fs-ssh`（ctx.fs 13 方法） | 读 `packages/fs/fs/src/index.ts` + `fs-e2b/` + `fs-local/README.md`；对齐 FsTarget/version/错误码语义 | `src/fs-ssh.ts` 实现骨架 + 类型对齐 | 远程目录浏览/文件读写经 SFTP；tool-fs 跟随 |
| **M2** | `subprocess-ssh`（3 方法） | 读 `packages/subprocess/subprocess/src/index.ts` + `subprocess-e2b/`；exec/PTY 协议、进程组管理、spill | `src/subprocess-ssh.ts` 骨架 | bash 远程执行；terminal-bash 持久 PTY 跟随 |
| **M3** | preset 组合完善 | 读 minimal/standard preset + mount.ts（isolate/leakedServices 校验）；dump-config 验证实际组合 | agent.cordis.yml 定稿 | 组合可挂载；bash/fs/terminal 全程远程 |
| **M4** | 真实 Linux 服务器验收 | 制定验收清单（建项目/装工具链/跑测试） | 验收脚本 | 真实服务器全远程闭环 |

**执行纪律**：
- 每个 M 阶段产出：前置调研结论 → 接口骨架（类型 + 空实现，`pnpm typecheck` 通过）→ 填充实现 → 验证
- 每阶段结束更新记忆 + 归档调研笔记
- 遇到契约不确定 → 以本地源码为准（`.research/dsh-source/deepseek-harness-master/`）

---

## 七、风险与应对

| # | 风险 | 应对 |
|---|---|---|
| 1 | DSH 为 pre-release，Service Definition 可能跨版本变动 | 锁定当前 dsh 版本；provider 按最小接口；以本地源码 docs/06 为准 |
| 2 | 远程执行无本地 sandbox 限制 | 远程是用户自有机器，语义即"全权"；persona 明确告知；高危命令确认 |
| 3 | 凭证安全 | 0600 文件；私钥不暴露给模型；低权限专用用户 |
| 4 | 单连接复用 vs 每次新建 | 默认单连接复用 + 断线重连；ssh_status 检查 |
| 5 | Windows 侧路径语义（远程 POSIX） | fs/subprocess provider 统一按远程 POSIX 语义实现 |
| 6 | ssh2 PTY/SFTP 与 seam 契约的缝隙（如 PID 同步、信号） | 借鉴 subprocess-e2b 已知限制清单（pid=-1、spill、quiescence 判定） |

---

## 八、开发规范（沿用 docs/06 + AGENTS.md）

- **接口三件套**：所有新工具用 `defineTool`（parameters 自动校验 + output canonical value + render 纯投影 + exec.signal）
- **注册 effect 化**：`ctx.effect()` 返回 disposer；服务类 `extends Service { super(ctx, name) }`
- **构建验证**：`pnpm typecheck` / `pnpm build` / `pnpm test`
- **铁律**：绝不要重启正在承载对话的 dsh web 实例（4500）；需重启由用户手动
- **复用纪律**：License 首行核实；借鉴架构文件头 `Borrowed from` 注释；红线（GPL/AGPL）只借鉴思想
- **已知坑**：WinNAT 保留端口、路径空格 link 拆词（用 junction）、pnpm-workspace `@` 引号、tsdown clean 删 d.ts

---

*方案书 v1.0 · 调研依据 docs/01-06 · 开发方法论 docs/06 · 从 M0 开始执行（先调研后开发，框架先行）*
