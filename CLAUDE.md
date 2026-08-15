# CLAUDE.md

本仓库的完整开发说明见 [AGENTS.md](./AGENTS.md)——任何 AI 开发工具（Claude Code / Trae / Qoder / Codex / Cursor / DSH）开工前请先读它。要点：

- **项目**：DeepSeek Harness 的「服务器开发模式」——agent 以远程 Linux 服务器为开发环境（SSH 工具 + agent preset）
- **架构**：纯 host 插件（src/index.ts 注册 5 个远程工具 + ssh2 引擎），无 UI；preset 模板在 agent-presets/remote/
- **命令**：`pnpm build` / `pnpm typecheck` / `pnpm test`；启动用 `scripts/start-dsh-web.ps1`（4500 端口）
- **⚠️ 铁律**：绝不要重启正在承载对话的 dsh web 实例（4500）——会中断会话；需要重启时请用户手动操作
- **踩坑**：WinNAT 保留端口、路径空格 link 拆词、pnpm-workspace @ 引号、modlens 需 latest dsh 等（详见 AGENTS.md）
