# AGENTS.md — dsh-remote-ide 项目交接文档

> 任何 AI 开发工具（Claude Code / Trae / Qoder / Codex / Cursor / DSH）打开本仓库都应先读本文件。它说明项目是什么、架构怎么组织、怎么构建验证、有哪些坑。

## 项目是什么

**DeepSeek Harness (DSH) 的「服务器开发模式」**：让 DSH 的编码 agent 以**远程 Linux 服务器**为开发环境。

- 用户选择新 agent preset **「服务器开发」（remote）**后，agent 通过 SSH 在服务器上执行命令（`ssh_exec`）、读写文件（`ssh_read`/`ssh_write`）、列目录（`ssh_ls`），服务器的工具链（apt/npm/pip）直接可用。
- 本插件（`dsh-remote-ide`）提供这些**远程工具**（host 半，无 UI），与 preset 配合完成闭环。

## 架构

```
src/
  index.ts      # 插件入口：注册 5 个远程工具 + 引擎生命周期 + 设置
  tools.ts      # defineTool 工具：ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write
  engine.ts     # ssh2 引擎：连接池/ProxyJump/exec/SFTP CRUD/PTY（已验证端到端）
  store.ts      # 主机配置 ~/.dsh/dsh-remote-ide.json（0600，~/.ssh/config 导入）
  protocol.ts   # 共享类型（双半时代遗留，host-only 后仍被 tools/engine 引用）
agent-presets/
  remote/       # 「服务器开发」preset 模板（preset.yml + agent.cordis.yml）
scripts/
  start-dsh-web.ps1   # 一键启动 dsh web（4500 端口，latest dsh，自动开浏览器）
tests/          # vitest（store/engine 纯逻辑）
memory/         # 项目记忆（进度/反馈/踩坑/参考）
docs/           # 调研报告（01 生态调研、02 服务器开发模式可行性）
```

## 关键命令

```sh
pnpm install          # 依赖（首次）
pnpm build            # tsc 声明(lib/types) + tsdown 产物(lib/*.js)
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm watch            # tsdown watch
```

### 运行与验证

```powershell
# 一键启动 dsh web（4500；用 @deepseek-ai/dsh@latest，勿用旧 rc.6）
powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh-web.ps1
```

- **改 host 半（src/）需要重启 dsh web**（4500 实例）；client 半已删除（纯 host 插件）。
- ⚠️ **绝不要重启正在承载对话的 dsh web 实例**（4500 通常是！）——会中断会话。需要重启时请用户手动操作，或明确告知后操作。
- preset 安装位置：`~/.dsh/.agent-presets/remote/`（热发现，无需重启）。仓库 `agent-presets/remote/` 是模板，改后复制过去。
- 插件以 link 方式装入 profile：`C:\Users\Lenovo\dsh-remote-ide-dev`（junction → 本仓库）。改代码后 `pnpm build` 即生效（host 半需重启）。

## DSH 插件开发要点（踩坑后沉淀）

- **双面插件**：host 半（exports "."）在 Node 进程；我们已删除 client 半（无 UI）。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml` 挂载。
- **工具注册**：`ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`）；schema 自动进 system prompt；输出 schema 的类型会推导 execute 返回类型——注意 `exitCode: null` vs `undefined` 的对齐（见 tools.ts 的转换）。
- **可选服务用 `ctx.get()`**；注册皆 effect（`ctx.effect`）；`./invariant` 子路径必带。
- **agent preset**：`~/.dsh/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`；agent.cordis.yml 里行 name 可指向插件子路径（如 `dsh-remote-ide/remote-tools`——当前 preset 直接挂插件整体 `remote-ide`，工具自动注册，见 cordis.patch.yml）。
- **host 依赖 external**（tsdown `external`）：`@deepseek-ai/*` 运行时从 profile 解析，不打包。
- **主题**：若未来加 UI，用 `--dsw-*` token（DSH 官方设计体系），不要自创配色/emoji。

## 已知坑

1. **Windows WinNAT 保留端口**（4035-4234 等）→ listen EACCES；用 4500 或 `--port 0`。
2. **路径含空格** → `dsh plugin add link:...` 会被拆词；用 junction（`C:\Users\Lenovo\dsh-remote-ide-dev`）。
3. **pnpm-workspace.yaml 里 `- @xxx/yyy` 开头 @ 要加引号**（YAML tag 解析错误）。
4. **modlens 需要 latest dsh**（rc.6 不加载）；`@liustack/modlens` 3.16.6 已装 profile。
5. **GitHub push 偶发网络中断**（Recv failure）→ 重试即可。
6. **tsdown clean 会删 tsc 的 d.ts** → build 脚本先统一删 lib，tsdown `clean: false`。
7. **连不上 GitHub clone 大仓库** → 用 codeload tarball。

## 当前状态与下一步

- ✅ 已完成：SSH 引擎（端到端验证）、5 个远程工具、remote preset 模板、构建/测试通过、4500 实例运行中
- ⏳ 待验证：**4500 上「服务器开发」preset 是否出现在新会话模式选择器**、agent 用 ssh_exec 操作远程的端到端流程
- 🔜 后续候选：ssh_terminal（PTY 工具）、远程后台任务（ctx.jobs）、远程 grep；远期：远程 sandbox 后端（原生 bash 跑远程）

## 参考资料（本地）

- DSH 源码：`.research/dsh-source/deepseek-harness-master/`（preset/插件机制可查）
- 官方文档：`docs/user/develop/`（插件开发）+ `docs/cookbook/`（extension-cookbook、adding-a-tool）
- 项目记忆：`memory/`（进度/反馈/踩坑/参考）
- 调研报告：`docs/01-调研报告-SSH-IDE插件.md`、`docs/02-调研报告-服务器开发Agent模式.md`
