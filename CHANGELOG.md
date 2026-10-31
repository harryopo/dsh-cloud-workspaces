# Changelog

All notable changes to `dsh-cloud-workspaces` are documented here.

## [0.4.0] — 2026-10-30

### Breaking
- **Requires DeepSeek Harness >= 0.2.1-rc.5.** The 0.2 SDK removed the settings-namespace API and replaced the jobs producer contract; 0.1.x is no longer supported (install `dsh-cloud-workspaces@0.3.0` for 0.1.x).
- **Host metadata now lives only in the 0600 store** (`~/.dsh/dsh-remote-ide.json`). On first start an empty store imports the legacy `dsh-remote-ide-hosts` section from `settings.yaml`; the legacy section is left untouched.
- Removed the retired seam-reference modules (`fs-ssh`, `subprocess-ssh`) and their package subpath exports.

### Added
- **`ssh_tunnel` — local port forwarding.** `start` listens on `127.0.0.1` and forwards through the SSH connection to a host/port reachable from the server (remote web previews, loopback-only databases, internal hosts). `stop` / `list` manage live forwards; tunnels close automatically when the pooled connection drops. Servers with `AllowTcpForwarding no` surface the denial as a closed local connection (logged).
- **Dual-pane workspace picker.** Left rail lists *this machine*, *recent workspaces* (one click back to a bound remote directory) and *SSH hosts* (searchable when there are more than six); the right pane has clickable breadcrumbs, an editable path field, explicit empty/loading/error states, inline folder creation and a single "Use this directory" action. Machine strings (hosts, paths) use a monospace face; selection uses a background fill, never an edge bar.

### Changed
- Background jobs use the 0.2 push producer API (`JobHandle.append`); cancellation, orphan detection and exit-code semantics are unchanged.
- Client wiring follows the 0.2 contracts: `uiWorkspace` service and the `dsh-client-connection` / `dsh-client-ui-workspace` load edges.
- Host list/save/delete endpoints read and write the 0600 store directly.
- `ssh_workspace create` registers the new workspace (thanks @contributors, closes #2).

### Fixed
- **A crashing cloud picker can no longer block local workspace creation.** The directory-flow occupant is wrapped in a render boundary; if it throws, the dialog falls back to a single "choose a local folder" action (issue #1).
- **Failed SSH handshakes release the half-open client.** `connectClient` now ends the client on both handshake-error and synchronous-connect-throw paths, so repeated failed connections no longer accumulate partially open clients.
- **Background jobs distinguish an unwritable `/tmp` from a command's own exit 127.** The wrapper now verifies the pid file after a 127 exit and reports "cannot write pid file" instead of blaming the command.
- **Shadow `glob` / `grep` no longer report a timeout as "0 matches".** Both tools capped remote exec at 30 s but ignored `timedOut`; a large tree could return an empty result that looked like a clean miss. They now fail loudly with the path/pattern and a narrowing hint.
- **Jump-host chains release established hops when a later hop fails.** A mid-chain connect error previously leaked every client opened before it.
- Client typert codecs now provide the `create()` factory required by 0.2; without it the remote mount failed and the host list rendered empty on a real 0.2 instance.

## [Unreleased]

### Fixed
- **`ssh_ls` failed on every non-empty directory** — `engine.ls()` returns the raw POSIX `mode` on each entry, but the tool's output schema declared `additionalProperties: false` without it, so the host's output validation rejected every listing with `ToolOutputError`. The schema now declares `mode` (and `RemoteDirEntry.mode` is correctly non-optional).
- **`ssh_workspace create` did not register the new workspace** — the settings-card path registered placeholders with DSH's workspace registry, the tool path did not, so a workspace bound from chat never appeared in "select workspace". Both paths now share one registration helper. (Closes good-first issue #2.)
- Removed a hint pointing at `ssh_config`, a tool that is not registered.

### Changed
- **Settings card and workspace picker restyled to match the host design system.** The primary button used to render as white-on-dark text on a light fill (and would have inverted to invisible in the light theme); buttons, cards, tabs, inputs and the section hierarchy now use the host's semantic `--dsw-*` tokens, so both themes adapt as pairs. Removed 14 hardcoded Apple-light fallbacks, dropped the `color-mix` greying on cards, de-emphasised the monospace font on host addresses, and tightened the section copy.
- Remote delete now uses an in-app confirmation dialog instead of the native `window.confirm`, matching the rest of the UI. The dialog traps focus, closes on `Escape`, and renders the remote path as inert text.
- Client-side error logging now reports only the error message instead of dumping the error object, keeping host configuration out of the browser console.

### Security
- Added `scripts/verify-client-security.mjs` — an executable check (29 assertions) covering HTML-writing sinks, native dialogs, untrusted remote data staying in text position, secret hygiene and destructive-action safeguards. Run with `node scripts/verify-client-security.mjs`.

### Documentation
- Corrected the READMEs (en + zh) which still described the retired `ctx.fs` / `ctx.subprocess` seam-replacement architecture as the shipped headline feature; the real mechanism is per-session shadow tools registered via the `agent/created` hook. Also corrected the `preset scoping` claim (the `ssh_*` tools are global, not preset-gated), the credential-storage wording (passwords live only in the 0600 store, never in settings), and stale test/version counts across `agents.md`, `docs/REPO-WIKI.md`, `docs/README.md` and `memory/`.

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
