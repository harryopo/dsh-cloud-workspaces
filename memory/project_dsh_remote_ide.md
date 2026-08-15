# 项目进展 — dsh-remote-ide（SSH 远程开发）

**Date**: 2026-08-15
**Category**: project
**Source**: conversation

## 项目定位演变

1. **起点**：DSH 的 SSH IDE 插件（dsh-remote-ide），目标"SSH 连接后资源管理器变远程目录、终端即 SSH 终端"
2. **过程**：经历了独立面板 → 右侧工作台 → 与 better-sidebar 集成等多次 UI 迭代
3. **最终方向（用户拍板）**：**开发一种新的 Agent 模式——「服务器开发模式」**：使用该模式时 agent 的生产开发环境 = 远程 Linux 服务器（SSH 连接进入，下载可开发编辑的插件）。即从"SSH IDE 插件"升级为"DSH 的远程开发 agent preset"。

## 已完成的技术资产（可复用）

### SSH 引擎（Host 半，Node/ssh2，已验证端到端）
- `src/engine.ts`：连接池（per-alias 持久、keepalive、ProxyJump 跳板）、exec（超时/输出截断）、PTY shell（WebSocket）、SFTP CRUD（ls/read/write/mkdir/remove/rename）、active 连接状态机
- `src/routes.ts`：`/api/dsh-remote-ide/*` REST + 终端 WebSocket 升级（loopback fence + 输入缓冲）
- `src/store.ts`：主机配置 `~/.dsh/dsh-remote-ide.json`（0600）、~/.ssh/config 导入、secret-free 摘要
- 已真实 SSH 端到端验证（本机 sshd + 密钥认证）

### Client 半
- 右侧 IDE 工作台（frame grid 追加列 + 拖拽 + 宽度持久化，借鉴 dsh-aionui-panel Apache-2.0）
- 远程文件树（懒加载/子树缓存/重命名删除）、CodeMirror 编辑器（SFTP 读写）、xterm 终端
- 主题：已全面改用 DSH 官方 `--dsw-*` token（与生态插件一致，跟随换肤）
- Bundle：官方 `__ModuleLoader__.load` 闭包格式（CJS + banner/footer），平台模块 external
- better-sidebar 集成：注册「远程 IDE」tab；装了 better-sidebar 时入口打开它的 tab（避免双资源管理器）

### 发布
- GitHub: https://github.com/harryopo/dsh-remote-ide（Apache-2.0，已加 dsh-plugin 等 7 个 topic）
- npm 包名 `dsh-remote-ide` 可用，尚未发布（待方向确认）

## 关键技术结论

- **DSH agent preset 机制**：`~/.dsh/agent-presets/<id>/`（preset.yml 元数据 + agent.cordis.yml 组装工具/persona），discovery 每次调用重读目录（热生效）。standard preset 示例：persona + tool-bash/pwsh + tool-fs + tool-fs-search + tool-jobs + skills
- **「服务器开发模式」实现路径**：新 preset `remote`，agent.cordis.yml 注册远程 shell 工具（复用 dsh-remote-ide 的 ssh_exec/ssh_upload 等）+ 远程 fs 工具 + persona 说明"开发环境在远程 Linux"
- 远程化三选一：a) preset + 远程工具注入（推荐，改动小）；b) 远程 shell 后端替换 sandbox（深度）；c) ACP 桥接（不推荐）

---
