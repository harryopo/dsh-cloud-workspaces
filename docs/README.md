# docs/ 文档目录索引

> 项目：dsh-cloud-workspaces —— DSH「云端工作区」（免 preset 透明模式，曾用名 dsh-remote-ide）
> 更新：2026-09-30 · 当前阶段：功能完成（126/126 单测 + E2E 29/29），npm 0.3.0 待发

## 先读哪份

| 优先级 | 文档 | 用途 |
|---|---|---|
| **1（交接必读）** | 仓库根 `agents.md` / `CLAUDE.md` | 现行架构、命令、铁律、已知坑、当前状态 |
| **2（仓库知识库）** | [REPO-WIKI.md](REPO-WIKI.md) | 逐文件核验的全仓说明：架构、数据流、配置项、测试基建 |
| **3（设计依据）** | [06-DSH插件开发方法论.md](06-DSH插件开发方法论.md) | 官方开发教程精华：seam 契约、接口签名、e2b 先例、工程实践与坑 |
| **4（历史纲领）** | [03-方案书-服务器开发Agent模式.md](03-方案书-服务器开发Agent模式.md) | v1.0 定稿：需求/可行性/技术方案/里程碑。**其 preset 路线已于 08-30 下线**，结论以 agents.md 为准 |
| **5（已实现设计）** | [07-design-remote-jobs.md](07-design-remote-jobs.md) | 远程后台任务（ctx.jobs 生产者）设计 + 决策记录 + DoD |
| **发布** | [npm-publish.md](npm-publish.md) | 三步发布手册（唯一阻塞=令牌过期） |

> 其他：`REPO-WIKI.md` 是最完整的单文件知识库；`assets/social-preview.png` 与 `promo/` 是 GitHub 门面与推广成稿；
> `screenshots/` 是双语 README 用的真机截图；`superpowers/plans/` 是实施计划留档。
>
> 历史调研报告（01 SSH-IDE 插件 / 02 服务器开发模式 / 04 开源方案对比 / 05 TDSF 知识吸收）已于 2026-08-28 清理删除。

## 里程碑（实际完成情况）

```
✅ M0 引擎与连接池 ctx.ssh
   →  ✅ M1 fs-ssh / M2 subprocess-ssh（08-30 转为 legacy 参考，不再部署）
   →  ✅ M3 preset 组合（08-30 下线，让位给 agent/created 遮蔽工具）
   →  ✅ M4 真实 Linux 服务器验收（08-30，24/24 → 现 29/29）
   →  ✅ 免 preset 透明模式全链路（08-31，钩子 7 遮蔽工具）
   →  ✅ 安全加固（09-05，v0.2.2）+ 远程后台任务（09-18，v0.3.0）
   →  📦 npm 发布：0.2.1 已上线；0.3.0 待发（令牌）
```

## 竞品与生态（2026-08-28 调研）

- SSH 远程开发赛道已有 13+ 竞品（dsh-ssh/dsh-ssh、flymysql/dsh-remote、CrazyShout/dsh-ssh-remote 等）
- 我们的差异化：**全生态唯一的「官方工具透明重定向」**——agent 照旧调 `bash`/`read`/`edit`，调用落远程（竞品靠 SFTP 镜像同步或私有 `rw_*` 工具名，agent 非透明）；零远程安装（标准 sshd 即可）+ ProxyJump 连接池
- 上游 DSH 最新稳定版 `0.1.1-rc.2`（本插件已锁定；0.1.2-alpha.1 修复了 profile preset roots 启动丢失问题）

## 配套资产

| 资产 | 位置 |
|---|---|
| 本地 DSH 源码（rc.5，仅作历史参考；契约以 npm 0.1.1-rc.2 d.ts 为准） | `.research/dsh-source/deepseek-harness-master/` |
| 项目记忆 | `memory/`（`MEMORY.md` 为索引，进展在 `project_dsh_remote_ide.md` 顶部节） |
| 交接文档 | 仓库根 `agents.md` / `CLAUDE.md` |
