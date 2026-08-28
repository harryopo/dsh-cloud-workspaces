# docs/ 文档目录索引

> 项目：dsh-remote-ide —— DSH「服务器开发 Agent 模式」
> 更新：2026-08-28 · 当前开发阶段：M0-M3 完成，M4（真实服务器验收）待跑

## 文档层级

| 层级 | 文档 | 用途 |
|---|---|---|
| **方案书（唯一纲领）** | [03-方案书-服务器开发Agent模式.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/03-方案书-服务器开发Agent模式.md) | v1.0 完整定稿：需求/可行性/技术方案/里程碑/风险/规范；开发按此推进 |
| **开发方法论（开发依据）** | [06-DSH插件开发方法论.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/06-DSH插件开发方法论.md) | 官方开发教程精华：seam 契约、接口签名、e2b 先例、preset 机制、工程实践与坑 |

> 历史调研报告（01 SSH-IDE 插件 / 02 服务器开发模式 / 04 开源方案对比 / 05 TDSF 知识吸收）已于 2026-08-28 清理删除——全部结论已整合进方案书 03；旧 UI 路线的构建脚本（gen-xterm-css / replace-emoji / theme-tokens / build-css）同步删除。

## 开发路线速览（详见方案书 §六）

```
✅ M0 引擎与连接池 ctx.<ssh>  →  ✅ M1 fs-ssh（ctx.fs 13 方法）  →  ✅ M2 subprocess-ssh（exec/PTY）
   →  ✅ M3 preset 组合完善  →  ⏳ M4 真实 Linux 服务器验收  →  📦 npm 发布
```

## 竞品与生态（2026-08-28 调研）

- SSH 远程开发赛道已有 13+ 竞品（dsh-ssh/dsh-ssh、flymysql/dsh-remote、CrazyShout/dsh-ssh-remote 等）
- 我们的差异化：官方 e2b 式 capability seam 替换（ctx.fs/ctx.subprocess 透明重定向）+ isolate realm preset + ProxyJump 连接池 + 52 单元测试
- 上游 DSH 最新稳定版 `0.1.1-rc.2`（本插件已锁定；0.1.2-alpha.1 修复了 profile preset roots 启动丢失问题）

## 配套资产

| 资产 | 位置 |
|---|---|
| 本地 DSH 源码（rc.5，仅作历史参考；契约以 npm 0.1.1-rc.2 d.ts 为准） | `.research/dsh-source/deepseek-harness-master/` |
| 项目记忆 | `memory/` |
| 交接文档 | 仓库根 `AGENTS.md` / `CLAUDE.md` |
