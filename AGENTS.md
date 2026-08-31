# AGENTS.md — dsh-remote-ide 项目交接文档

> 任何 AI 开发工具（Claude Code / Trae / Qoder / Codex / Cursor / DSH）打开本仓库都应先读本文件。它说明项目是什么、架构怎么组织、怎么构建验证、有哪些坑。

## 项目是什么

**DeepSeek Harness (DSH) 的「云端工作区」**：让 DSH 的编码 agent 以**远程 Linux 服务器**为开发环境，**免 preset、与本地体验一致**。

- 用户在「添加工作区」里选「云端（SSH）」tab → 选主机 + 远端目录 → 官方收养为工作区；之后该会话的官方工具（bash/read/write/edit/glob/grep）**透明落远程**（agent/created 钩子在 agent scope 注册同名遮蔽工具），另有全局 `ssh_*` 工具（`ssh_list`/`ssh_exec`/`ssh_ls`/`ssh_read`/`ssh_write`/`ssh_workspace`）。
- 本插件（`dsh-remote-ide`）双面：host 半（SSH 引擎 + 工具 + 端点）+ client 半（设置卡「SSH 连接」+ 双 tab 工作区选择器）。
- 旧「服务器开发」preset 已下线（2026-08-30）；`agent-presets/remote-legacy/` 与 `src/fs-ssh.ts`/`subprocess-ssh.ts` 仅作 fs/subprocess 真 seam 路线的参考实现，**不再部署**。

## 架构

```
src/
  index.ts          # 插件入口：SshRuntime + 6 个 ssh_* 工具 + 设置 + typert 通道 + 会话路由安装
  session-tools.ts  # ★核心：agent/created 钩子 → 占位会话在 agent scope 注册
                    #   bash/read/write/edit/glob/grep 遮蔽工具 + 动态 system prompt 段
  tools.ts          # defineTool：ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write/ssh_workspace
  ssh-service.ts    # SshRuntime extends Service（ctx.ssh，唯一连接所有者）
  engine.ts         # ssh2 引擎：连接池/ProxyJump/exec/SFTP CRUD/PTY/keyboard-interactive
  jsonsafe.ts       # 输出边界净化（跨边界输出一律过它，见「核心纪律」）
  workspace.ts      # 占位工作区路由（remote/<hostId>/<base64url>，纯函数+可注入 IO）
  host-settings.ts  # 设置卡片 host 配置 namespace（settings）
  typert.ts         # Typert 远程端点（主机 CRUD/测试连接/目录浏览/占位创建）
  store.ts          # 主机配置 ~/.dsh/dsh-remote-ide.json（0600，~/.ssh/config 导入）
  protocol.ts       # 共享类型
  fs-ssh.ts         # [legacy 参考] SshFileSystem → ctx.fs 13 方法（真 seam 路线，不再部署）
  subprocess-ssh.ts # [legacy 参考] SshSubprocessRuntime → ctx.subprocess（同上）
client/
  index.js          # client 半：设置卡「SSH 连接」+ WorkspacePicker 双 tab
                    #   （手写 createElement，无 JSX；填充官方 directory-flow 插槽）
agent-presets/
  remote-legacy/    # [已下线] 旧「服务器开发」preset 模板，仅参考
scripts/
  start-dsh-web.ps1       # 一键启动 dsh web（4500；⚠️ npx 下载慢，见下）
  e2e-real-server.mjs     # 真机验收：node scripts/e2e-real-server.mjs [alias]（25 项检查）
tests/          # vitest 98 用例（含 session-tools/engine-connection 并发与自愈回归）
memory/         # 项目记忆（进度/反馈/踩坑/参考）——最新进展在 project 文件顶部节
docs/           # 03 方案书（纲领）+ 06 开发方法论（依据），索引见 docs/README.md
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
# 推荐：本机已全局安装 dsh 0.1.1-rc.2，直接起（秒级）
dsh web --port 4500
# 或一键脚本（内部 npx @deepseek-ai/dsh@latest 每次重新下载，慢网络下 5 分钟装不完）
powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh-web.ps1
```

- **改 host 半（src/）需要重启 dsh web**（4500 实例）；client 半是设置卡片（设置页「SSH 连接」），无需单独构建。
- ⚠️ **绝不要重启正在承载对话的 dsh web 实例**（4500 通常是！）——会中断会话。需要重启时请用户手动操作，或明确告知后操作。
- 插件以 link 方式装入 profile：`C:\Users\Administrator\dsh-remote-ide-dev`（junction → 本仓库）。改代码后 `pnpm build` 即生效（host 半需重启）。
- 插件加载的运行时验证：`curl http://127.0.0.1:4500/plugins/dsh-remote-ide/client.js` 返回 200 即已加载。
- 会话路由（agent/created 钩子）诊断：`~/.dsh/dsh-remote-ide-debug.log`（scope.logger 不落盘，钩子链路只在这里留痕；文件 512KiB 自动重置）。

## DSH 插件开发要点（踩坑后沉淀）

- **双面插件**：host 半（exports "."）在 Node 进程；client 半（exports "./client"，web 端 ModuleLoader 直执行 bundle）提供设置页「SSH 连接」卡片——**必须 React.createElement，不能用 JSX**（web 端不转译）。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml` 挂载。
- **工具注册**：`ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`）；schema 自动进 system prompt；输出 schema 的类型会推导 execute 返回类型——注意 `exitCode: null` vs `undefined` 的对齐（见 tools.ts 的转换）。
- **会话遮蔽工具**：订阅走 **`ctx.on('agent/created', cb)`** 事件总线（AgentRegistry 服务上没有 on）；遮蔽工具只能注册进 `payload.agent.ctx`（agent scope）——**绝不退回插件级 ctx**（会全局遮蔽本地会话的官方工具）；钩子整体吞异常，绝不阻塞会话创建。
- **可选服务用 `ctx.get()`**；注册皆 effect（`ctx.effect`）；`./invariant` 子路径必带。
- **host 依赖 external**（tsdown `external`）：`@deepseek-ai/*` 运行时从 profile 解析，不打包。
- **主题**：若未来加 UI，用 `--dsw-*` token（DSH 官方设计体系），明暗自适应用**成对 token**（fill + label-primary-foreground），不要自创配色/emoji。

## 已知坑

1. **Windows WinNAT 保留端口**（4035-4234 等）→ listen EACCES；用 4500 或 `--port 0`。
2. **路径含空格** → `dsh plugin add link:...` 会被拆词；用 junction（`C:\Users\Administrator\dsh-remote-ide-dev`）。
3. **pnpm-workspace.yaml 里 `- @xxx/yyy` 开头 @ 要加引号**（YAML tag 解析错误）。
4. **modlens 需要较新 dsh**（旧 rc.6 不加载）；`@liustack/modlens` 3.16.6 已装 profile。
5. **GitHub push 偶发网络中断**（Recv failure）→ 重试即可。
6. **tsdown clean 会删 tsc 的 d.ts** → build 脚本先统一删 lib，tsdown `clean: false`。
7. **连不上 GitHub clone 大仓库** → 用 codeload tarball。
8. **Mimosa 钩子偶发误报**（把字符串比较当 SQL 注入、env 派生路径当命令注入）→ 整文件 Write 重写着可过；测试设计上避开「环境变量派生路径 → spawn」的数据流。
9. **同文件多个 Edit 并行会相互覆盖**（已犯 4 次）→ 同一文件的修改必须严格串行。
10. **vitest fake 实例泄漏**：`FakeClient.instances` 只在所属 describe 的 beforeEach 清理——新 describe 忘了清，`instances[0]` 拿到陈旧对象导致诡异超时。
11. **搜官方代码要进内层**：dsh 全局包 `lib/` 只是引导 stub，真正的包在其 `node_modules/@deepseek-ai/`。

## 当前状态与下一步（2026-08-30 深夜三 · 全量审查后）

- ✅ **方向转型完成**：去 preset 化——工作区选择器「本机 / 云端（SSH）」双 tab（client 填充官方 `directory-flow` 插槽，onPicked 官方收养）+ `src/session-tools.ts` agent/created 钩子在 agent scope 注册同名遮蔽工具（免 preset 透明模式，核心竞争力）。细节见 `memory/project_dsh_remote_ide.md` 顶部三节
- ✅ **全量代码审查 + 修复**（v0.2.1）：P0×5（openShell 双重释放 / getConnection 陈旧 rejection 毒化 / 钩子全局污染防护 / ProxyJump 探测必挂+泄漏 / 前端同名主机覆盖）+ P1×7（大文件读、父目录创建、超时保护、服务缺失守卫、日志上限、空 old_string、浏览竞态）。**98/98 测试 + typecheck + build 全绿**；清单与已知遗留见 `memory/project_dsh_remote_ide.md` 深夜三节
- ⚠️ **工作区有大量未提交改动**（转型全套 + 9 个真机 bug + 本次审查修复）——接手先看 `git status` / `git diff --stat`
- ⏳ **待真机验证（首要任务）**：用户浏览器走一遍——双 tab 选择器出现；云端工作区会话内官方工具透明落远程。**主要风险点：`payload.agent.ctx` 在真实 dsh 运行时是否存在**（缺失时钩子留痕于 `~/.dsh/dsh-remote-ide-debug.log`，表现为该会话无遮蔽工具）
- 📌 验证通过后：提交改动（分主题）→ npm publish（需用户 `npm adduser`）→ 官方 Discussions「Show Your Plugins!」发帖（竞品迭代快，宜早）
- 核心纪律 —— **跨边界输出必须过 jsonSafe**（typert 端点 + 工具 execute 返回）；**同文件编辑串行**；**绝不重启承载会话的 4500 实例**

## 参考资料（本地）

- DSH 源码：`.research/dsh-source/deepseek-harness-master/`（**rc.5 旧版，仅历史参考；契约以 npm 0.1.1-rc.2 的 d.ts 为准**）
- 官方文档：`docs/user/develop/`（插件开发）+ `docs/cookbook/`（extension-cookbook、adding-a-tool）
- 项目记忆：`memory/`（进度/反馈/踩坑/参考）
- 竞品（2026-08-28 调研）：`dsh-ssh/dsh-ssh`（工具层遮蔽路由）、`CrazyShout/dsh-ssh-remote`（服务层 monkey-patch）、`flymysql/dsh-remote`（SFTP 镜像）
