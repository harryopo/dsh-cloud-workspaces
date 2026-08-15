# MEMORY.md — dsh-remote-ide 项目记忆索引

> 更新：2026-08-15 · 项目：DeepSeek Harness SSH 远程开发（dsh-remote-ide）

## 索引

| 文件 | 内容 |
|------|------|
| `project_dsh_remote_ide.md` | 项目进展与架构决策（SSH 引擎 → 服务器开发 Agent 模式） |
| `feedback_ui.md` | 用户对 UI 的持续反馈与偏好 |
| `reference_ecosystem.md` | 生态参考（better-sidebar/dsh-web-ui/modlens 等）与关键路径 |
| `errors_learnings.md` | 踩坑记录与关键技术点 |

---

## 最新状态（2026-08-15）

**方向转变**：用户最终决定开发 **「服务器开发 Agent 模式」**——DSH 的新 agent preset，使用该模式时 agent 的生产开发环境为远程 Linux 服务器（SSH 连接进入，下载可开发编辑的插件）。已确认 DSH 机制：用户级 preset 放 `~/.dsh/agent-presets/<id>/`（preset.yml + agent.cordis.yml），可组装远程 shell/fs 工具。

**待办**：① 保存记忆（本次）；② 输出「服务器开发模式」可行性调研报告；③ 后续开发该 preset（复用 dsh-remote-ide 的 SSH 引擎）。

---

## 记忆文件清单（详见各文件）
