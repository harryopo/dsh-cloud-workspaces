/**
 * Build config for dsh-remote-ide (host-only edition): ESM node bundles for
 * the plugin entry (index), the invariant companion, and the remote-tools
 * subpath (consumed by the `remote` agent preset). SDK peers resolve from the
 * dsh profile at runtime, never bundled.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-remote-ide/host',
  entry: {
    index: './src/index.ts',
    invariant: './src/invariant.ts',
    tools: './src/tools.ts',
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
  ],
})
