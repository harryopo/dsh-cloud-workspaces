# 踩坑记录与关键技术点 — dsh-remote-ide 开发

**Date**: 2026-08-15
**Category**: learnings
**Source**: error / discovery

## 踩坑（ERRORS）

1. **client bundle 必须用 `window.__ModuleLoader__.load({id, factory})` 闭包格式**（CJS + banner/footer/intro），平台模块（react 等）external，其余内联；否则报 "loaded without registering ... via __ModuleLoader__.load"
2. **tsdown 的 clean 会清掉 tsc 输出的 d.ts** → tsc `emitDeclarationOnly` 输出到 `lib/types`，tsdown `clean: false`，build 脚本统一先删 lib
3. **Windows WinNAT 保留端口段**（4035-4234、5357-5657 等）导致 `listen EACCES`——4101 就是坑；用 4500（安全）或 `--port 0`
4. **路径含空格时 `dsh plugin add link:...` 会被拆词**——用 junction 短路径（`C:\Users\Lenovo\dsh-remote-ide-dev`）
5. **pnpm-workspace.yaml 里 `- @liustack/modlens` 会被 YAML 解析器当 tag 报错**——@ 开头的值必须加引号
6. **modlens 在 rc.6 旧版 dsh 不加载**（boot entries 无它）——需用 `npx -y @deepseek-ai/dsh@latest web`；modlens 是"skill + DSH 插件"双形态，装插件用 `dsh plugin add @liustack/modlens`
7. **React 闭包循环**：useCallback 依赖 state 且内部 setState → effect 重跑 → 无限请求循环（RemoteExplorer.loadDir 就是，loading 移入 ref 修复）
8. **全树 MutationObserver 卡 UI**：聊天流渲染时每次 DOM 变更触发回调 → 用轻量轮询（挂载成功后停止）+ 根级 observer
9. **GLM-4V-Flash 返回不满足 modlens vision schema**（layout.regions 缺 type）——直接调 GLM API 可看图；modlens 官方推荐 gemini-api/anthropic
10. **modlens 在 Windows 找不到 claude**（spawn 不解析 .cmd）——claude-cli provider 在 Windows 不可用
11. **⚠️ 绝不要重启承载当前会话的 dsh web 实例**：4500 就是会话宿主，`Stop-Process` 它 = 中断自己（工具调用被记录但无结果，用户看到"崩溃"）。host 半改动需要重启时：① 让用户手动重启；② 或先完成所有代码工作后一次性请用户重启。这条已在 AGENTS.md 列为铁律。

## 技术要点（LEARNINGS）

- **DSH 插件 = 双面**：node half（exports "."）+ browser half（exports "./client"），挂载靠 `dsh.bundle.patch`（cordis.patch.yml）+ profile node_modules
- **外部插件不能注册 slots** → 侧边栏入口用 DOM 注入（MutationObserver 自愈/轮询）；中心列/右侧列用 frame grid 追加（镜像 shell 的 gridTemplateColumns）
- **官方 UI 标准是 conversation node**（`ctx.slots.inject('conversation.chat.node')` + `ctx.conversationEvents.register`），外部插件可用——M3 规划
- **Agent preset 机制**：`~/.dsh/agent-presets/<id>/`（preset.yml + agent.cordis.yml），热发现；agent 平面组装 persona/工具/提示词
- **主题**：`--dsw-*` design tokens（bg-base/module-platform/border-l1-l3/deepseek-500/green-500/red-500），明暗自适应
- **工具规范**：defineTool + output.schema + 纯函数 presentCall/presentResult；长任务 ctx.jobs.start
- **外部插件规范**：`./invariant` 子路径、可选服务 `ctx.get()`、注册皆 effect
- **开发实例**：源码 checkout（pnpm dsh web --port 4300）可随意重启；生产 4500 一键脚本 `scripts/start-dsh-web.ps1`
- **D-S 证据理论/审批闸门**（本地 TDSF 调研）——运维 IDE 差异化方向（M 系列规划）

---
