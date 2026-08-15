# 项目进展 — dsh-remote-ide（服务器开发模式）

**Date**: 2026-08-15（更新）
**Category**: project
**Source**: conversation

## 项目定位演变（终局）

1. **起点**：DSH 的 SSH IDE 插件（dsh-remote-ide），"SSH 连接后资源管理器变远程目录、终端即 SSH 终端"
2. **过程**：独立面板 → 右侧工作台 → better-sidebar 集成（多次 UI 迭代，用户均不满意"丑、乱、不稳定"）
3. **UI 最终决策**：**全部删除**。better-sidebar 已从 profile 卸载；client 半（4000+ 行 UI）已从仓库删除。插件变**纯 host 工具插件**，新对话界面不再有任何「远程 IDE」入口。
4. **最终方向（用户拍板）**：**「服务器开发模式」Agent preset**——使用该模式时 agent 的生产开发环境 = 远程 Linux 服务器（SSH 连接、远程执行命令、远程读写文件、安装工具链）。

## 已完成（2026-08-15 末态）

### 代码（已构建/测试通过，已推送 GitHub e7a7859）
- `src/engine.ts`：ssh2 引擎（连接池/ProxyJump/exec/SFTP CRUD/PTY），端到端验证过
- `src/tools.ts`：5 个远程工具（`ssh_list`/`ssh_exec`/`ssh_ls`/`ssh_read`/`ssh_write`，defineTool）
- `src/index.ts`：插件入口（注册工具 + 引擎 + settings + systemPrompt 公告）
- `src/store.ts`：主机配置 `~/.dsh/dsh-remote-ide.json`（0600、~/.ssh/config 导入）
- `src/invariant.ts`、`src/protocol.ts`
- `agent-presets/remote/`：preset 模板（preset.yml + agent.cordis.yml），已复制到 `~/.dsh/.agent-presets/remote/`
- `scripts/start-dsh-web.ps1`：一键启动（4500、latest dsh、自动开浏览器）
- `AGENTS.md` + `CLAUDE.md`：交接文档（任何 AI 可接手）
- `memory/` + `docs/`：记忆与两份调研报告

### 环境（用户机器）
- web profile：`@liustack/modlens@3.16.6` + `dsh-remote-ide`（link: `C:\Users\Lenovo\dsh-remote-ide-dev` junction → 本仓库）
- dsh 实例：4500 端口（latest dsh，承载当前对话，**绝不可重启**）
- preset 已装：`~/.dsh/.agent-presets/remote/`（preset.yml + agent.cordis.yml 均在）

## ⚠️ 遗留问题（下一个 AI 的第一任务）

**「服务器开发」preset 未出现在 4500 的新会话模式选择器中**（用户确认"没了"）。

排查线索（供参考）：
1. 确认 `~/.dsh/.agent-presets/` 是否被 app 的 preset roots 扫描（discovery 的 roots 由 app 组装——查 `apps/cli/src/web.ts` 或 `packages/preset/agent-presets/src/mount.ts` 是否默认包含 user root `~/.dsh/.agent-presets`，还是需要配置）
2. preset 组合是否 broken：`agent.cordis.yml` 里行 `name: 'dsh-remote-ide/remote-tools'` 需要解析到 `C:\Users\Lenovo\dsh-remote-ide-dev\node_modules\dsh-remote-ide`（link 包）——检查该子路径在 profile 的解析（package.json exports `./remote-tools` 已加）；broken 的 preset 会显示为 broken 行而非隐藏，用户说"没了"→ 更可能 roots 没扫到或 UI 不显示 user preset
3. 可用 `dsh --profile web --dump-config` 或直接查 preset 发现 API/日志
4. 备选：preset 组合直接引用插件整体（`name: 'dsh-remote-ide'`）而非子路径，减少解析环节

## 验证闭环（preset 出现后）

1. 新会话选「服务器开发」
2. agent 用 `ssh_list` 找到 local 主机 → `ssh_exec` 远程执行（如 `ls /c/Users/Lenovo`）
3. `ssh_read`/`ssh_write` 读写远程文件
4. 预期：agent 在远程 Linux（本机 sshd 即测试目标）建项目、装工具、跑测试

## 后续候选（已调研，见 docs/02）

- `ssh_terminal`（PTY 工具）、远程后台任务（ctx.jobs）、远程 grep
- 远期：远程 sandbox 后端（原生 bash 跑远程，体验最原生）

---
