# dsh-cloud-workspaces

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-100%20%E5%8D%95%E6%B5%8B%20%2B%2025%20E2E-brightgreen.svg)](#开发)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的云端工作区插件。**

在工作区选择器里选 **「云端 (SSH)」**，编码 Agent 就直接在你的 Linux 服务器上干活：`bash`、`read`、`write`、`edit`、`glob`、`grep` —— 内置工具全家桶 —— 全部经 SSH 透明执行。文件、搜索、编辑、终端，统统落在远程。

**服务器零安装。** 没有 vscode-server 式的远程组件、没有常驻进程、无需下载任何东西——一个标准 OpenSSH 服务端就是全部要求。

> English: [README.md](README.md)

---

## 为什么

DSH 的 Agent 跑在本地。当代码、数据或生产环境在远程 Linux 服务器上时，你只能另开 SSH 窗口，或折腾同步工具。同类远程方案首次连接要在服务器上下载几百 MB 的远程组件。`dsh-remote-ide` 走另一条路：一切都走**标准 SSH 通道**（exec / SFTP / PTY，基于 [ssh2](https://github.com/mscdex/ssh2)）——服务器上什么都不用装。

## 功能

### 云端工作区（主打）

- **双 tab 工作区选择器** —— 「本机」/「云端 (SSH)」两个 tab；云端工作区经 DSH 官方工作区注册表收养，在选择器里显示为 `主机 / 路径`。
- **工具集透明重定向** —— 会话 cwd 落在云端占位目录下时，插件把官方 `ctx.fs`（13 个文件方法）与 `ctx.subprocess` 换成 SSH 实现。本地会话完全不受影响；接缝按会话作用域替换。
- **官方 UI 的遮蔽工具** —— 会话级远程 `bash` / `read` / `write` / `edit` / `glob` / `grep` 只注册进该会话的 agent scope，并实现官方 `presentCall` / `presentResult` 渲染器——聊天里的工具行渲染成真正的终端卡 / 阅读卡，可展开、可复制、原生观感。

### SSH 设置卡片（DSH 设置 → SSH 连接）

- **主机管理** —— 显示名、主机、端口、用户；**密码认证**（支持 keyboard-interactive——PAM/Ubuntu 等只提供交互式认证的服务器也能连）或**私钥认证**（路径；ssh-agent 兜底）。
- **连接测试** —— 一键探测并显示延迟；已保存凭据在服务端补回（浏览器只见脱敏视图）。
- **远端目录浏览器** —— 浏览、**新建**、**删除**服务器文件夹；任意目录**一键绑定为云端工作区**。
- **ProxyJump** —— 跳板机链，逐跳凭据。

### Agent 工具

- `ssh_list` / `ssh_exec` / `ssh_ls` / `ssh_read` / `ssh_write` —— 任意会话里的显式远程操作（按 preset 作用域控制）。
- `ssh_workspace` —— 在对话里创建云端工作区绑定。

### 连接层

- ssh2 连接池：keepalive、断线检测、透明重建。
- 按主机延迟测试的 `test` 端点，设置卡与选择器共用。

### 安全

- 主机存于 DSH 设置命名空间；密码字段是**只写密文**——浏览器拿到的是脱敏视图，永远读不回凭据。
- 远程会话按作用域隔离：遮蔽工具只存在于绑定了云端工作区的会话中，本地工作区永不受影响。
- 远程读文件有上限；大文件流式读头部而非整读进内存。

## 安装

要求：DSH（web profile）、Node ≥ 22、可连通的 SSH 服务器。

### 从 npm

```sh
dsh plugin --profile web add dsh-remote-ide
```

### 从源码

```sh
git clone https://github.com/harryopo/dsh-cloud-workspaces.git
cd dsh-cloud-workspaces
pnpm install
pnpm build

# link 进 DSH web profile（Windows 路径含空格时用 junction）
dsh plugin --profile web add link:C:\path\to\dsh-remote-ide
```

安装或重新构建后需重启 `dsh web`（host 半加载在 Node 进程里）。

## 使用

1. **添加主机** —— 设置 → SSH 连接 → 「+ 添加主机」→ 填凭据 → 「测试」→ 保存。
2. **绑定云端工作区** —— 「添加工作区」→ **云端 (SSH)** tab → 选主机 → 浏览到项目目录 → 「使用此目录作为工作区」。
3. **在该工作区上开会话** —— Agent 从此完全跑在服务器上。对它说「运行 pwd，再看看当前目录有什么」，看 `bash` 在远程执行。
4. 或者显式驱动：`用 ssh_exec 在 web-1 上跑 docker ps`。

## 架构

```
DSH host 进程 (Node)
┌────────────────────────────────────────────────────────────┐
│  ctx.fs ────────► fs-ssh 适配器 ───────┐                    │
│  ctx.subprocess ► subprocess-ssh ──────┤   接缝按会话替换   │
│  遮蔽工具 ──────► 会话作用域 ───────────┘                    │
│                                          │                 │
│  SshEngine (ssh2) ◄──────────────────────┘                 │
│   ├─ 连接池 / keepalive / 断线重建                          │
│   ├─ exec · SFTP CRUD · PTY                                │
│   └─ ProxyJump 跳板                                        │
└──────────────┬─────────────────────────────────────────────┘
               │ SSH (exec / sftp / pty)  —— 仅此而已
        ┌──────▼──────┐
        │ Linux 服务器 │  原生 sshd。零远程安装。
        └─────────────┘

浏览器（dsh web GUI）：设置卡片 + 云端工作区选择器
经官方 Typert remote 桥与 host 通信。
```

- **Host 半**（`src/`，TypeScript）：`SshEngine`、`fs-ssh` / `subprocess-ssh` 适配器、会话工具注册、Typert remote 端点、设置 schema。
- **Client 半**（`client/`，纯 ESM React `createElement`）：经官方插槽（`settings.section`、`workspace.*`）注入设置卡与双 tab 选择器。无 JSX 构建步骤，只用 `--dsw-*` 设计 token。

## 开发

```sh
pnpm build        # tsc d.ts + tsdown 产物
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest —— 100 个单测
node scripts/e2e-real-server.mjs   # 25 个 E2E（真 SSH，WSL sshd 127.0.0.1:2223）
```

## 路线图

- [x] SSH 引擎：连接池、keepalive、断线重建、ProxyJump
- [x] 云端工作区：双 tab 选择器、占位目录、官方收养
- [x] `ctx.fs` / `ctx.subprocess` 透明重定向
- [x] 官方终端卡/阅读卡的遮蔽工具
- [x] 设置卡：主机、密码/密钥认证（keyboard-interactive）、连接测试、远端目录浏览器
- [ ] 远程后台任务（`ctx.jobs`）
- [ ] 远程搜索调优（服务器端 ripgrep 探测）
- [ ] SSH 隧道（本地端口转发）
- [ ] npm 首次发布（进行中）

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 宿主与官方插件 SDK（`@deepseek-ai/dsh-*`）；本插件仅基于官方 npm SDK 包构建。
- [dsh-ssh](https://github.com/dsh-ssh/dsh-ssh) (Apache-2.0) —— 设置卡 UI 与工作区占位设计参考。
- [ssh2](https://github.com/mscdex/ssh2) (MIT) —— SSH 传输层。

## 许可

[Apache-2.0](LICENSE)
