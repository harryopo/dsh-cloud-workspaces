# CLAUDE.md

本仓库的完整开发说明见 [AGENTS.md](./AGENTS.md)——任何 AI 开发工具（Claude Code / Trae / Qoder / Codex / Cursor / DSH）开工前请先读它。要点：

- **项目**：DeepSeek Harness 的「云端工作区」（npm `dsh-cloud-workspaces`，曾用名 dsh-remote-ide）——工作区选择器选「云端（SSH）」后，会话的 bash/read/write/edit/glob/grep（+read_image）经 SSH 透明落远程 Linux 服务器，免 preset、零远程安装
- **架构**：双面插件——host 半（ssh2 引擎 + ssh_* 工具 + 会话遮蔽工具 + typert 端点）+ client 半（设置卡「SSH 连接」+ 双 tab 工作区选择器）；旧「服务器开发」preset 已下线，`agent-presets/remote-legacy/` 与 `src/fs-ssh.ts`/`subprocess-ssh.ts` 仅参考
- **命令**：`pnpm build` / `pnpm typecheck` / `pnpm test`；真机验收 `node scripts/e2e-real-server.mjs [alias]`；运行 `dsh web --port 4500`
- **⚠️ 铁律**：跨边界输出必须过 jsonSafe；同文件编辑严格串行；绝不要重启正在承载对话的 dsh web 4500 实例
- **踩坑**：见 AGENTS.md「已知坑」12 条
