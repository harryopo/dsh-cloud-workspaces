# Show HN draft (English)

**Posting checklist**: needs an HN account with a bit of karma history (fresh accounts get Show HN auto-flagged; if account is new, warm it up for a few days first). Best window: weekday ~13:00–15:00 UTC. URL: https://github.com/harryopo/dsh-cloud-workspaces

**Title (≤80 chars)**:
Show HN: Cloud workspaces for DeepSeek Harness – the agent runs on your Linux server, zero remote install

**First comment (author comment, paste after posting)**:

Hey HN – I built a plugin for DeepSeek Harness (DSH) that lets the coding agent work directly on a remote Linux server.

The angle I care about: existing remote-dev solutions ship a fat server component (vscode-server is ~100MB+) that the client downloads to the host on first connect. SSH already gives us exec, SFTP and PTY channels — so this plugin rides **standard OpenSSH only**. Nothing to install on the server, nothing to keep version-synced.

How the transparency works: when a session's workspace is a "cloud" directory, a hook registers same-name shadow tools (bash/read/write/edit/glob/grep) scoped to that agent session only — the model sees the normal toolset, but every call lands on the server. Local sessions are untouched. Long-running commands (installs, builds) go through the official background-jobs contract: one persistent SSH exec channel per job, the channel's close event is the authoritative exit status (zero polling), output is tailed incrementally from a remote log, cancellation kills the process group.

Stack: TypeScript, ssh2, DSH plugin SDK (dual-face: Node host half + React browser half). Apache-2.0.

npm: https://www.npmjs.com/package/dsh-cloud-workspaces
Repo: https://github.com/harryopo/dsh-cloud-workspaces

Happy to answer questions about the plugin seams, the shadow-tool trick, or why I refused to build a remote agent.
