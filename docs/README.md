# docs/ 文档目录索引

> 项目：dsh-remote-ide —— DSH「服务器开发 Agent 模式」
> 更新：2026-08-15 · 当前开发阶段：M0（引擎与连接池）之前，待开工

## 文档层级

| 层级 | 文档 | 用途 |
|---|---|---|
| **方案书（唯一纲领）** | [03-方案书-服务器开发Agent模式.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/03-方案书-服务器开发Agent模式.md) | v1.0 完整定稿：需求/可行性/技术方案/里程碑/风险/规范；**开发从这里开始，M0-M4 按此推进** |
| **开发方法论（开发依据）** | [06-DSH插件开发方法论.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/06-DSH插件开发方法论.md) | 官方开发教程精华：seam 契约、接口签名、e2b 先例、preset 机制、工程实践与坑 |
| **调研报告（支撑材料）** | [01-调研报告-SSH-IDE插件.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/01-调研报告-SSH-IDE插件.md) · [02-调研报告-服务器开发Agent模式.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/02-调研报告-服务器开发Agent模式.md) · [04-调研报告-开源远程开发方案对比.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/04-调研报告-开源远程开发方案对比.md) · [05-调研报告-TDSF项目群知识吸收.md](file:///d:/ai/deepseek%20harness/linux%20ide/docs/05-调研报告-TDSF项目群知识吸收.md) | 各专项调研结论；已整合进方案书，按需查阅细节 |

## 开发路线速览（详见方案书 §六）

```
M0 引擎与连接池 ctx.<ssh>  →  M1 fs-ssh（ctx.fs 13 方法）  →  M2 subprocess-ssh（exec/PTY）
   →  M3 preset 组合完善  →  M4 真实 Linux 服务器验收
```

## 配套资产

| 资产 | 位置 |
|---|---|
| 本地 DSH 源码（契约最终裁决） | `.research/dsh-source/deepseek-harness-master/` |
| 项目记忆 | `memory/` |
| 交接文档 | 仓库根 `AGENTS.md` / `CLAUDE.md` |
