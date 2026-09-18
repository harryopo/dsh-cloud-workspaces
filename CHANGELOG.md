# Changelog

All notable changes to `dsh-cloud-workspaces` are documented here.

## [v0.3.0] — 2026-09-18

### Added
- **Remote background jobs**: `bash` (cloud sessions) and `ssh_exec` gained `run_in_background` — commands register as first-class DSH jobs via the official `ctx.jobs` contract (kind `ssh`); `job_output` / `job_list` / `job_kill`, completion notices and the jobs UI all work out of the box
- `src/job-runner.ts`: persistent exec-channel wrapper (authoritative exit status, zero polling), incremental `dd` output reads of a remote log, process-group kill (TERM → KILL), honest orphan reporting on connection loss
- Design spec `docs/07-design-remote-jobs.md`; repo knowledge base `docs/REPO-WIKI.md`

## [v0.2.2] — 2026-09-05

### Security
- Password storage converged: settings documents never persist secrets again; the 0600 store is the single authority, with Windows `icacls` ACL tightening and a one-time startup migration of existing plaintext entries
- Host-id prototype-pollution guard (`isSafeHostId`) on both store keys and settings reads

### Added
- `read_image` shadow tool (SFTP binary read + magic sniff + base64 image blocks, 8 MiB cap)
- Shared file-diagnostic logger `src/debug-log.ts` (512 KiB rotation)

### Fixed
- `ctx.on('agent/created')` hook subscription (AgentRegistry has no `on` — routing silently never fired before); real-machine verified: 7 shadow tools register per cloud session

## [v0.2.1] — 2026-08-31

### Added
- **Preset-less cloud workspaces**: dual-tab workspace picker (Local / Cloud SSH) filling the official `directory-flow` slots; placeholder dirs adopted by the official workspace registry
- Session-scoped shadow tools (`bash` / `read` / `write` / `edit` / `glob` / `grep`) routed by session cwd, with official rich-UI presenters (expandable terminal/read cards)
- Dynamic per-session system-prompt section announcing the remote identity
- Full code audit: 12 fixes (connection-pool double release, stale-rejection self-heal, ProxyJump probe leaks, oversized-file streaming, parent-dir creation on write, UI race/timeout guards, …)

## [v0.2.0] — 2026-08-30

### Added
- M4 real-server acceptance (E2E harness `scripts/e2e-real-server.mjs`, 25 checks)
- SSH host settings card (host CRUD, keyboard-interactive password auth, key auth, ProxyJump), remote directory browser with create/delete, placeholder workspaces
- jsonSafe output boundary for all typert endpoints and tool results

## [v0.1.x] — 2026-08-16 → 08-28

### Added
- ssh2 engine (pooling / keepalive / broken rebuild / ProxyJump / SFTP / PTY), shared `SshRuntime` (`ctx.ssh`), global `ssh_*` agent tools, `fs-ssh` / `subprocess-ssh` capability adapters (legacy seam route)
