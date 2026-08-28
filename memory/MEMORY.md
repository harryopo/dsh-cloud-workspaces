# MEMORY.md — dsh-remote-ide 项目记忆索引

> 更新：2026-08-28（进度同步）· 项目：DeepSeek Harness「服务器开发模式」（dsh-remote-ide v0.2.0）

## 索引

| 文件 | 内容 |
|------|------|
| `project_dsh_remote_ide.md` | **项目进展终态：M0-M3 完成（ctx.ssh + fs-ssh + subprocess-ssh + isolate realm preset）→ M4 待验收** |
| `feedback_ui.md` | 用户 UI 反馈与最终决策（UI 全删，纯 host 工具） |
| `reference_ecosystem.md` | 生态参考、关键路径、modlens 识图方法 |
| `errors_learnings.md` | 11 条踩坑 + 技术要点（含"绝不重启会话宿主实例"铁律） |

## 架构概览（2026-08-28）

```
dsh-remote-ide — DSH「服务器开发模式」三层架构

┌─ HOST PLANE（全局，所有会话可见）──────────────────────────────────┐
│  src/index.ts    插件入口：注册 SshRuntime + 5 个 ssh_* 工具       │
│  src/ssh-service.ts  SshRuntime (ctx.ssh) — Cordis Service        │
│  src/engine.ts   ssh2 引擎：连接池/ProxyJump/exec/SFTP/PTY       │
│  src/tools.ts    ssh_list / ssh_exec / ssh_ls / ssh_read / ssh_write │
│  src/store.ts    主机配置 ~/.dsh/dsh-remote-ide.json (0600)       │
└────────────────────────────────────────────────────────────────────┘
           ↓ ctx.ssh 共享连接池（单一所有者）
┌─ PRESET-SCOPED（仅「服务器开发」会话，isolate realm）─────────────┐
│  src/fs-ssh.ts           SshFileSystem → ctx.fs (13 方法远程适配) │
│  src/subprocess-ssh.ts   SshSubprocessRuntime → ctx.subprocess    │
│                          (resolveExecutable/spawn/spawnTerminal)  │
│  agent.cordis.yml  remote-caps isolate group:                     │
│    fs-ssh + subprocess-ssh + tool-fs + tool-fs-search +           │
│    str-replace-editor + pty + terminal-bash                      │
└────────────────────────────────────────────────────────────────────┘
```

**技术栈**：TypeScript 5.7 · Node ≥22 · ssh2 1.16 · Cordis 4.0 · tsdown 0.22 · vitest 3.0
**依赖关系**：ssh2（运行时）；@deepseek-ai/dsh-{fs,subprocess,settings,system-prompt,tools}（peer）
**构建**：`pnpm build`（tsc 声明 + tsdown 产物，16 文件）；测试：52/52 全过

## 最新状态（2026-08-28 同步时）

### 里程碑完成情况

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 | 引擎与连接池 ctx.ssh（SshRuntime extends Service） | ✅ 完成（2026-08-16） |
| M1 | fs-ssh（ctx.fs 13 方法远程适配，20 用例） | ✅ 完成（2026-08-16） |
| M2 | subprocess-ssh（ctx.subprocess exec/PTY，13 用例） | ✅ 完成（2026-08-16） |
| M3 | preset 组合（isolate realm + persona + 接线） | ✅ 完成（2026-08-18） |
| 追赶 | 依赖升级 0.1.1-rc.2 + 旧文件清理 + GitHub 元数据（`3b6e86c`） | ✅ 完成（2026-08-28） |
| M4 | 真实 Linux 服务器端到端验收 | ⏳ 待验证 |

### 当前末态

- **代码**：构建/测试全绿（52/52），GitHub `harryopo/dsh-remote-ide`（Apache-2.0，latest: `3b6e86c`）
- **git 状态**：工作区干净，所有改动已提交
- **环境**：4500 实例（latest dsh + modlens + dsh-remote-ide link）；preset 已装 `~/.dsh/.agent-presets/remote/`
- **交接文档**：AGENTS.md / CLAUDE.md 已写（任何 AI 工具可接手）

## 最新状态（2026-08-28 晚·新机器环境重建）

### ⚠️ 环境事实（重大变化）
- **开发机已更换**：现在是 `pc-20260826xnis`，用户 `Administrator`（旧记忆里的 Lenovo profile / junction / 4500 实例全部不存在）
- **dsh 环境（新机）**：dsh 0.1.1-rc.2 已全局安装（`npm install -g`）；web profile 已 link 插件：`dsh plugin --profile web add link:C:/Users/Administrator/dsh-remote-ide-dev`（junction → 本仓库，PowerShell `New-Item -ItemType Junction` 创建）
- **preset 已装**：`~/.dsh/.agent-presets/remote/`（preset.yml + agent.cordis.yml）
- **4500 实例**：已由 Agent 启动且挂载插件成功（`http://127.0.0.1:4500`）；npm 未登录（publish 待用户 adduser）
- **M4 第一关通过**：插件树在真实 0.1.1-rc.2 下加载无错（修了 cordis inject 检查，commit `6839a40`）

### 下一步优先级

1. **M4 剩余验收（用户在 4500 UI 操作）**：新会话选「服务器开发」preset → agent ssh_list 建连 → 远程 bash/PTY/写文件；本地 sshd 或真实服务器均可
2. **npm publish（需用户）**：`npm adduser` 登录后 `pnpm publish`；然后官方 Discussions「Show Your Plugins!」发帖
3. **M0 遗留**：broken 重建成功后 engine state 仍 'failed'（不影响功能，统一状态语义时处理）
4. **远期评估**：借鉴 dsh-ssh 的 agent/created 工具遮蔽，做无需 preset 的透明模式
5. **后续候选**：ssh_terminal（PTY 工具）、远程后台任务（ctx.jobs）、远程 grep；远期：远程 sandbox 后端

### 已忽略事项（不再跟进）

- **preset 未显示问题**：DSH 自身开发的限制（用户已指示忽略），根因分析留存于 project 文件 §6.4（docs/06）

---
