# Contributing — dsh-cloud-workspaces

Start with **[AGENTS.md](./AGENTS.md)** (architecture, commands, pitfalls) and **[docs/REPO-WIKI.md](./docs/REPO-WIKI.md)** (full capability map — check it before building anything new, reuse over reinvention).

## Commands

| Command | Purpose |
|---|---|
| `pnpm install` | dependencies (Node ≥ 22) |
| `pnpm build` | wipe `lib/` → `tsc` declarations (`lib/types`) → `tsdown` bundles (`lib/*.js`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest (120 unit tests; fake ssh2 harness) |
| `node scripts/e2e-real-server.mjs [alias]` | 29-check acceptance run against a real SSH server (see AGENTS.md for the WSL target) |

## Layout

```
src/
  index.ts          plugin entry: runtime + tools + settings + typert + session routing
  session-tools.ts  agent/created hook → shadow tools (bash/read/write/edit/glob/grep/read_image) in agent scope
  engine.ts         ssh2 engine: pool, exec, SFTP, PTY, ProxyJump
  job-runner.ts     background jobs producer (official ctx.jobs, kind ssh)
  ssh-service.ts    SshRuntime (ctx.ssh, single connection owner)
  tools.ts          global ssh_* agent tools
  typert.ts         cross-half RPC endpoints (settings card data plane)
  store.ts          host config store (~/.dsh/dsh-remote-ide.json, 0600 + ACL)
  workspace.ts      placeholder-workspace routing (pure functions, injectable fs)
  jsonsafe.ts       output-boundary sanitizer — every boundary return must pass through it
client/index.js     browser half: settings card + dual-tab workspace picker (React.createElement, no JSX)
tests/              vitest suites (mirror of src modules + fake ssh2 transport)
scripts/            e2e acceptance + diagnostics
docs/               03 design book · 06 methodology · 07 jobs spec · REPO-WIKI.md
```

## Conventions

- **Dual-face plugin**: host half `exports "."` (Node), browser half `exports "./client"` (web ModuleLoader executes the bundle directly — **plain `React.createElement`, never JSX**). Mounting rides `dsh.bundle.patch` → `cordis.patch.yml`.
- **Boundaries**: every typert endpoint and tool `execute` return goes through `jsonSafe` (lossless-JSON validation rejects `undefined` own-values). Every remote command interpolation goes through `quoteSh`.
- **Secrets**: passwords live only in the 0600 store; settings documents never persist them. The wire only ever sees `redactHosts` projections.
- **Shadow tools** register in `payload.agent.ctx` (agent scope) only — never on the plugin ctx — and the hook must never throw into session creation.
- **Rich UI**: tools shadowing official names (`bash`/`read`) must implement `presentCall`/`presentResult` or their chat rows render inert.
- Host-half changes need a `dsh web` restart to load; never restart an instance hosting a live conversation.
- Tests: reuse the `vi.mock('ssh2')` FakeClient harness (`tests/engine-connection.test.ts`); clear `FakeClient.instances` in every describe's `beforeEach`.
- Commits: conventional prefixes (`feat:` / `fix:` / `docs:` / `chore:`), focused diffs.

## Before opening a PR

`pnpm typecheck && pnpm test && pnpm build` all green; if a remote-behaviour changed, run the E2E script against a real server; update `docs/REPO-WIKI.md` capability rows and `CHANGELOG.md`.
