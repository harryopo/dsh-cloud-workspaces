# DSH 0.2.x 迁移 + 工作区选择器「双栏工作台」— 设计

日期：2026-10-30 · 状态：已评审（用户拍板：只支持 0.2.x / 双栏 IA / 不改名）
依据：0.2.1-rc.5 包内 d.ts 逐行核对（见下「契约事实」），不引用二手文档。

## 目标

1. 插件在 DSH **0.2.1-rc.5** 上完整可用（当前基线 0.1.1-rc.2，两处硬破坏）。
2. 工作区选择器从「双 tab + 单列表」重构为**双栏工作台**：左栏来源（本机/最近/主机），右栏目录浏览。
3. 不改包名；仓库/README 定位文案改为「Remote Linux workspaces over SSH」。
4. 用户数据零迁移：主机仍在 `~/.dsh/dsh-remote-ide.json`（0600 + ACL）。

非目标：0.1.x 双版本兼容；端口转发；设置页自动表单渲染。

## 契约事实（0.2.1-rc.5，已核对）

| 项 | 0.1.1-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| `settingsNamespace` / `installSettingsSection` | 存在 | **删除**；设置由插件 `Config`（`.volatile()` 字段）派生，命名空间 = profile 条目 id |
| `JobHooks.readOutput?()` | 存在 | **删除**；`JobSpec.output`（同步 `read(from)`）或 `JobHandle.append(text, opts)` |
| `JobSpec.owner` | `Agent` | `SessionId`；可选 `toolCall` |
| `JobOutcome.output` | 存在 | 改名 `result?` |
| `ctx.workspaces`（client） | 存在 | **改名 `uiWorkspace`**（`pickDirectory/listDirectory/createDirectory`） |
| `@deepseek-ai/dsh-client-runtime` | 存在 | 包不存在（`dsh.client.inject` 需替换） |
| `directoryFlow` 槽位契约 | `{open,busy,onPicked,onCancel,onError}` | 逐字节相同 |
| `defineTool` / `presentCall/presentResult` | 一致 | 一致（presentation.d.ts 逐字节相同） |
| typert `ctx.remote.$mount` | 一致 | 一致 |
| workspaceRegistry `create(path,title?)` | 一致 | 一致 |

## Part A — 迁移

### A1 依赖与发布
- `peerDependencies`：全部 `@deepseek-ai/*` → `^0.2.1-rc.5`；`devDependencies` 固定 `0.2.1-rc.5`；`@deepseek-ai/cordis` → `^4.0.5`。
- 版本 **0.4.0**；CHANGELOG 注明 breaking：需 DSH ≥ 0.2.1-rc.5；0.3.0 保留供 0.1.x 固定安装。
- README/zh 顶部加一行兼容性说明。

### A2 设置面
- 删除 `src/host-settings.ts` 及 `src/index.ts` 中 `installSettingsSection`/`REMOTE_IDE_SETTINGS_NAMESPACE`。
- `enabled/maxReadBytes/announceToAgent` 直接由插件 `Config` 提供（`apply(ctx, config)` 的 config 即已解析值；不做 live 热更新——0.2 表单写入走 loader，插件重启生效）。
- 现有 settings.yaml 的 `dsh-remote-ide-hosts:` 段不再读取（0.2 不自动导入），保留文件不影响；store 仍为唯一权威。
- 删除 `typert`/client 对 host-settings 的消费；`listHosts/saveHost/deleteHost` 继续读写 store。

### A3 jobs 生产者（推模式）
`src/job-runner.ts`：
- `jobs.start({kind:'ssh', label:command, owner: agent.id, toolCall?})`
- `run(job)` 内保留现有 dd 增量泵（3s），成功读到新字节后 `job.append(text)`；移除 `readOutput`。
- `done` 解析为 `{status:'completed'|'killed'|'failed', detail?, result?}`（流式 job 不设 result）。
- 取消语义不变：TERM → 5s → KILL；孤儿检测不变。
- `JobView` 字段差异只影响 UI（官方），不改我们的读取面（我们只读 `jobId`）。

### A4 client 面
- `ctx.get('workspaces')` → `ctx.get('uiWorkspace')`；保留 `ctx.get('workspaces')` 兜底？**否**——只支持 0.2，直接新名。
- `package.json` `dsh.client.inject`: `@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-ui-workspace`。
- 删除对官方 `/invariant` 子路径的任何引用（0.2 无此导出）。
- settings 自定义卡片（`settings.section`）注册不变。

### A5 验证环境（不触碰运行中的 4500）
- 临时 prefix 安装：`npm i --prefix .tmp/dsh02 @deepseek-ai/dsh@0.2.1-rc.5`。
- 独立 `DSH_HOME=.tmp/dsh02-home`，`dsh web --port 4600`，插件以 link 装入该 profile。
- 单测：`pnpm test`（0.2 类型）；E2E：`node scripts/e2e-real-server.mjs wsl-e2e` 对 4600 实例；client 安全断言照跑。

## Part B — 选择器：双栏工作台

### B1 布局（ASCII）

```
┌─────────────────────────────┬────────────────────────────────────────┐
│ 工作区                       │  web-1 › srv › app        [路径 ✎] [⟳] │
│                             │────────────────────────────────────────│
│ 本机                         │  …/                                     │
│  ▸ 选择文件夹…                │  📁 src                                 │
│                             │  📁 dist                                │
│ 最近                         │  📁 node_modules                        │
│  web-1  /srv/app            │                                        │
│  db     /opt/pg             │  （空：这个文件夹是空的）                 │
│                             │                                        │
│ 主机                         │  [+ 新建文件夹]            [使用此目录] │
│  ● web-1  10.0.0.5          │                                        │
│  ● db     10.0.0.9          │                                        │
│  + 添加主机                  │                                        │
└─────────────────────────────┴────────────────────────────────────────┘
```

- 宽 880–980px，左栏固定 248px，右栏自适应；高度 min(72vh, 600px)。
- 打开即焦点进入对话框；Esc 关闭（busy/creating 时禁用）。

### B2 左栏（来源）
1. **本机**：单行按钮「选择文件夹…」→ 官方 `uiWorkspace.pickDirectory()`，成功即 `onPicked`。
2. **最近**：`placeholders`（已在 `refresh()` 加载）按最近使用排序（manifest mtime 已在数据里；无则保持后端顺序）。点击 = 直接 `onPicked(localPath)`（一步回到旧工作区），右侧显示该远端目录内容（hover 预览可选，不做）。
3. **主机**：紧凑列表，行内 `名称 + user@host`；点击 → 加载该主机的 `/`（若上次该主机浏览过目录则回该目录，模块级记忆）。
4. 「+ 添加主机」→ 右栏切换为内联 `HostForm`（复用现组件），保存后回列表并自动进入该主机。
5. 主机 > 6 台时显示搜索框（过滤名称/host）。

### B3 右栏（目录）
- 工具栏：面包屑（`/`、每段可点、当前段高亮）+ 「编辑路径」切换为输入框（Enter 直达，Esc 还原）+ 刷新按钮。
- 列表：`..`（非根时）+ 目录行（文件夹图标 + 名称）；单击进入；加载中骨架行；错误行内展示（含重试）。
- 空目录：居中提示「这个文件夹是空的」+ 次行「直接使用，或先新建一个文件夹。」
- 底部：新建文件夹（输入 + 回车/按钮）；主按钮「使用此目录」；创建中禁用并显示「正在创建工作区…」。
- 长路径：面包屑溢出中段省略（`web-1 › … › app`），title 含完整路径；主按钮文案不再拼接路径。

### B4 视觉与文案（frontend-design 落地）
- **颜色**：只用现有 `--dsw-alias-*`（bg-layer-1/2、border-l1/l2/l3、label-primary/secondary/tertiary、brand-primary、interactive-bg-hover、state-error-primary、state-success-primary）。不自创色值。
- **排版签名**：机器字符串（主机名、IP、绝对路径、面包屑）一律等宽字体 `ui-monospace, Consolas, monospace`；界面标签用宿主正文字体。路径与主机名左侧统一加 `›` 语义连接符。
- **选择态**：只用背景 `--dsw-alias-interactive-bg-hover` + 文本 `label-primary`，**禁止**左边条/整圈描边/外发光。
- **动效**：仅 120ms 背景过渡；`prefers-reduced-motion` 时关闭。
- **文案**（动作名贯穿全流程）：`选择文件夹…` / `使用此目录` / `新建文件夹` / `添加主机` / `正在创建工作区…`；空态与错误按 B3。

### B5 安全
- 远端返回的目录名/路径是不可信输入：只进 `children` 文本，零 `innerHTML`/`dangerouslySetInnerHTML`。
- 路径拼接用纯函数 `joinRemotePath(base, name)`；禁止字符串模板直接拼进命令（命令侧仍用 `quoteSh`）。
- 改完跑 `node scripts/verify-client-security.mjs`（29 项基线）。

### B6 组件拆分
`client/index.js` 单文件内拆函数组件（client 半是自包含 bundle，`require` 只映射 React，**不能拆文件导入**）：
- `WorkspacePicker`（壳：状态、数据加载、open/Esc）
- `SourceRail`（本机/最近/主机）
- `DirPane`（面包屑、编辑路径、列表、空/错/载入态、底栏）
- 内部纯函数：`splitPath(p)`、`joinRemotePath(base,name)`、`parentOf(p)`、`shortenMiddle(p,max)`——保持无副作用，由真机 UI 验收覆盖；host 侧的路径归一化已有 `workspace.ts` 单测，不在 client 重复造测试假象。

## 测试

- 单测：`tests/job-runner.test.ts` 改推模式（fake `job.append` 收字节、cancel 仍 killed、done 无 output）。
- client 安全脚本：零 HTML sink、命名空间声明不变。
- E2E（0.2 环境）：后台任务 4 检查 + 选择器创建占位工作区链路。
- 真机：4600 实例截图（亮/暗两套）目检双栏布局与空态；路径纯函数不单独报单测覆盖。

## 风险与回退

- 用户本机 4500 仍跑 0.1.1：升级 0.4.0 前必须升级 dsh 并重启（会中断会话，由用户执行）；否则保持 0.3.0。
- npm `latest` 指向 0.4.0 后，0.1.x 用户需显式 `@0.3.0`；CHANGELOG 写明。
- 设置页数据：旧 `dsh-remote-ide-hosts` 段遗留在 settings.yaml，不读取不删除。
