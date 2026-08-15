# MEMORY.md — dsh-remote-ide 项目记忆索引

> 更新：2026-08-15（会话交接）· 项目：DeepSeek Harness「服务器开发模式」（dsh-remote-ide）

## 索引

| 文件 | 内容 |
|------|------|
| `project_dsh_remote_ide.md` | **项目进展终态 + ⚠️遗留问题（preset 未显示，下一个 AI 第一任务）** |
| `feedback_ui.md` | 用户 UI 反馈与最终决策（UI 全删，纯 host 工具） |
| `reference_ecosystem.md` | 生态参考、关键路径、modlens 识图方法 |
| `errors_learnings.md` | 11 条踩坑 + 技术要点（含"绝不重启会话宿主实例"铁律） |

## 最新状态（2026-08-15 交接时）

- **项目形态**：DSH「服务器开发模式」= agent preset（remote）+ 纯 host 插件（5 个远程工具：ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write）
- **已删除**：全部 UI（client 半 4000+ 行）、better-sidebar（已卸载）、dsh-web-ui 集成
- **代码**：构建/测试通过，GitHub `harryopo/dsh-remote-ide`（Apache-2.0，latest: e7a7859）
- **环境**：4500 实例运行中（latest dsh + modlens + dsh-remote-ide link）；preset 已装 `~/.dsh/.agent-presets/remote/`
- **⚠️ 未解决**：preset 未出现在新会话模式选择器（排查线索在 project 文件）
- **交接**：AGENTS.md / CLAUDE.md 已写（任何 AI 工具可接手）

---
