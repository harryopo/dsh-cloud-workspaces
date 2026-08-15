# 生态参考与关键资源

**Date**: 2026-08-15
**Category**: reference
**Source**: discovery

## 关键仓库/包

| 资源 | 用途 | License |
|------|------|---------|
| https://github.com/deepseek-ai/deepseek-harness | DSH 源码（本地：`.research/dsh-source/deepseek-harness-master`，tarball 方式拉取） | 开源 |
| https://github.com/harryopo/dsh-remote-ide | 本插件仓库（已开源） | Apache-2.0 |
| https://github.com/omdsh-dev/DSH-better-sidebar | IDE 工作台插件（665★，集成对象） | MIT |
| https://github.com/zhu1090093659/dsh-web-ui | 全家桶（右侧面板 aionui-panel 布局参考，`@linxin666/dsh-client-ui-aionui-panel`） | Apache-2.0 |
| https://github.com/liustack/modlens | 视觉插件（skill + DSH 插件双形态，`@liustack/modlens`，3.16.6） | — |
| https://deepseek-harness.github.io/deepseek-harness/develop/basic/ | 官方插件开发教程 | — |
| `D:\ai\linux教学一体` | 本地 TDSF 项目（russh SSH 实现、调研文档 docs/idea-to-dev-output/） | — |

## 关键路径

- 用户 preset：`~/.dsh/agent-presets/<id>/`
- 用户 skill：`~/.agents/skills/`（DSH 扫描 rank 500）
- profile：`~/.dsh/profiles/web/`（bundles 顺序：dsh-base → dsh-web-app → dsh-remote-ide → dsh-better-sidebar → @liustack/modlens）
- 主题 token：`@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`
- 一键启动：`scripts/start-dsh-web.ps1`（4500 端口，latest dsh）
- modlens 配置：`~/.modlens/config.json`（provider: openai=智谱 glm-4v-flash；可直接调 https://open.bigmodel.cn/api/paas/v4 看图）

## 服务器开发模式相关

- agent preset 参考：`apps/cli/config/agent-presets/standard/agent.cordis.yml`
- preset 发现：`packages/preset/agent-presets/src/discovery.ts`（用户根 = dshHome 下可写目录，类似 skills）
- 远程工具复用：dsh-remote-ide 的 engine.ts（exec/SFTP/PTY）+ tools（M3 规划 ssh_exec 等）

---
