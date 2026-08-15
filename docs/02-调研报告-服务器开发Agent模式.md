# 调研报告：DSH「服务器开发 Agent 模式」可行性

> 日期：2026-08-15 · 背景：用户最终决定开发一种新的 Agent 模式——使用该模式时，agent 的生产开发环境为远程 Linux 服务器（SSH 连接进入，下载可开发编辑的插件等），即"进入服务器开发模式"。
> 调研基础：DSH 源码（`.research/dsh-source/deepseek-harness-master`）preset/sandbox/tools 机制、dsh-remote-ide 现有 SSH 引擎资产。

---

## 一、需求理解

| 用户诉求 | 解读 |
|---|---|
| "开发一种新 agent 模式" | DSH 的 Agent 模式 = **agent preset**（内置 standard/code/minimal/cordis 四个，用户可新增） |
| "使用这个模式时是进入服务器开发的模式" | 选择该 preset 后，agent 的"工作环境"是远程 Linux 服务器 |
| "agent 的生产开发环境为 linux 环境" | agent 的 shell/文件操作对象是服务器（命令在服务器跑、文件在服务器读写） |
| "需要 ssh 连接进去" | 用 dsh-remote-ide 已实现的 SSH 引擎建立连接 |
| "下载相应的可开发编辑的插件等等" | 服务器上安装开发工具链（编译器等）由 agent 通过远程 shell 完成 |

**本质**：DSH 的 coding agent 以远程 Linux 为工作台 —— **Remote Development Mode**（类 VS Code Remote-SSH / GitHub Codespaces 的 agent 版）。

---

## 二、DSH 机制事实确认（源码级）

### 2.1 Agent preset 机制（可行性的基石）

- preset = 一个目录：`preset.yml`（元数据：name/description/order）+ `agent.cordis.yml`（agent 平面组合：persona/工具/提示词）
- **用户级 preset 根 = `<dshHome>/.agent-presets/`**（`USER_PRESET_DIR = '.agent-presets'`，discovery.ts:41），目录名即 preset id，**热发现**（每次调用重读，无需重启）
- preset 组合是 AGENT-PLANE：persona 影子默认、工具注册进 host registry、可 `!!js` 条件配置（如 standard 里 `tool-bash` 在 win32 禁用）
- 工具注册自动流入 system-prompt 装配（模型看到工具 schema）✓

### 2.2 远程化的两个层次

| 层次 | 机制 | 说明 |
|---|---|---|
| **工具层（浅）** | preset 里启用远程工具（`ssh_exec`/`ssh_read`/`ssh_write`…），不启用本地 bash/fs | agent "通过工具操作远程"；工具 schema 自动进 prompt；改动小、纯外部实现 |
| **执行层（深）** | 替换 shell/sandbox 后端（`dsh-tool-bash` 的 executor 是 host 平面 `bash-sandbox`，`dsh-sandbox` seam 可挂自定义后端） | agent 的 `bash` 工具**真正跑在远程**（通过 SSH exec/PTY）；体验最"原生"，需实现远程 sandbox 后端，工作量大 |

### 2.3 已有资产（dsh-remote-ide）

- SSH 引擎（ssh2）：连接池/ProxyJump、`exec`（超时/截断）、PTY shell（WebSocket）、SFTP CRUD —— 已端到端验证
- 工具层规划（M3）：`ssh_exec`/`ssh_read`/`ssh_write` 等（按官方 defineTool 规范）
- 主机管理 store（~/.dsh/dsh-remote-ide.json）

---

## 三、方案对比

### 方案 A：preset + 远程工具注入（推荐）

```
~/.dsh/.agent-presets/remote/
├── preset.yml          # name: 服务器开发 / description / order
└── agent.cordis.yml    # persona(远程Linux) + dsh-remote-ide 远程工具
                        #   + 不启用 tool-bash/tool-fs（或保留只读本地）
```

- preset 内注册 `@dsh-remote-ide/remote-tools`（ssh_exec/ssh_read/ssh_write/ssh_ls/ssh_terminal）
- persona 文本："You are a coding agent working on a remote Linux server via SSH..."
- 配合 dsh-remote-ide 的右侧 IDE 面板（资源管理器=远程文件树、终端=SSH PTY）作为可视化观察层
- **优点**：纯外部实现（preset + 插件），零 DSH 改动；工具 schema 自动进 prompt；热生效；可渐进
- **缺点**：agent 的"shell"是 ssh_exec 工具而非原生 bash 工具（体验稍隔一层）；本地 fs 工具与远程 fs 并存需约束（preset 不启用 tool-fs 即可）

### 方案 B：远程 sandbox/shell 后端（深度原生）

- 实现 `dsh-sandbox` 的自定义后端：`bash` 工具的 executor 通过 SSH 执行（`ssh2` 的 exec/PTY），cwd 映射远程路径
- agent 无感知地"就在服务器上"；本地 fs 工具可换成 SFTP 后端（`dsh-fs` 有 backend seam 先例——TDSF 项目做过 `fs_backend/sftp.rs`）
- **优点**：体验最原生（bash 即远程 bash、编辑器保存走 SFTP）；是"真·服务器开发模式"
- **缺点**：实现量大（sandbox 协议、远程 PTY 集成、权限/审批映射、路径语义、错误处理）；sandbox seam 是 host 平面，外部插件能否挂后端需验证（`dsh-sandbox` 注册机制）；风险：跨版本 API 变动

### 方案 C：远程工作区同步（最浅）

- 通过 SFTP 同步把远程目录镜像到本地工作区，agent 无感开发，后台双向同步
- **缺点**：同步延迟/冲突/大文件问题；与"开发环境为远程"语义相悖；不推荐

### 对比结论

| 维度 | A 远程工具 preset | B 远程 sandbox | C 同步 |
|---|---|---|---|
| 改动量 | 小（preset+工具，复用引擎） | 大（sandbox 后端） | 中（同步层） |
| DSH 改动 | 无 | 需验证 seam 可用性 | 无 |
| 体验原生度 | 中（工具层） | 高（执行层） | 中 |
| 风险 | 低 | 中高 | 中 |
| 渐进路径 | 先 A，验证后升级 B 的 shell 部分 | — | — |

**推荐：方案 A 起步（2-4 周可交付 v1），预留方案 B 的演进路径**（B 的 shell executor 可后续替换 A 中的 ssh_exec 调用，接口相同）。

---

## 四、方案 A 架构设计（草案）

```
┌─ 用户侧（Windows/macOS 本地 dsh web）──────────────────────────┐
│  新会话 → 选择「服务器开发」preset                              │
│  ├─ persona：远程 Linux 开发环境说明                           │
│  ├─ 工具：ssh_exec / ssh_read / ssh_write / ssh_ls / ssh_mkdir │
│  │        / ssh_terminal（defineTool，schema 自动进 prompt）   │
│  └─ 不启用 tool-bash / tool-fs / tool-fs-search（本地）        │
│  右侧 IDE 面板（dsh-remote-ide）：远程文件树/编辑器/终端（观察层）│
└───────────────────────┬────────────────────────────────────────┘
                        │ SSH (ssh2 连接池)
┌─ 远程 Linux 服务器 ────▼───────────────────────────────────────┐
│  bash（agent 命令执行）· 文件系统（SFTP 读写）· PTY 终端         │
│  agent 自行安装开发工具链（apt/npm/pip/编译器等）               │
└────────────────────────────────────────────────────────────────┘
```

**preset 的 agent.cordis.yml 草案**：

```yaml
# ~/.dsh/.agent-presets/remote/agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent working on a REMOTE Linux server via SSH.
      All development happens on the server: run commands with ssh_exec,
      read/write files with ssh_read/ssh_write, open a shell with
      ssh_terminal. The server is {{server}}.

- id: remote-tools
  name: 'dsh-remote-ide/remote-tools'   # 插件提供的工具包
  config:
    host: <default alias>

# 本地工具不挂载（开发环境在远程）
# - id: tool-bash ...   (disabled)
# - id: tool-fs ...     (disabled)
```

**M 系列规划**：
- M1（复用现有引擎）：ssh_exec/ssh_ls 工具 + 主机选择流程（连接向导：会话开始时选服务器）
- M2：ssh_read/ssh_write + 保存前 diff 确认（防止远程覆盖）
- M3：ssh_terminal（PTY 工具）/ ssh_grep（远程搜索）/ 后台任务（ctx.jobs）
- M4：可选升级——自定义 sandbox 后端让原生 bash 跑远程（方案 B）

---

## 五、风险与注意事项

1. **preset 组合解析**：agent.cordis.yml 行 name 指向 `dsh-remote-ide/remote-tools` 需要该包的 subpath export（类似 `@deepseek-ai/dsh-tool-bash` 模式）——插件需新增 `./remote-tools` 导出（node half 子入口）
2. **approval 与安全**：远程执行是双刃剑——ssh_exec 需默认危险命令确认（与 DSH permission 体系集成，参考 tools/pre-execute）；凭证存 0600 文件（已有）
3. **本地 fs 工具**：preset 不挂本地 fs 时，agent 无法读本地文件（需要时可挂 `tool-fs` 但提示"本地只读"）——先不挂，保持语义纯净
4. **断线/重连**：ssh 断线时工具报错需可恢复（引擎已有 reconnecting 状态）；长任务建议后台化
5. **Windows 主机**：agent 本地在 Windows，远程 Linux——路径语义（`C:\` vs `/home/`）在工具文档里写清
6. **版本兼容**：preset 机制在 latest dsh 验证（rc.6 的 preset 支持度未确认——用 `npx @deepseek-ai/dsh@latest`）

---

## 六、结论

**完全可行，且 DSH 为此提供了官方扩展点（用户 preset + 工具注册），无需改 DSH 源码。**

- **推荐方案 A**（preset + 远程工具），复用 dsh-remote-ide 全部 SSH 引擎资产，首版范围可控（连接 → ssh_exec/ssh_read/ssh_write → 右侧面板观察）
- **方案 B**（远程 sandbox）作为 v2 演进目标，让 agent 的 bash 原生跑在远程
- 关键前置：插件增加 `remote-tools` node 子入口（defineTool 三件套）+ preset 目录模板 + 连接向导；建议先做"单服务器 preset"（不纠结多机），验证闭环后再扩展

**下一步建议**：① 用 4500 实例验证用户 preset 热发现（写一个 hello remote preset）；② 实现 remote-tools（M1：ssh_exec/ssh_ls）；③ 会话内连接向导；④ 端到端验证"agent 在远程 Linux 上建项目、跑测试"。
