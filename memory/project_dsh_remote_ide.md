# 项目进展 — dsh-remote-ide（服务器开发模式）

**Date**: 2026-08-28（苹果风 UI）· **Category**: project · **Source**: conversation + git history

## 2026-08-28 深夜二：设置卡片苹果风重设计（commit b6435e6）

- 用户反馈「SSH 的 UI 太丑，不够苹果风」→ 重写 client/index.js 的 CSS（保持 DOM/逻辑不动）
- **视觉语言**：24px 大圆角对话框、10-16px 圆角控件、多层柔和阴影、-apple-system/PingFang 系统字体栈、半透明卡片（color-mix 88%+透明）、品牌蓝主按钮、hover 微上浮/scale(0.97) 按压反馈、focus 蓝色光环
- **去 emoji**：📁 → › 目录符号 + · 文件符号；口令 pill 用 CSS 圆点 + dri-pill-ok 绿色态（文本「口令已保存」）
- **⚠️ 深色模式坑（浏览器实测抓到）**：`--dsw-alias-button-primary-fill` 在 DSH 深色主题解析为近白 #f9fafb，按钮硬编码白字 → 白底白字不可见；修复：文字色改用配套 token `--dsw-alias-label-primary-foreground`（明暗自适应）
- **验收**（browser_use 计算样式审计）：深色下接近 macOS 系统设置原生面板（#2c2c2e 面板 + 24px 圆角 + 柔和阴影 + 系统字体），无 emoji，控制台无 JS 错误
- 通用原则：DSH 插件 UI 的明暗自适应必须用**成对 token**（fill + label-primary-foreground），不能硬编码文字色

## 2026-08-28 深夜：SSH 主机设置卡片（client 半）上线

### 背景（用户反馈驱动）
- 用户：不要开普通会话说，用功能时弹设置窗口先设置 SSH 连接，参考开源方案 UI
- 决定：恢复 client 半（仅设置面板），走官方 settings.section slot + Typert remote 双通道

### 实现（commit dbcd520 + d7462e4）
- **`src/host-settings.ts`**：settings namespace `dsh-remote-ide-hosts`（kebab-case）+ HostConfig schema（hosts dict 保 write-only 密码 + role('secret') + applies live）
- **`src/typert.ts`**：SshRemoteService（普通 Service + bindTypertRemote 绑定）+ HOST_TYPERT_CONTRIBUTION（face:'host' + invocations 严格描述符，ctx.typert.register）——7 端点：listHosts/saveHost/deleteHost/testConnection/listRemoteDir/createPlaceholder/listPlaceholders
- **`src/engine.ts`**：`testConfig(cfg)`（表单直连探测，不走 store）+ `testEntry` 抽取
- **`client/index.js`**（手写自包含 ModuleLoader 格式，React createElement 非 JSX）：settings.section slot（id 'ssh-hosts'，label「SSH 连接」）+ 主机 CRUD UI + 测试连接 + 远端目录浏览 → 占位工作区创建；样式 --dsw-alias-* token
- **桥接**：saveHost/deleteHost 同步 upsert/remove HostStore → ssh_* 工具与占位路由立即可用
- package.json：exports './client' + dsh.client.platform 'web' + peer/devDep dsh-typert-protocol

### 踩坑（重要，每条都是血泪）
1. **typert-protocol 0.1.1-rc.2 的 host 半注册 API**：`ctx.typert.register(contribution)`（dsh-typert-registry 提供，类型未导出需 module augmentation）；**不是**装饰器（@Remote/TypertRemoteService 是 SRC 扫描范式，tsdown/rolldown-oxc 不转译 standard decorators → 产物残留 @Remote 语法 Node 崩）
2. **端点必须返回裸业务值**：gateway 已用 {ok,value} 表达调用成败；端点再自包 EndpointResult → client 收到双层 {ok,value:{ok,value}}，unwrap 只解一层 → 列表永不显示（browser_use 真机抓到）
3. **deleteHost 必须 settings.mutate 单键 unset**（scope.update 是递归 merge 删不掉键；mutate 在 provider 级 ctx.settings 不在 scope）
4. **client 半不用 JSX**：web 端 ModuleLoader 直接执行 bundle 不转译 → 必须 React.createElement；ModuleLoader.load id 必须是**包名**（'dsh-remote-ide'，带 #client 后缀会 "loaded without registering"）
5. **namespace 服务访问用 ctx.get('remote.ssh-remote')**：ctx.remote['ssh-remote'] 属性访问触发 cordis inject 检查（同 host 半 ssh 问题）
6. **同文件并行 Edit 相互覆盖再犯**（exports['./client'] 丢了，client-modules 报错）——同文件修改必须串行
7. **slot 注册**：`ctx.slots.inject(key, () => ctx.slots.register({name,id,order,label,inject}, Component))`；label 是函数；inject 返回体 hooks 值须 {getSnapshot, subscribe}

### 验证（browser_use 真机三轮）
- 设置页「SSH 连接」区块出现；添加主机 → 卡片（口令✓）→ 测试（显示错误不白屏）→ 删除（确认+消失+下拉同步）全流程通过；控制台无插件错误；侧边栏「服务器开发」preset 可见

### 用户操作流（对标 dsh-ssh 30 秒上手）
1. 设置 → SSH 连接 → 添加主机（host/port/user/密钥或口令）→ 保存
2. 保存后主机即被 ssh_list 看到、ssh_* 工具可用（桥接 store）
3. 远端工作区：选主机浏览目录 → 绑定 → 新会话选本地占位路径 → 全远程

## 2026-08-28 晚：占位工作区（placeholder workspace）落地

### 背景（用户反馈驱动）
- 4500 新会话选「服务器开发」→ 弹「选择工作区」→ 只有本地目录，无 SSH 入口
- 用户指定借鉴 dsh-ssh/dsh-ssh 的 UI 与代码

### dsh-ssh 机制（源码级调研，MIT）
- **占位目录映射**：远程路径 → 本地占位目录 `<DSH_HOME>/remote/<hostId>/<base64url(远程路径)>`（可逆 base64url 单段；hostId 校验拒穿越；decode 必须还原为 / 开头绝对路径）
- **UI 流程**：设置页配主机（settings namespace + client UI）→ client 里浏览远端目录 → 选定 → host 建 placeholder → 注册为 DSH workspace
- **会话路由**：agent/created 钩子看 session.header.cwd 落 placeholder root → agent scope 注册同名遮蔽工具（bash/read/write/edit/glob/grep/read_image）+ capability section + jobs controller
- **清理**：domain/changed 监听 workspace 删除 → 删 placeholder

### 我们的适配（无 UI 约束下的等价实现）
- **`src/workspace.ts`（新）**：router 纯函数（remoteRoot/encode/decode/map 双向/routeByCwd/resolveRemotePath 重锚定）+ createPlaceholderDir（写 manifest `.dsh-remote-workspace.json`）+ listPlaceholders + readManifest；fsImpl/env 可注入
- **`SshRuntime.getConnectionFor(alias)`（新）**：按主机取句柄不切换 activeAlias（engine 连接池共享）；`engine.homeOf(alias)` per-alias home 同步读（wrap home 不再用 status()——多主机下会串）
- **fs-ssh/subprocess-ssh 锚定层**：cwd 落 placeholder root → 锚定该 hostId（isolate realm 每会话一个适配器实例 → 会话内所有操作落同一主机）；相对路径基准 = 远程工作区路径；普通远程 cwd 旧行为保留；fs-ssh resolve/lstat 用 sessionFor（resolveRemotePath 重锚定绝对占位路径）
- **`ssh_workspace` 工具（新）**：action=create（host+远程绝对路径 → 建占位目录+manifest+主动连接验证 → 返回本地路径+指引）| list（列全部绑定）——补上 dsh-ssh 靠 client UI 做的「浏览远端选目录」
- **persona 重写**：PRIMARY RULE——工作区在 ~/.dsh/remote/ 下 = 已连接该主机目录，直接干活别再问；否则 ssh_list 选主机 / ssh_workspace 建绑定

### 用户操作流（对标 dsh-ssh 的 30 秒上手）
1. 新会话（本地工作区）→「连接 web-1，把 /srv/my-app 设为工作区」→ agent 调 ssh_workspace
2. agent 返回本地占位路径 → 用户在 DSH「选择工作区」选它（或新会话用）
3. 之后的会话 cwd 在占位目录下 → 全部工具自动落远程目录，零额外操作

### 验证
- typecheck ✓ / 69 测试 ✓（workspace 17 新用例）/ build ✓（17 文件）；preset 已同步 ~/.dsh/.agent-presets/remote/；4500 重启后插件树加载成功

### 踩坑（新增）
- **同文件并行 Edit 相互覆盖再犯**：tools.ts 两个 Edit 同消息发出，前一个被吞 → 同文件修改必须串行（M2 已踩过，重犯）
- **StopCommand 只杀包装进程**：dsh web 的 node 子进程残留占 4500（EADDRINUSE）→ 用 Get-NetTCPConnection 找 OwningProcess 再 Stop-Process

## 2026-08-28 生态追赶行动（本日早些时候）

### 生态调研结论（竞品压力）
- 上游 DSH：12,940 commits（极活跃），npm 最新稳定 **0.1.1-rc.2**（0.1.2-alpha.1 存在但不用）；**0.1.2-alpha.1 修复了「profile 配置的预设根目录启动时丢失」——当年 preset 未显示问题的根因方向**
- SSH 远程开发赛道 15 天内涌入 **13+ 竞品**：dsh-ssh/dsh-ssh（组织运营，工具层遮蔽路由——agent/created 钩子注册同名工具遮蔽官方）、CrazyShout/dsh-ssh-remote（服务层 monkey-patch ctx.fs/subprocess + 系统 OpenSSH 跑命令）、flymysql/dsh-remote（rw_* 私有工具 + SFTP 本地镜像 + 三向同步）
- **三家竞品都不需要专用 preset**（透明路由/monkey-patch）；我们的 preset-scoped isolate realm 是差异化，但也意味着普通模式无远程能力
- 我们的护城河：官方 e2b 式 capability seam 替换（ctx.fs/ctx.subprocess 透明）+ ProxyJump 连接池 + 52 单元测试

### 本日落地（commit 3b6e86c，已推送）
1. **依赖升级**：peerDeps/devDeps `^0.1.0-rc.6` → `^0.1.1-rc.2`；typecheck/52 测试/build 全绿一次通过（adapter 契约无破坏）
   - ⚠️ semver 坑：`^0.1.0-rc.6` 不匹配 `0.1.1-rc.x`（prerelease 范围只含同 [major.minor.patch]），必须随上游 minor 升级同步改
2. **旧文件清理**：删 4 个死 UI 脚本（gen-xterm-css/replace-emoji/theme-tokens/build-css）+ 4 份已整合进方案书的调研报告（docs 01/02/04/05）+ 冗余 `.research/dsh-source.tar.gz`
3. **文档同步**：AGENTS.md（当前状态/下一步/rc.6 引用清理）、docs/README.md（新索引 + 竞品生态节）
4. **GitHub 元数据**：仓库描述更新（ctx.ssh/ctx.fs/ctx.subprocess adapters + remote preset）+ `dsh-plugin` topic 确认在列（gh CLI 可用，`gh repo edit`）
5. **本地 .research 源码实为 rc.5**——比旧依赖还旧一版，契约裁决以 npm 0.1.1-rc.2 的 d.ts 为准

### 待办（需用户参与）
- **npm publish**：未登录（ENEEDAUTH）→ 用户跑 `npm adduser` 后执行 `pnpm publish`（或 npm publish，prepublishOnly 会 build）
- **M4 真实验收**：4500 新会话选「服务器开发」→ 远程 bash/PTY/写文件（不可重启承载会话的 4500 实例）
- 社区展示：DSH 官方 Discussions「Show Your Plugins!」发帖（竞品模板见 discussion #2428 / #2666）
- 远期架构评估：是否借鉴 dsh-ssh 的「agent/created 工具遮蔽」做到无需 preset（扩大适用面）

## 架构概览（快速恢复上下文）

**项目定位**：DeepSeek Harness（DSH）的「服务器开发模式」——让 DSH 编码 agent 以远程 Linux 服务器为开发环境。纯 host 插件（无 UI），与 `remote` agent preset 配合完成闭环。

**三层架构（对齐官方 e2b 式范式）**：

| 层 | 模块 | 职责 | 作用域 |
|----|------|------|--------|
| Host 全局 | `src/index.ts` · `src/ssh-service.ts` · `src/engine.ts` | SshRuntime (ctx.ssh) + 连接池 + 5 个 ssh_* 工具 | 所有会话 |
| 远程能力适配 | `src/fs-ssh.ts` | SshFileSystem → ctx.fs 13 方法 | 仅 preset 会话 |
| 远程能力适配 | `src/subprocess-ssh.ts` | SshSubprocessRuntime → ctx.subprocess exec/PTY | 仅 preset 会话 |

**源文件清单**（10 个 .ts）：
- `src/index.ts` — 插件入口：apply async，注册 SshRuntime + 5 工具 + settings + systemPrompt
- `src/ssh-service.ts` — SshRuntime extends Service（ctx.ssh，惰性连接，单会话单目标，broken 重建）
- `src/engine.ts` — ssh2 引擎（连接池/ProxyJump/exec/SFTP CRUD/PTY，661 行）
- `src/fs-ssh.ts` — SshFileSystem extends FileSystem（13 抽象方法 + withLock + writeAtomic）
- `src/subprocess-ssh.ts` — SshSubprocessRuntime extends SubprocessRuntime（spawn/spawnTerminal/resolveExecutable，1426 行）
- `src/tools.ts` — defineTool × 5（ssh_list/ssh_exec/ssh_ls/ssh_read/ssh_write）
- `src/store.ts` — 主机配置（~/.dsh/dsh-remote-ide.json，0600，~/.ssh/config 导入）
- `src/protocol.ts` — 共享类型
- `src/invariant.ts` — 不变量

**preset**：`agent-presets/remote/`（preset.yml + agent.cordis.yml）；agent.cordis.yml = persona + remote-caps isolate group（fs: true, subprocess: true, terminals: true）

**构建/测试**：`pnpm build`（tsc 声明 + tsdown 产物 16 文件）/ `pnpm typecheck` ✓ / `pnpm test`（52/52）✓

## 里程碑状态总览

| 里程碑 | 内容 | 状态 | 日期 | Commit |
|--------|------|------|------|--------|
| M0 | SshRuntime extends Service（ctx.ssh，连接池，broken 重建，6 用例） | ✅ | 2026-08-16 | — |
| M1 | fs-ssh（ctx.fs 13 方法远程适配，20 用例） | ✅ | 2026-08-16 | `404de66` |
| M2 | subprocess-ssh（ctx.subprocess exec/PTY，13 用例） | ✅ | 2026-08-16 | `404de66` |
| M3 | preset 组合（isolate realm + persona + host 接线，4 文件） | ✅ | 2026-08-18 | `01bcfd9` |
| M4 | 真实 Linux 服务器端到端验收 | ⏳ 待验证 | — | — |

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

## 方案书 v0.2 + 开源调研（2026-08-15 晚）

- **方案定稿**：`docs/03-方案书-服务器开发Agent模式.md` v0.2——用户拍板**直接方案 B（执行层）**：remote preset 在 isolate realm 自包含远程执行层（ssh-connection/ssh-fs/ssh-shell/ssh-terminal/tool-ssh-bash/tool-ssh-editor/persona），provider 替换 `ctx.shell`/`ctx.subprocess`/`ctx.fs`；对话界面不变
- **决策全记录**（用户确认）：连接=首次对话输入（贴 `ssh user@host` 或 agent 分项询问，都支持）；工具边界=纯远程；验证=真实 Linux 服务器；终端=持久 PTY；编辑器=str_replace；cwd=默认+可指定
- **开源调研归档**：`docs/04-调研报告-开源远程开发方案对比.md`——四条路线：① 服务端部署型（Trae/Cursor Remote-SSH，需远程装服务端，仅借鉴连接交互）；② **执行后端替换型（DSH e2b、OpenHands RemoteSandboxService）★ 与方案 B 同构，双份官方先例**；③ 工具拦截+Mutagen 同步（claude-remote 家族，有同步坑，不采用）；④ 单命令转发（反例）
- **里程碑**：M0=解决 preset 显示遗留问题（前置阻塞）→ M1 fs → M2 shell → M3 持久终端 → M4 编辑器 → M5 真实服务器验收
- **下一步**：等用户审阅方案书 → 进入 M0（排查 preset 未显示）

## M0 前置调研完成（2026-08-15，读官方 e2b + 盘点引擎资产）

### 官方 E2BRuntime 连接生命周期设计（packages/e2b/e2b/src/index.ts，ctx.e2b 范本）
- **Service 形态**：`E2BRuntime extends Service`，`super(ctx, 'e2b')` 注册；`declare module '@deepseek-ai/cordis' { interface Context { e2b: E2BRuntime } }` 类型合并
- **Config**：`static Config: z<Config> = z.object({...})`（Schemastery）
- **构造即启动**：`this.ready = this.open()` + `void this.ready.catch(() => {})`——eager 初始化，失败可观察（getSandbox 仍返回错误）
- **handle 获取双检查**：`getSandbox()` 在 await ready **前后**各检查一次 `disposed`（await 让出事件循环，dispose 可能插入）
- **teardown 用 ctx.effect**：disposed=true → await ready → kill；`SandboxNotFoundError` 视为 quiescence（他人已删），其余错误向上抛
- **open() 顺序**：创建 → 建 cwd + runtimeRoot → 验证 runtimeRoot 是真目录（非 symlink）→ chmod 700 → 失败 rollback(kill)
- **runtimeRoot** = `cwd/.dsh-e2b`：adapter 私有状态目录（进程组/终端状态）
- **环境隔离**：`e2bControlEnvs()` 随机 HOME（`/.dsh-e2b-control-${randomUUID()}`）防 login shell 读用户 profile
- **shell 参数转义**：`quoteE2BShellArg()`（单引号 + `'"'"'`）防 `/bin/bash -l -c` 插值
- **adapter 注入**（fs-e2b）：`E2BFileSystem extends FileSystem`（官方抽象类）+ `static inject = ['e2b']`，消费 `this.ctx.e2b.getSandbox()`；每次操作先 assertNotAborted，错误统一 mapError 到 FS_* 码，控制命令统一带随机 HOME envs

### 我们 engine.ts 资产盘点（SshEngine，src/engine.ts 661 行）
- **已有**：per-alias 连接池（Map\<PoolRecord\>）、ProxyJump（connectHops）、exec（超时/截断/代理对安全）、PTY shell（openShell）、SFTP 懒加载（getSftp + ls/readFile/writeFile/mkdir/remove/rename）、sweep 空闲回收、dispose
- **差距**：① 普通类非 Cordis Service（无 ctx.effect teardown/Config/ready 模式）；② per-alias 多连接 vs 方案 B「单会话单远程世界」语义；③ broken 连接不自动重建（ensureConnection 只查标记）；④ client 'error' 监听在 connectClient 有全局空监听（防进程崩溃，好习惯）

### M0 骨架设计（SshRuntime extends Service，ctx.\<ssh\>）
- 包装/重构 SshEngine → `src/ssh-service.ts`；`super(ctx, 'ssh')`
- 惰性连接（与 e2b 不同：SSH 连接目标由会话首轮用户输入决定，不能构造即连）→ 提供 `connect(spec)` 建立 ready；provider 经 `getConnection()`（类比 getSandbox，双检查 disposed）
- 复用 engine.ts 全部资产；补齐 broken 自动重建、ctx.effect teardown、Config schema
- 参照 e2b 测试模式：vi.mock ssh2 Client + fakeConnection fixture（vitest）

### 下一步
- 用户确认骨架设计 → 写 `src/ssh-service.ts` 类型骨架（typecheck 通过）→ M1（fs-ssh）

## M0 框架先行产物落地（2026-08-16，src/ssh-service.ts）

- **SshRuntime extends Service 已实现**（`src/ssh-service.ts`，注册名 `ctx.<ssh>`）：完全复刻官方 E2BRuntime 模式
  - `static Config: z<Config>`（引擎旋钮 + storeFile）；`declare module` 类型合并
  - **惰性连接**：SSH 目标由会话首轮模型决策决定 → `connect(alias)` 建立 ready（与 e2b 构造即连的差异）
  - **单会话单目标**：`getConnection()` 返回隐藏 alias 的稳定句柄 `SshConnection`（exec/openShell/ls/readFile/writeFile/mkdir/remove/rename + alias/home getter），消费者看不到 alias
  - **getConnection 双检查 disposed** + **broken 自动重建**（`ready === undefined || engine.isBroken(activeAlias)` → 重开）
  - **teardown**：ctx.effect → disposed=true → await ready → engine.dispose()
  - host store 透传：listHosts/getHost/upsertHost/removeHost/importSshConfig
- **engine.ts 新增两个公开方法**：`isBroken(alias)`（重建判定）、`resolveHome(alias)`（home 懒解析，重建后复用）
- **测试落地**（`tests/ssh-service.test.ts`，参照 e2b.spec.ts 的 vi.mock('ssh2') + FakeClient 模式）：6 用例全过——初始无连接拒绝/connect 建立+句柄复用同一引用+单一底层连接/dispose 后拒绝（竞态）/broken 自动重建（instances 1→2）/未知主机 failed/切换目标。`pnpm typecheck` + `pnpm test`（19 全过）+ `pnpm build` 均通过
- **踩坑**：本地 npm schemastery 3.x 无 `.optional()`（官方用 @deepseek-ai/schemastery 有）→ 沿用官方惯例 `z.string().default('')` 表达缺省
- **遗留**：broken 重建成功后 engine state 仍 'failed'（state 只在 engine.connect 更新）——M1 统一状态语义时处理；ssh-service.ts 尚未接入 src/index.ts（tsdown entry 不含它），M1/M2 接入
- **下一步 M1（fs-ssh）**：前置调研 fs-e2b 剩余部分（120-582 行）+ `@deepseek-ai/dsh-fs` 抽象类完整 13 方法签名 + fs-local 实现参考 → 定 fs-ssh 类型骨架

## M1（fs-ssh）完成（2026-08-16，框架先行 + 接线）

### 前置调研结论（定案）
- **以已发布 d.ts 为准**：npm `@deepseek-ai/dsh-fs@0.1.0-rc.6` 的 writeText/editText 是 **5 参**（含可选 `sandboxPolicy?: SandboxExecutionPolicy`），`.research/` 下 fs-e2b 源码是 4 参 → fs-ssh 按 5 参接收、SSH 是 bare backend 忽略该参数
- **官方 fs-e2b adapter 范式**：`extends FileSystem` + `static inject = ['ssh']`；每操作 `await this.ctx.ssh.getConnection()`；`mapError` 统一映射 6 个 FsErrorCode；`withLock`（尾 promise FIFO）串行化读→守→写窗口；`writeAtomic`（staging 目录 chmod 700 + `ln -T` 守卫 / rename）；`canonicalPath` 用 `realpath -mz | base64 -w0`；`entryVersion` 从 metadata/type/size/mode/mtime/symlinkTarget 哈希
- **ctx.fs 填充机制**：`FileSystem extends Service`（dsh-fs 的 cordis 类型合并 `ctx.fs: FileSystem`），**装载插件即填充 ctx.fs**（fs-local README 同义）

### 产物
- **`src/fs-ssh.ts`（SshFileSystem 完整实现）**：13 个抽象方法 + withLock + writeAtomic + canonicalPath + probe + requireRegular + checkWriteIntent + readForDiff/readForEdit + mapError + sftpCall/sftpCallVoid + entryVersion + literalEdit；顶部 8 个工具函数（decodeText 含 NUL+UTF-8 fatal、decodeCanonicalPath base64+NUL 帧、quotePosixArg、restoreLineEndings 等）
  - **SSH 适配差异**：resolve 基准目录用连接句柄 home（动态）；createIfAbsent 提交后先 `unlink(temporary)` 再 `rmdir(stagingDirectory)`（e2b remove 递归，ssh rmdir 只删空目录）；readBytes 双保险（stat 预检 + 事后 size 校验）；sandboxPolicy 契约接收但忽略
- **`tests/fs-ssh.test.ts`（20 用例全过）**：vi.mock('ssh2') + 内存 FakeSftp（nodes/symlinks Map + 单调节拍 mtime）+ FakeExec 脚本分发（$HOME/realpath/chmod/ln 守卫精确匹配）——覆盖全部 13 方法 + 全部 FsErrorCode 分支 + 并发写串行化 + 未连接 FS_IO_ERROR
- **接线（预设作用域，非全局）**：tsdown entry 增 `ssh-service`/`fs-ssh`；package.json exports 增 `./ssh-service`/`./fs-ssh` + peerDeps 补 `@deepseek-ai/dsh-fs`；**agent.cordis.yml 增两行挂载**（ssh-service 先行，fs-ssh 后行因 inject ['ssh']）→ 仅「服务器开发」会话 ctx.fs 变远程，普通会话保持本地 fs
- **`src/engine.ts`/`src/ssh-service.ts`**：`getSftp` 改 public；`SshConnection` 增 `getSftp()` 句柄（对应 e2b 的 sandbox.files）

### 验证
- `pnpm typecheck` ✓ / `pnpm test`（39/39）✓ / `pnpm build` ✓（12 文件，含 fs-ssh.js 22KB、ssh-service.js 5.9KB）

### 踩坑
- **sftpCall 回调签名**：ssh2 `Callback` 是 `(err: Error | null | undefined) => void`，写 `(error?: Error) => void` 逆变不兼容 → 统一用 `Error | null | undefined`
- **FakeSftp mtime 同毫秒碰撞**：`Date.now()` 导致两次快速写入 version 相同 → replaceIfVersion 守卫失效 → 改单调递增 tick
- **测试 bug**：`fs.stat(stale)` 是实时查询永远等于当前版本 → 应先记录 v1 后版本再写 v2 再断言 FS_STALE_VERSION
- **resolve 错误包装**：`getConnection()` 抛普通 Error 未过 mapError → 移入 try 块统一包装 FS_IO_ERROR
- **TRAE 沙箱**：`shellSandbox.enable=false`（用户又设了「完全访问」）后 pnpm 安装畅通

### 遗留 → M2/M3
- M2：subprocess-ssh（3 方法 resolveExecutable/spawn/spawnTerminal，前置调研 subprocess-e2b 全部源码）
- M3：preset 组合完善（isolate realm + persona 细节）→ 复制 `agent-presets/remote/` 到 `~/.dsh/.agent-presets/remote/`
- M4：真实 Linux 服务器验收（agent 远程读写文件成功）
- M0 遗留①：broken 重建成功后 engine state 仍 'failed'

## M2（subprocess-ssh）完成（2026-08-16，wrapper 协议 + 测试全绿 + 接线）

### 设计定案（对比 subprocess-e2b 逐行）
- **传输层替换**：E2B SDK 命令流 → `SshExecChannel`（ssh2 Channel 实时 Buffer 流，stderr 走 extended-data 天然分离）；退出码无需 status 文件，channel close 事件直接携带 (exitCode, signal)
- **远端 wrapper 只依赖 bash/coreutils**（不依赖远端 node，与 e2b 的 node 编码器不同）：`env -i` 重放 scrubbed 远程环境 + `setsid --wait` 起独立会话组长 + pid 文件发布 pgid（SFTP 轮询等待）
- **远程 state 目录**：`/tmp/dsh-ssh-processes/<uuid>`（pid/environment 文件），不依赖远程 $HOME 解析时序
- **输出 spill 本地化**：host 已收到全部字节 → 有界 tail（maxBytes）+ 本地临时 spill 文件（超 maxBytes 时保留全文路径供 lossy 消费者）
- **PTY 终端**：openShell 注入 `printf marker; printf '%s\n' "$$" > pid; exec <argv>`，BootstrapOutputFilter 过滤到 marker 为止；会话级清理（ps 解析 sid → TERM → KILL 升级 → shell.close → rm -rf stateDir）
- **环境传输**：`getent passwd` 取 home + `env -0 | base64 -w0` 防 SSH 通道 chunk 破坏 UTF-8；scrub DSH_*/敏感名；spec.env 经 wrapper `env -i` 重放（undefined = tombstone 删除）
- **安全护栏**：pgid/sid 拒绝 <=1（防 `kill -- -1` 全体）；SIGKILL 拒绝自杀式（前台组=shell 自身时）；resolveExecutable 拒绝相对路径（SSH 无共享 cwd）

### 产物与验证
- `src/subprocess-ssh.ts`（1426 行）：SshSubprocessRuntime extends SubprocessRuntime（static inject=['ssh']）+ SshSubprocessHandle + SshTerminalHandle + SshOutputReader/DeferredStdin/BootstrapOutputFilter；engine 增 `execChannel` 低层流式句柄 + openShell 注入支持
- `tests/subprocess-ssh.test.ts`（13 用例全过）：resolveExecutable 3 + spawn 校验 2 + spawn 主流程 5（输出收集/非零码/stderr 分离/spill/TERM 组杀/abort 未发布回滚）+ spawnTerminal 3（marker 边界/会话清理/inspectForeground+自杀式拒绝）
- 接线：tsdown entry + package.json exports `./subprocess-ssh` + peerDeps 补 `@deepseek-ai/dsh-subprocess`（external 同步）+ agent.cordis.yml 挂载 `dsh-remote-ide/subprocess-ssh`（fs-ssh 之后）→ 已复制到 `~/.dsh/.agent-presets/remote/`（热发现）
- `pnpm typecheck` ✓ / `pnpm test`（52/52）✓ / `pnpm build` ✓（16 文件，subprocess-ssh.js 44KB）

### 踩坑（重要）
- **JS 字符串 `\n` 是换行不是字面 `\\n`**：注入命令 `printf '%s\n'` 若写 `'\n'` 会把真实换行塞进命令文本 → 必须写 `'\\n'` 让远端 shell 收到标准转义（marker 行残留换行、pid 正则错乱均由此引起）
- **BootstrapOutputFilter 要吞 marker 行自身换行**（marker 后的首个 0x0a），否则消费者看到私有 marker 行残留
- **并行 Edit 同一文件会相互覆盖**：多个 Edit 同一消息发往同一文件时部分修改丢失（本次 waitForChannel getter 与吞换行逻辑丢失，重跑测试才发现）→ 同文件修改必须串行
- **测试断言注意 quoteShellArg 双重转义**：execCalls 里的原始命令是 `exec bash -c 'PATH='\''/opt/bin'\'' ...'`，字符串匹配用 `includes('command -v') && includes('custom-tool')` 而非精确子串
- **异步 push 竞态**：collect 输出 push 是 async（写 spill），close 事件可能先到 → 测试需 `vi.waitFor(() => expect(collected.size).toBe(N))` 再 close
- **waitForChannel 返回 closed 要用 getter**（`get closed() { return stream.destroyed }`），快照在 close 前为 false

### 下一步 M3
- preset 组合完善（isolate realm + persona 细节）→ M4 真实 Linux 服务器验收（agent 远程跑 bash/PTY/写文件）

## M3（preset 组合：isolate realm + persona）完成（2026-08-18）

### 调研结论（定案，源码级验证）
- **isolate 机制**（vendor/loader/src/config/isolate.ts + vendor/cordis/src/reflect.ts）：
  - `isolate: { label: true }` → **LocalRealm**（`Symbol(name#entryId)`，每 entry 私有）；字符串 label → GlobalRealm（同 label 共享）。**isolate 配置写在 group 行上**，子行 entry.ctx 经 `setPrototypeOf` 重接到 group ctx → 整组子行沿原型链共享 group 行的 realm symbol
  - 服务 provide 时用 `ctx[Context.isolate][name]` 取 realm symbol 做 store key（`reflect.ts:287-292`）；属性访问沿 fiber 链上溯，每步检查父 ctx 的 realm symbol 相同（`fiber.parent[isolate][prop] !== key` 停止）
  - **跨子行服务解析**靠装载期注入快照（fiber._checkImpl → 全局 store 按同 realm symbol 命中）
- **官方先例（minimal preset）**：`isolate: { fs: true }` group 里同放 `fs-local`（provide 'fs'）+ `str-replace-editor`（消费 ctx.fs）——「隔离重定向 fs」的标准范式，remote preset 直接复刻
- **工具注册分层**（packages/core/tools + dsh-scope）：scope key 存 ctx 的 `[kScope]` own property，**沿原型链传播**（extend=Object.create）→ group 内工具行仍注册进 standing layer，agent 可见；executor 闭包捕获的 ctx（组内 ctx）决定 ctx.fs/ctx.subprocess 解析 → 命中组内 isolate 服务
- **官方工具依赖表**（决定 remote preset 组合内容）：tool-fs inject `['tools','fs','systemPrompt']`（解析 ctx.fs）；tool-fs-search inject `['tools','systemPrompt','subprocess']`（解析 ctx.subprocess.spawn，**刻意不含 fs**）；terminal-bash inject `['terminals','sandboxPolicy','subprocess']`（**spawnTerminal 走 ctx.subprocess** → 远程 PTY 可行）；**tool-bash 需 ctx.shell（无远程实现）→ 不放**

### 产物（4 文件）
- **`src/index.ts`**：apply 改 async——`await ctx.plugin(SshRuntime, {...})` 替代自建 engine（**host plane 共享连接所有者**，removed 重复 engine dispose effect）；5 个 ssh_* 工具改收 `ctx.ssh`
- **`src/ssh-service.ts`**：私有字段 `engine_` + 公开 `get engine()`（工具消费连接池/exec/SFTP 全量能力；适配器仍走 getConnection 单目标语义，二者共享同一引擎）
- **`src/tools.ts`**：5 工厂签名 `(engine: SshEngine)` → `(runtime: SshRuntime)`，execute 里 `runtime.engine`；resolveAlias 收 runtime
- **`agent-presets/remote/agent.cordis.yml`**：重写——
  - persona 完善（`{{model}}` 模板 + 远程工具说明 + 标准工具重定向说明 + 首步建连指引）
  - **`remote-caps` isolate group**（`isolate: { fs: true, subprocess: true, terminals: true }`）：fs-ssh + subprocess-ssh + tool-fs + tool-fs-search + str-replace-editor + pty + terminal-bash
  - **ssh-service 移出 preset**（host 提供，preset 不再挂 → 无 leakedServices、无双引擎）；tool-bash 故意不放（ctx.shell 无远程实现）
  - 头部注释完整说明连接关系（host tools + preset adapters + isolate realm 语义）

### 验证
- `pnpm typecheck` ✓ / `pnpm test`（52/52）✓ / `pnpm build` ✓；已同步 `~/.dsh/.agent-presets/remote/agent.cordis.yml`（热发现）
- git 提交：`feat: remote preset isolate realm — shared SshRuntime + SSH-backed tools`（4 文件）

### 关键决策
- **连接所有权收敛 host plane**：ssh_* 工具与 fs-ssh/subprocess-ssh 必须共享同一 SshRuntime（此前双引擎会连接状态不同步）
- **isolate label 用 true（LocalRealm）**：组内兄弟行共享 group 行 realm 即可，无需 GlobalRealm 字符串
- **注入出组沿 fiber 链解析**：`ssh`/`sandboxPolicy`/`systemPrompt`/`tools` 均 host 提供，组内可解析（不隔离这些 name）

### 下一步 M4
- 真实 Linux 服务器验收：4500 新会话选「服务器开发」→ agent 远程跑 bash/PTY/写文件；确认 preset 组合真实挂载不抛 leakedServices

## 方案书 v1.0 定稿 + 目录整理（2026-08-15）

- **完整方案书定稿**：`docs/03-方案书-服务器开发Agent模式.md` v1.0——整合全部调研（01-06）：需求/可行性论证（四重背书）/e2b 式三层技术方案（ctx.\<ssh\> + fs-ssh + subprocess-ssh + 官方消费者零改造）/接口契约（ctx.fs 13 方法 + ctx.subprocess 3 方法）/preset 蓝图/安全设计/交互/里程碑（M0-M4）/风险/开发规范
- **目录整理**：新增 `docs/README.md` 文档索引（方案书=唯一纲领，06=开发依据，01/02/04/05=支撑材料）；开发路线速览
- **开发宗旨确认**：先调研后开发——每个 M 阶段前置调研官方源码/文档 → 先定接口类型骨架（框架先行，typecheck 通过）→ 填充实现 → 验证
- **下一步**：进入 **M0**（引擎与连接池 ctx.\<ssh\>）：先读 `packages/e2b/e2b/` 源码 + engine.ts 现状，定连接池 API 类型骨架

## 方向调整 + 方案书 v0.3（2026-08-15 用户拍板）

- **用户指示**：① 遗留问题（preset 未显示）**忽略/删除**——用户用 DSH 自身开发时的问题（DSH 无法跳出自身开发自己、易崩溃），不排查不修复；② **聚焦 agent 能力开发**——一开始想做 IDE 小插件，**现在做大做这个**（完整的「服务器开发 Agent 模式」）
- **方案书升级 v0.3**（docs/03）：架构对齐官方 e2b 式三层 = `dsh-ssh`（ctx.\<ssh\> 连接池，类比 ctx.e2b）+ `fs-ssh`（ctx.fs 13 方法，替代 dsh-fs-local 位置）+ `subprocess-ssh`（ctx.subprocess 3 方法）+ **官方消费者零改造**（bash-local/terminal-bash/tool-fs/lsp-stdio 自动跟随远程）；**不实现 ctx.shell/ctx.sandbox**
- **里程碑重排**（M0→M4）：M0=引擎与连接池（ctx.\<ssh\>，复用 engine.ts）→ M1=fs-ssh → M2=subprocess-ssh（exec/PTY）→ M3=preset 组合完善 → M4=真实服务器验收
- **下一步**：从 M0 开始开发（连接池 ctx.\<ssh\> 服务）

## TDSF 项目群知识吸收（2026-08-15，docs/05）

- 调研对象：`D:\ai\linux教学一体`（TDSF-Linux 项目群：45+ 调研报告 + 8 份源码分析 + 18 个 clone 项目 + 复用清单）
- **同构背书**：OpenHands SandboxService 抽象 + Remote 实现（HTTP/X-API-Key/session_api_key）源码级验证「执行后端替换」路线；反衬 SSH 直连差异化（免远程服务端）
- **选型交叉验证**：TDSF 的 SSH 生态调研（ssh2/ssh2-sftp-client/webssh2/xterm.js/node-pty/Tabby/JumpServer/safeStorage）与 dsh-remote-ide 已用栈逐项吻合
- **机制灵感**：① 风险分级+人工确认断点（CapabilityMode 四档/高危命令确认/操作留痕）→ 建议方案书新增安全章节；② 证据可核验（ground_check）；③ 会话录制回放（JumpServer）；④ 命令片段库（远期）
- **纪律借鉴**：开源复用 4 级分级 + License 首行核实 + Borrowed from 注释（TDSF 复用清单方法论）
- 归档：`docs/05-调研报告-TDSF项目群知识吸收.md`；不引入 TDSF 任何代码依赖（知识层价值）

## DSH 开发方法论调研（2026-08-15，docs/06）

- 调研来源：官方文档站（develop/basic 三页已抓）+ 本地源码 docs/ 权威文档 + packages/e2b 官方远程先例 + cordis-api；两个 search 子代理深挖了 seam 契约与 preset 机制
- **核心发现 1（seam 替换）**：能力 seam 三件套 = Service Definition → Provider → Consumer；provider 每 context 单实例（加载第二个 throw）→ 替换 = 放 local 实现的位置。`docs/architecture.md` 明言"fs/subprocess 指向远程沙箱，Bash/PTY/LSP 全部跟随，无 provider fork"
- **核心发现 2（官方远程先例）**：e2b 家族 = `ctx.e2b`（共享沙箱生命周期）+ `fs-e2b`（ctx.fs）+ `subprocess-e2b`（ctx.subprocess）→ 方案 B 复刻此骨架；**ctx.sandbox 不需要实现**（远程执行是 whole-capability-seam 兄弟实现，非 sandbox provider）
- **接口清单**：ctx.fs 13 个抽象方法、ctx.subprocess 3 个（resolveExecutable/spawn/spawnTerminal）、ctx.terminals 注册表、ctx.shell（不用实现，bash-local 消费 subprocess）
- **工具开发契约**：defineTool（parameters 自动校验 + output.schema canonical value + render 纯投影 + exec.signal）；注册 effect 化；UI 卡纯函数（禁止 I/O/时钟/随机）；后台用 ctx.jobs.start
- **preset 机制**：agent.cordis.yml 必填（PRESET_ID 正则）；roots = 配置 roots + `$DSH_HOME/.agent-presets`（includeUserRoot 默认 true）；服务行必须 isolate realm（leakedServices 校验）；**roster 只做形状校验不解析包名 → 包名解析失败 ≠ 不显示**
- 归档：`docs/06-DSH插件开发方法论.md`（八章：定位/架构/技术栈/四步开发/seam 开发/preset 开发/工程实践/方案 B 映射）

### 环境（用户机器）
- web profile：`@liustack/modlens@3.16.6` + `dsh-remote-ide`（link: `C:\Users\Lenovo\dsh-remote-ide-dev` junction → 本仓库）
- dsh 实例：4500 端口（latest dsh，承载当前对话，**绝不可重启**）
- preset 已装：`~/.dsh/.agent-presets/remote/`（preset.yml + agent.cordis.yml 均在）

## ⚠️ 遗留问题（下一个 AI 的第一任务）

**「服务器开发」preset 未出现在 4500 的新会话模式选择器中**（用户确认"没了"）。

**✅ 已忽略（2026-08-15 用户指示）**：该问题是用户用 DSH 自身开发时遇到的（DSH 无法跳出自身开发自己、易崩溃）。**当前项目遗留问题删除/忽略，不排查不修复**。根因分析（docs/06 §6.4）仅作知识留存，不再跟进。

排查线索（历史，已废弃）：
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
