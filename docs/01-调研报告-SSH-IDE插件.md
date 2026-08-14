# DSH SSH IDE 插件 — 深度调研报告

> 目的：为 DeepSeek Harness (DSH) 开发「SSH IDE」插件（SSH 连接后，资源管理器变为服务器文件目录、终端即 SSH 终端），避免重复造轮子，站在现有生态肩膀上，高质量开源抢占 dsh-plugin 生态位。
>
> 调研日期：2026-08-14 · 调研范围：dsh-plugin GitHub 生态、DSH 官方 SDK、现有 IDE/SSH 插件源码、本地 TDSF 项目资产

---

## 一、结论速览（TL;DR）

1. **方向可行且生态位空缺**：现有插件要么是「本地 IDE」（DSH-better-sidebar 665★）、要么是「SSH 工具面板」（dsh-ssh，有终端/SFTP/隧道但**没有**远程文件树 + 远程编辑 + 远程 Git 的 IDE 集成）。「SSH 连接 → 整个 IDE 变为远程」这个组合**目前无人做**，是明确的差异化空位。
2. **不必从零写**：三大可复用资产已经就位：
   - `@linxin666/dsh-ssh`（Apache-2.0，npm 已发布）—— 完整的 Node ssh2 引擎（连接池/exec/PTY/SFTP/隧道/集群）+ 主机管理 UI + WebSocket 终端，可直接借鉴甚至依赖；
   - `DSH-better-sidebar`（MIT，665★）—— 完整本地 IDE 工作台 + **官方服务化扩展点** `ctx.betterSidebar.registerTab()/registerFileViewer()`，消费插件可注册自己的 tab 和文件预览器（`fetchStrategy: 'custom'` 支持自定义拉取——远程文件的天然入口）；
   - 本地 TDSF 项目 —— Rust russh 实现（架构不同不可直用），但其 shell 注入脚本（bash/zsh/fish OSC7）、`TerminalTransport` 抽象、远程文件树状态设计是**可平移的资产**。
3. **技术路线**（与官方调研文档结论一致）：不选 code-server/Theia（300MB+ 重型），自研轻量双面插件：Node host 侧 ssh2 引擎 + Web UI 侧 xterm.js/CodeMirror 6，包体增量 < 5MB。
4. **License 合规**：ssh2 (MIT)、xterm.js (MIT)、CodeMirror (MIT)、better-sidebar (MIT)、dsh-ssh (Apache-2.0) 全部干净；**红线**：sshfs (GPL-2.0)、Warp/Coder (AGPL-3.0)、VSCode Remote (专有) —— 只借鉴思想，不复制代码。

---

## 二、生态盘点：现有插件 vs 我们

| 插件 | Star | 本地 IDE | SSH 终端 | SSH 文件管理 | 远程编辑 | 远程 Git | 定位 |
|---|---|---|---|---|---|---|---|
| DSH-better-sidebar | 665 | ✅ 完整 | ✅ 本地 PTY | — | ✅ 本地 | ✅ 本地 | 本地 IDE 工作台 |
| dsh-web-ui（全家桶） | 1.7k | 右侧面板（文件树/预览/SCM） | ✅ (dsh-ssh) | ✅ SFTP 上传下载 | ❌ | ❌ | 插件集合 |
| dsh-ssh（全家桶子包） | — | ❌ | ✅ WebSocket xterm | ⚠️ 仅传输面板 | ❌ | ❌ | SSH 运维工具 |
| dsh-codeui | 0（刚发） | VSCode 三栏 diff 查看 | ❌ | ❌ | ❌（只读 diff） | ❌ | 代码变更查看 |
| dsh-side-panel | 17 | 右侧面板 | ✅ | ⚠️ 浏览 | ⚠️ | ⚠️ Git 审查 | 右侧工作区 |
| **我们的 dsh-remote-ide** | — | **远程模式** | **✅ SSH PTY** | **✅ 完整 SFTP CRUD** | **✅ CodeMirror 远程读写** | **✅ 远程 git** | **SSH 远程 IDE** |

**结论**：dsh-ssh 证明了 SSH 引擎在 DSH host 进程跑得通；better-sidebar 证明了 IDE UI 的形态与扩展机制。两者相加 + 远程模式 = 我们要做的。

---

## 三、关键技术调研结果

### 3.1 DSH 插件架构（双面插件，官方 SDK）

- **Host 半**（Node 进程）：`@deepseek-ai/cordis` 插件框架 + `@deepseek-ai/dsh-host-webserver`（`ctx.webServer.register(route)` / `registerUpgrade(ws)`）+ `@deepseek-ai/dsh-tools`（agent 工具）+ `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-settings`
- **Client 半**（浏览器）：`@deepseek-ai/dsh-client-runtime` / `dsh-client-locale` / `dsh-client-ui-slots` / `dsh-client-connection`；`package.json` 里 `dsh.client.inject` 声明依赖，`exports["./client"]` 提供浏览器包（`/plugins/<id>/client.js`）
- **挂载**：npm 包声明 `dsh.bundle.patch`（cordis.patch.yml 内容）+ `dsh.client`，一条命令 `dsh plugin --profile web add <pkg>` 完成安装挂载；开发态用 `link:` 引用本地目录
- **UI 扩展**：侧边栏无官方 slot → 社区用 DOM 注入 + MutationObserver 自愈（dsh-ssh 做法）；中心列可用独立 React root 挂载面板
- **better-sidebar 服务扩展点**（消费插件骨架）：
  ```ts
  // client half
  import type {} from 'dsh-better-sidebar'   // 类型合并
  export const inject = ['betterSidebar']
  ctx.effect(() => ctx.betterSidebar.registerTab({ id: 'my:remote', title: '远程', component }))
  ctx.effect(() => ctx.betterSidebar.registerFileViewer({
    id: 'my:remote-code', exts: [], fetchStrategy: 'custom',
    load: (path, scope) => fetchRemoteFile(path),   // ← 远程文件入口！
    component,
  }))
  ```
  ⚠️ 外部 viewer 无内置保存通道（保存是内置 code viewer 走 host fs.write）；远程编辑器需自带 CodeMirror + 保存按钮走我们自己的 SSH API。

### 3.2 dsh-ssh 引擎剖析（最佳参考实现）

- 依赖：`ssh2` + `@xterm/xterm` + `@xterm/addon-fit` + `ws`，全部纯 JS/无原生编译坑
- `SshEngine`：per-alias 持久连接池（空闲 30min 清扫、keepalive、ProxyJump 跳板、隧道 pin）、exec（超时/输出截断/代理对安全）、PTY shell（`ShellSession {onData,onExit,send,resize,close,pause,resume}`）、SFTP（`/ls` 已暴露 `RemoteDirEntry {name,type,size,mtimeMs,mode}`）、隧道（本地端口转发）、集群并发
- 主机存储：`~/.dsh/dsh-ssh.json`（密码明文 0600，密钥路径/passphrase），支持从 `~/.ssh/config` 导入；客户端只见 secret-free 摘要
- API：`/api/dsh-ssh/*` REST + `/api/dsh-ssh/terminal` WebSocket 升级（帧协议 `ready/output/exit` ↔ `input/resize`）
- UI：侧边栏 DOM 注入入口（MutationObserver 自愈防 React 重渲染驱逐）+ 中心列 React root 面板（HostsTab/TerminalTab/TransferTab/TunnelsTab/ClusterTab）
- Agent 工具：`ssh_list/ssh_exec/ssh_upload/ssh_download/ssh_tunnel/ssh_cluster` + 系统提示词公告

**缺口（= 我们的机会）**：TransferTab 的文件浏览只是「选择路径上传下载」，没有文件树/打开编辑/远程 Git/文件搜索。

### 3.3 DSH-better-sidebar 剖析（IDE 形态参考）

- Host：fs-tree（懒加载目录树）、pty-manager（node-pty）、git.ts（本地 git 封装）、tools、jobs 事件回放
- Client：Sidebar.tsx（双工作台：右侧栏 + 底部面板）、ExplorerView（文件树）、TextEditor（**CodeMirror 6**，Ctrl+S 原子保存、切 tab 不丢草稿）、TerminalView（xterm + node-pty）、GitView（VSCode 式 diff tab、stage/commit）、DiffView、TabBar、split-pane；懒加载 chunk（xterm/CodeMirror/Univer 按需）
- 服务化注册：7 内置 tab（explorer/git/subagent/terminal/browser/editor/diff）+ 9 viewer（image/pdf/docx/xlsx/pptx/markdown/html/code/binary-download）
- 会话隔离：每个 session 独立布局/tab 状态持久化

### 3.4 本地 TDSF 项目资产（tdsf-terminal-agent-clone）

- Rust (russh 0.61) 后端 + React 19 前端，Tauri IPC——**架构与 DSH 不同，不能直用**
- 可平移资产：
  - **远端 shell 注入脚本**（bash `--rcfile` / zsh ZDOTDIR / fish `-C` + OSC7 cwd 上报）——独立文件资产
  - `TerminalTransport {id,write,resize,close}` 抽象（本地/远程统一）
  - 远程文件树状态设计（子树缓存 + lazy 加载 + 失效折叠）
  - TOFU 主机指纹验证（randomart 渲染 + known_hosts 兼容）
  - 10 态 SSH 状态机设计
- 已知坑：SFTP 全量读写大文件卡 UI（需分块/大小上限）、无 agent 认证、无 ssh config 解析（dsh-ssh 已补）

### 3.5 官方调研文档结论（docs/idea-to-dev-output/）

- 07-调研 SSH 远程操控：对比过 code-server/Theia/OpenVSCode/sshfs/electerm/tabby
- 15-调研 WebIDE 与 SSH 文件管理集成：**结论 = 自研轻量**（AntD Tree + Monaco + xterm.js，包体 <5MB），拒绝重型方案
- 17-方案书 v9.0：AI 原生运维 IDE 定位（Plan-Act 审批闸门、证据可信度、运维 @命令）
- License 矩阵：Tabby/electerm (MIT) 同栈可移植；sshfs (GPL-2.0)/Warp (AGPL-3.0) 红线

---

## 四、推荐方案：dsh-remote-ide 双面插件

### 4.1 架构

```
┌─ Host 半（Node 进程，独立包）─────────────────────────────┐
│  RemoteIdeEngine（ssh2）                                  │
│   ├─ 连接池（per-alias 持久、keepalive、ProxyJump）        │
│   ├─ exec（超时/截断/防代理）                              │
│   ├─ PTY shell（WebSocket 升级，复用 dsh-ssh 帧协议）      │
│   ├─ SFTP CRUD（list/stat/read/write/mkdir/rm/rename）    │
│   └─ git 封装（status/diff/log/commit 走远程 exec）        │
│  /api/dsh-remote-ide/* 路由                                │
│  agent 工具（可选：remote_read/remote_write/remote_exec）  │
│  主机存储 ~/.dsh/dsh-remote-ide.json（0600）               │
└───────────────────────────────────────────────────────────┘
┌─ Client 半（浏览器）──────────────────────────────────────┐
│  远程主机管理（表单/导入 ssh config/指纹确认 TOFU）         │
│  远程资源管理器（文件树：懒加载 + 子树缓存）                │
│  远程编辑器（CodeMirror 6：打开走 SFTP read，保存走 write） │
│  远程终端（xterm.js + WebSocket PTY）                      │
│  远程 Git 面板（status/diff/stage/commit）                 │
│  远程文件搜索 + 上传/下载                                  │
│  接入：better-sidebar registerTab/registerFileViewer（有） │
│        + 独立面板 DOM 注入（无 better-sidebar 时兜底）     │
└───────────────────────────────────────────────────────────┘
```

### 4.2 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| SSH 引擎 | Node `ssh2`（借鉴 dsh-ssh） | DSH host 是 Node；纯 JS 无编译坑；dsh-ssh 已验证 |
| UI 集成 | better-sidebar 扩展 + 独立兜底双轨 | 用户装 better-sidebar 则融入其工作台；否则独立可用 |
| 远程编辑器 | CodeMirror 6（自带保存按钮） | better-sidebar 同款；外部 viewer 无保存通道，自持 CodeMirror 最可控 |
| 远程 Git | 远程 exec git 命令 + 解析 | 无需在服务器装任何东西 |
| 文件传输 | SFTP 分块/限流 + 进度 | 避免 TDSF 全量读卡 UI 的坑 |
| 安全 | 主机指纹 TOFU 确认；密码 0600 存储；隧道仅 127.0.0.1 | 对齐 dsh-ssh/TDSF 最佳实践 |
| 包形态 | 单包双面（exports "." + "./client"），Apache-2.0 | 与 dsh-ssh 一致 |

### 4.3 里程碑

- **M1 引擎**：SshEngine（连接池/exec/PTY/SFTP CRUD/主机存储）+ 路由 + WebSocket 终端（参考 dsh-ssh 移植）
- **M2 远程 IDE 核心**：远程文件树 + 远程编辑器（读/保存）+ 远程终端 —— 交付首个可用版，发 v0.1.0
- **M3 远程 Git + 搜索**：Git 面板（status/diff/stage/commit）、文件内容搜索
- **M4 打磨与发布**：i18n、设置页、懒加载、错误处理、README/演示 gif、npm 发布、GitHub 开源、awesome-dsh-plugin PR

### 4.4 发布与增长计划

1. 仓库名建议：`dsh-remote-ide`（语义直白）；npm：`dsh-remote-ide`（若被占则 `@<user>/dsh-remote-ide`）
2. README 中英双语 + 演示动图（gif 对 star 增长最关键）
3. 打 `dsh-plugin` topic + awesome-dsh-plugin 提交 PR（268 插件列表，快速收录）
4. 与 dsh-market 收录联动；在 DSH 官方社区/微信群宣传
5. 与 better-sidebar 作者联动（互相推荐），可考虑贡献「远程」支持上游

---

## 五、风险与注意

- **npm 包名竞争**：`SakalioLabs/dsh-code-ide` 只有空壳无代码，暂无实质威胁；但生态爆发期要快（近两周大量新插件出现）
- **License**：只借鉴不复制 GPL/AGPL 项目代码；dsh-ssh 是 Apache-2.0 可参考（借鉴实现而非逐行拷贝，署名其贡献）
- **安全责任**：远程执行是双刃剑——工具需默认拒绝 + 用户确认；文档明示风险
- **DSH SDK 变更**：当前 rc.6，API 可能微调；锁定 peer 版本
- **测试**：无真实服务器时用 ssh2 的 mock server（TDSF 有 russh server 先例；Node 侧可用 `ssh2` 的 server 模式或 `mock-ssh-server`）

---

*配套材料：调研原始资料位于 `.research/`（dsh-ssh 源码、DSH-better-sidebar 源码）、`D:\ai\linux教学一体\docs\idea-to-dev-output\`（15/17 号文档）、`D:\ai\linux教学一体\tdsf-terminal-agent-clone\`（TDSF 代码）。*
