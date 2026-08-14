# dsh-remote-ide — development notes

## Commands

| Command | Purpose |
|---|---|
| `pnpm gen:css` | Regenerate `src/client/panel/panel-css.ts` (Lightning CSS scoped classes) and `xterm.css.ts` (official xterm styles). |
| `pnpm build` | gen:css → `tsc -p tsconfig.build.json` → tsdown (lib/index.js + lib/client.js). |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest unit tests (host store, engine helpers, protocol). |
| `pnpm watch` | tsdown watch (rebuild on change). |

## Layout

```
src/
  protocol.ts            # shared wire contract (both halves)
  store.ts               # host config store (~/.dsh/dsh-remote-ide.json, ssh-config import)
  engine.ts              # ssh2 engine: pool, exec, PTY shell, SFTP CRUD
  routes.ts              # /api/dsh-remote-ide/* + terminal WebSocket upgrade (loopback fence)
  index.ts               # host half entry (apply)
  client/
    api.ts               # browser API client + WS terminal factory
    locales.ts           # zh/en dictionaries
    mount.tsx            # center-column panel mount (conversation takeover)
    sidebar-entry.ts     # sidebar DOM injection (self-healing)
    better-sidebar.ts    # optional dsh-better-sidebar tab integration
    panel/               # React components + scoped CSS
tests/                   # vitest unit tests
scripts/                 # build-time generators (css, xterm css)
```

## Conventions

- **Dual-face plugin**: node half exports `.` (host), browser half exports `./client`.
- **Never touch DSH source**: everything rides `@deepseek-ai/dsh-*` SDK packages; mounts via `cordis.patch.yml` + profile mechanism.
- **Loopback fence on every route** that touches remote servers.
- **Secrets never leave the host**: the browser gets `SshHostSummary` only; the store file is 0600.
- **DOM mounting failures must not take the GUI down** — log, never throw.
- Client-bundle purity: no value imports of other plugins (type-only imports are fine).

## Testing against a real server

1. Add a host in the panel (or the API) with key auth.
2. `POST /api/dsh-remote-ide/connect {alias}` → `connected`.
3. `POST /api/dsh-remote-ide/fs/ls {path}` etc.
4. WebSocket terminal: `ws://127.0.0.1:<port>/api/dsh-remote-ide/terminal?alias=<alias>` with the frame protocol in `protocol.ts`.
