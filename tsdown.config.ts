/**
 * Build config for dsh-cloud-workspaces (host half): ESM node bundles for the
 * plugin entry (index), the invariant companion, the subpath exports other
 * DSH packages may consume, and the capability services. The entry is
 * index.ts — cloud sessions get their remote tools from the agent/created
 * hook in session-tools.ts, not from replacing ctx.fs / ctx.subprocess.
 * fs-ssh / subprocess-ssh remain entries only as the reference implementation
 * of that retired seam-replacement route; nothing mounts them.
 * SDK peers resolve from the dsh profile at runtime, never bundled.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-remote-ide/host',
  entry: {
    index: './src/index.ts',
    invariant: './src/invariant.ts',
    tools: './src/tools.ts',
    'ssh-service': './src/ssh-service.ts',
    'job-runner': './src/job-runner.ts',
    'fs-ssh': './src/fs-ssh.ts',
    'subprocess-ssh': './src/subprocess-ssh.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  // tsc emits lib/types (declarations) first; tsdown must not wipe them
  // (the build script owns a full lib/ cleanup before tsc runs).
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  // Resolved from the dsh profile tree at runtime, never bundled.
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-jobs',
  ],
})
