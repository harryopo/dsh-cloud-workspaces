# dsh-remote-ide

[![npm version](https://img.shields.io/npm/v/dsh-remote-ide.svg)](https://www.npmjs.com/package/dsh-remote-ide)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**DeepSeek Harness (DSH) 的 SSH 远程 IDE 插件** —— SSH 连接服务器后，整个 IDE 进入远程模式：资源管理器浏览的是**服务器**的文件目录，编辑器通过 **SFTP** 读写远程文件，终端就是 **SSH 终端**。服务器上无需安装任何 Agent，无需任何远程配置，只要有 SSH 即可。

> English: [README.md](README.md)

---

## 为什么需要它

DSH 是强大的编码 Agent，但它的 Web GUI 只能操作**本地**文件。当代码、数据或生产环境在远程服务器上时，你只能另开 SSH 窗口，或依赖各种同步工具。`dsh-remote-ide` 把整个 IDE 搬进 DSH：

```
┌─────────────────────────── dsh web GUI ───────────────────────────┐
│  侧边栏: [远程 IDE] → 中央面板                                      │
│  ┌──────────┬──────────────────────────────────────────────────┐  │
│  │  远程文件  │  编辑器标签栏 + CodeMirror 6（保存 = SFTP 写回）    │  │
│  │  树       │                                                  │  │
│  │  (SFTP)   ├──────────────────────────────────────────────────┤  │
│  │           │  xterm.js 终端（WebSocket → SSH PTY）             │  │
│  └──────────┴──────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
          │                          ↑
          └── dsh 宿主进程 ──────────┘  ssh2 连接池
```

## 功能特性

- **SSH 主机管理** —— 密码 / 私钥认证（支持 passphrase）、ProxyJump 跳板机、从 `~/.ssh/config` 一键导入、连接测试。凭据存于 `~/.dsh/dsh-remote-ide.json`（0600），密钥永不发送到浏览器。
- **远程文件资源管理器** —— 基于 SFTP 的懒加载目录树（子树缓存），支持刷新、内联重命名/删除、新建文件/文件夹。
- **远程编辑器** —— CodeMirror 6，支持 TS/JS/Python/JSON/HTML/CSS/SQL/XML/Markdown；打开文件经 SFTP 读取，**Ctrl/Cmd+S 直接保存回服务器**；二进制嗅探 + 2MB 读取上限保证安全。
- **远程终端** —— xterm.js + WebSocket 隧道 SSH PTY，支持自适应尺寸、防丢输入缓冲、背压处理。
- **Agent 工具（路线图）** —— 远程 read/write/exec 工具，让 DSH Agent 本身能操作已连接的服务器。
- **better-sidebar 集成** —— 安装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，自动在其工作台注册「远程 IDE」标签页（加法式；不装也能用独立面板）。
- **国际化** —— 中 / 英双语，跟随 DSH 语言。

## 安装

需要 DSH（rc.6+）且已初始化 `web` profile，Node ≥ 22。

```sh
dsh plugin --profile web add dsh-remote-ide
dsh web
```

安装后**重启 dsh web**（host 半变更），侧边栏出现「远程 IDE」入口。

### 源码安装（开发调试）

```sh
git clone https://github.com/<you>/dsh-remote-ide.git
cd dsh-remote-ide
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)     # Windows 可用 link:C:\path\to\repo
dsh web
```

## 快速开始

1. 从侧边栏打开「远程 IDE」面板。
2. **添加主机**（别名/地址/端口/用户/认证方式）—— 或点击「从 ~/.ssh/config 导入」。
3. 点击**连接**。资源管理器切换到服务器主目录。
4. 浏览、点开文件编辑，`Ctrl+S` 保存到服务器。
5. **+ 新终端** 在面板内打开 SSH shell。

## 工作原理

一个纯官方 SDK（`@deepseek-ai/dsh-*`）构建的双面 DSH 插件，零 DSH 源码改动：

- **Host 半**（`src/index.ts`，Node 进程）：`SshEngine`（ssh2 连接池、跳板机、exec、PTY shell、SFTP CRUD）、`/api/dsh-remote-ide/*` REST 路由族、`/api/dsh-remote-ide/terminal` WebSocket 升级。所有路由均有 loopback 信任围栏。
- **浏览器半**（`src/client/`，Web GUI）：主机管理、远程文件树、CodeMirror 编辑器、xterm 终端。侧边栏入口采用 DOM 注入 + MutationObserver 自愈（DSH shell 未开放插件槽位），沿袭 dsh-ssh 的做法。

```
宿主进程                         浏览器（dsh web GUI）
┌──────────────────────┐        ┌──────────────────────────────┐
│ SshEngine (ssh2)     │ REST/WS │ 侧边栏入口（DOM 注入）        │
│  ├─ 连接池            │◄───────►│ 远程 IDE 面板                │
│  ├─ exec / PTY shell │         │  ├─ 主机管理                 │
│  ├─ SFTP CRUD        │         │  ├─ 远程文件树               │
│  └─ 跳板机            │         │  ├─ CodeMirror 编辑器        │
│ store ~/.dsh/…json   │         │  └─ xterm 终端               │
└──────────────────────┘         └──────────────────────────────┘
```

### 安全说明

- 所有 API 路由**仅限本机回环**（127.0.0.1 / localhost + 同源校验）。dsh web 暴露到局域网时，远程执行面不会被暴露。
- 密码以明文存于用户目录 0600 权限文件（`~/.dsh/dsh-remote-ide.json`）——与 dsh-ssh 同一模型；建议优先使用密钥认证。
- 浏览器永远拿不到已存密钥（只返回脱敏摘要）。
- 远程文件读取上限 2MB；二进制文件拒绝并给出明确错误。

## 路线图

- [x] 主机管理 + ssh-config 导入
- [x] 远程资源管理器（SFTP 目录树）
- [x] 远程编辑器（CodeMirror + SFTP 读写）
- [x] 远程终端（WebSocket SSH PTY）
- [ ] Agent 工具（`remote_read` / `remote_write` / `remote_exec`）
- [ ] 远程 Git 面板（status / diff / commit 走 SSH）
- [ ] 文件搜索 + 带进度的上传/下载
- [ ] 端口转发隧道

## 致谢

本项目站在 DSH 插件生态的肩膀上：

- [dsh-ssh](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-ssh)（Apache-2.0）—— SSH 引擎架构、WebSocket 终端协议、DOM 注入模式均以此为基石。
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）—— 本地 IDE 工作台，本插件通过其服务 API 集成。
- [ssh2](https://github.com/mscdex/ssh2)（MIT）、[xterm.js](https://github.com/xtermjs/xterm.js)（MIT）、[CodeMirror](https://codemirror.net)（MIT）—— 底层库。

## 许可证

[Apache-2.0](LICENSE)
