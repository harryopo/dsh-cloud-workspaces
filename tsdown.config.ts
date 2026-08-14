import { defineConfig } from 'tsdown'

// Two separate builds (one per face) so neither produces shared chunks: the
// web half ships as ONE browser bundle served at /plugins/<id>/client.js and
// the host half must resolve peers from the DSH profile. CSS is pre-compiled
// into TS string modules (scripts/build-css.mjs) and injected at runtime, so
// there is no separate CSS file to serve.
const common = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22' as const,
  dts: false,
  sourcemap: true,
  outDir: 'lib',
  // The package.json main/exports point at lib/index.js and lib/client.js.
  outExtensions: () => ({ js: '.js' }),
  // Peer SDK packages resolve from the DSH profile, never from this bundle.
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-connection',
      'react',
      'react-dom',
    ],
  },
}

export default [
  defineConfig({
    ...common,
    entry: { index: './src/index.ts' },
    clean: true,
  }),
  defineConfig({
    ...common,
    entry: { client: './src/client/index.ts' },
    // The first build already cleaned the output dir.
    clean: false,
  }),
]
