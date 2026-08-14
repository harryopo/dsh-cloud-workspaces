# dsh-remote-ide

[![npm version](https://img.shields.io/npm/v/dsh-remote-ide.svg)](https://www.npmjs.com/package/dsh-remote-ide)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**SSH Remote IDE for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)** — connect to a server over SSH and the IDE goes remote: the file explorer browses the **server's** directory tree, the editor reads/writes files **over SFTP**, and the terminal is a **live SSH PTY**. No agent installed on the server, nothing to configure remotely — just SSH.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

---

## Why

DeepSeek Harness is a powerful coding agent, but its web GUI works on **local** files. When your code, data or production box lives on a remote server, you either SSH in separately or fight with sync tools. `dsh-remote-ide` brings the whole IDE into the harness:

```
┌──────────────────────────── dsh web GUI ────────────────────────────┐
│  sidebar: [远程 IDE] → opens the right-side IDE workbench           │
│  ┌─────────── conversation (kept) ────────────┬───────────────────┐  │
│  │  agent chat keeps running while you work  │  REMOTE IDE       │  │
│  │                                            │  ┌─────────────┐ │  │
│  │                                            │  │ remote tree │ │  │
│  │                                            │  ├─────────────┤ │  │
│  │                                            │  │ editor tabs  │ │  │
│  │                                            │  │ (SFTP read/  │ │  │
│  │                                            │  │  write)      │ │  │
│  │                                            │  ├─────────────┤ │  │
│  │                                            │  │ xterm SSH    │ │  │
│  │                                            │  │ terminal     │ │  │
│  │                                            │  └─────────────┘ │  │
│  └────────────────────────────────────────────┴───────────────────┘  │
│                    │                    ↑                            │
│                    └── dsh host process ┘  ssh2 connection pool      │
└──────────────────────────────────────────────────────────────────────┘
```

## Features

- **SSH host manager** — password / private-key auth (with passphrase), ProxyJump chains, import from `~/.ssh/config`, connection testing. Credentials stay in `~/.dsh/dsh-remote-ide.json` (0600), secrets never reach the browser.
- **Remote file explorer** — lazy-loading tree over SFTP with per-directory caching, refresh, inline rename/delete, new file/folder.
- **Remote editor** — CodeMirror 6 with language support (TS/JS/Python/JSON/HTML/CSS/SQL/XML/Markdown); open reads the file via SFTP, **Ctrl/Cmd+S saves it back to the server**; binary sniff and 2 MB read cap keep the editor safe.
- **Remote terminal** — xterm.js over a WebSocket-tunneled SSH PTY with resize, reconnect-safe input buffering and backpressure handling.
- **Agent tools (roadmap)** — remote read/write/exec tools so the DSH agent itself can operate the connected server.
- **better-sidebar integration** — when [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed, a "Remote IDE" tab appears in its workbench (additive; the standalone panel still works without it).
- **i18n** — zh / en, follows the DSH language.

## Install

Requires DSH (rc.6+) with a `web` profile, Node ≥ 22.

```sh
dsh plugin --profile web add dsh-remote-ide
dsh web
```

Restart `dsh web` after install (host-half change). The sidebar then shows a **远程 IDE / Remote IDE** entry.

### From source (development)

```sh
git clone https://github.com/<you>/dsh-remote-ide.git
cd dsh-remote-ide
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)     # or link:C:\path\to\repo on Windows
dsh web
```

## Quick start

1. Open the **Remote IDE** panel from the sidebar.
2. **Add host** (alias / host / port / user / auth) — or **import from ~/.ssh/config**.
3. Click **Connect**. The explorer switches to the server's home directory.
4. Browse, click a file to edit, `Ctrl+S` to save to the server.
5. **+ New terminal** opens an SSH shell in the panel.

## How it works

A dual-face DSH plugin riding only official NPM SDK packages (`@deepseek-ai/dsh-*`) — no dsh source changes:

- **Host half** (`src/index.ts`, Node process): `SshEngine` (ssh2 connection pool, jump hosts, exec, PTY shells, SFTP CRUD), the `/api/dsh-remote-ide/*` REST family, and the `/api/dsh-remote-ide/terminal` WebSocket upgrade. Every route is loopback-fenced.
- **Browser half** (`src/client/`, web GUI): host manager, remote explorer, CodeMirror editor, xterm terminal. The sidebar entry is DOM-injected with a self-healing MutationObserver (the shell exposes no plugin slot), following the dsh-ssh precedent.

```
Host process                        Browser (dsh web GUI)
┌──────────────────────┐           ┌──────────────────────────────┐
│ SshEngine (ssh2)     │ REST/WS   │ sidebar entry (DOM injection) │
│  ├─ connection pool  │◄─────────►│ Remote IDE panel             │
│  ├─ exec / PTY shell │           │  ├─ host manager             │
│  ├─ SFTP CRUD        │           │  ├─ remote file tree         │
│  └─ jump hosts       │           │  ├─ CodeMirror editor        │
│ store ~/.dsh/…json   │           │  └─ xterm terminal           │
└──────────────────────┘           └──────────────────────────────┘
```

### Security notes

- All API routes are **loopback-only** (127.0.0.1 / localhost + same-origin check). A LAN-exposed dsh web does not expose the remote-exec surface.
- Passwords are stored plaintext in a 0600 user file (`~/.dsh/dsh-remote-ide.json`) — same model as dsh-ssh; prefer key auth.
- The browser never receives stored secrets (summaries only).
- Remote file reads are capped at 2 MB; binary files are refused with a clear error.

## Roadmap

- [x] Host manager + ssh-config import
- [x] Remote explorer (SFTP tree)
- [x] Remote editor (CodeMirror + SFTP read/write)
- [x] Remote terminal (WebSocket SSH PTY)
- [ ] **Agent tools** (per the official `defineTool` contract): `remote_read` / `remote_write` / `remote_exec` with typed parameter schemas, `output.schema` + pure `presentCall`/`presentResult` render intents, and `run_in_background` long ops via `ctx.jobs.start` — the DSH agent then operates the connected server from chat.
- [ ] **Conversation-node integration** (the official external-UI path): the host emits a durable `SessionEventMap` family (`remote-ide/*`), the browser half registers a `ConversationNodeDefinition` + keyed Chat renderer through `ctx.conversationEvents.register` + `ctx.slots.inject('conversation.chat.node')`, so remote-exec results render as replayable rows in the chat flow.
- [ ] Remote Git panel (status / diff / commit over SSH)
- [ ] File search + upload/download with progress
- [ ] Tunnel (local port forwarding)

## Acknowledgements

This plugin stands on the shoulders of the DSH plugin ecosystem:

- [dsh-ssh](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-ssh) (Apache-2.0) — the SSH engine architecture, WebSocket terminal protocol and DOM-injection patterns this project builds on.
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (MIT) — the local IDE workbench whose service API this plugin integrates with.
- [ssh2](https://github.com/mscdex/ssh2) (MIT), [xterm.js](https://github.com/xtermjs/xterm.js) (MIT), [CodeMirror](https://codemirror.net) (MIT) — the underlying libraries.

## License

[Apache-2.0](LICENSE)
