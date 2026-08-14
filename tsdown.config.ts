/**
 * Build config for dsh-remote-ide, mirroring the dsh-web-ui shared client
 * preset (shared/tsdown.client.ts, Apache-2.0):
 *
 * - Host half (lib/index.js): ESM node bundle, SDK peers external.
 * - Browser half (lib/client.js): CJS closure-factory artifact for the GUI's
 *   __ModuleLoader__ — the bundle calls
 *   `window.__ModuleLoader__.load({ id, factory })` and resolves platform
 *   externals through the injected require (loader module table). Everything
 *   else (xterm, CodeMirror, our pre-compiled CSS strings) is inlined.
 */
import { defineConfig } from 'tsdown'

/** The plugin id stamped into the loader handoff. */
const ID = 'dsh-remote-ide'

/** Browser platform modules: the shell's frozen module table (seed entries). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Documented runtime store exemption (same stance as the official preset). */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

export default [
  // ------------------------------------------------------------ host half
  defineConfig({
    name: `${ID}/host`,
    entry: {
      index: './src/index.ts',
      invariant: './src/invariant.ts',
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
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ],
  }),
  // --------------------------------------------------------- client half
  defineConfig({
    name: `${ID}/client`,
    entry: { client: './src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false, // the host half above already cleaned lib/
    external: CLIENT_EXTERNALS,
    // Anything not in the loader module table must inline (a require() the
    // table cannot answer is a guaranteed runtime throw).
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external, every other @deepseek-ai value
      // import is a build error — collaborate through cordis services and
      // the plugin's own HTTP API instead (type-only imports are erased and
      // never reach this gate).
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module — cross-plugin value imports are forbidden; `
          + 'collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }),
]
