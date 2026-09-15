import { defineConfig } from 'tsdown'

// Two independent artifacts:
//  - `lib/index.js`  — the host half (Cordis plugin: answerer, /approve, projection).
//  - `lib/client.js` — the browser half, emitted in the DSH client-module format:
//    it hands off through `window.__ModuleLoader__.load({ id, factory })` and
//    resolves externals through the injected `require` (the loader's module
//    table). `react` and `react/jsx-runtime` are the only specifiers this half
//    imports; both are module-table rows, so they stay `require(...)` calls and
//    the slice's own React instance is used — never a second bundled copy.
//
// `tsdown` is also the self-contained `prepare` script for git installs: no
// project references, no type checking.
const PLUGIN_ID = 'dsh-approval-review'

// Host-half imports that must stay imports: the harness resolves them from the
// profile's own install, and a second inlined copy of `session`, `tools`, or
// `cordis` would be a distinct runtime identity — the "dual Cordis" failure.
const HOST_EXTERNAL = /^(@deepseek-ai\/|zod$)/u

export default defineConfig([
  {
    // Order matters: `clean` on the first config wipes lib/, and the second
    // config must never clean it again or it would delete the host artifact.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    // Keep `.js`/`.d.ts`, not tsdown's default `.mjs`/`.d.mts`, so the
    // package.json exports map points at real files.
    fixedExtension: false,
    sourcemap: false,
    outDir: 'lib',
    deps: {
      neverBundle: (specifier) => HOST_EXTERNAL.test(specifier),
      alwaysBundle: (specifier) => !HOST_EXTERNAL.test(specifier) && !specifier.startsWith('node:'),
      onlyBundle: false,
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    // `cjs` is the shape the in-tree client preset uses: the whole artifact is one
    // closure factory whose body is CommonJS, so `require` is the injected
    // module-table resolver rather than a Node builtin.
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    fixedExtension: false,
    sourcemap: true,
    outDir: 'lib',
    deps: {
      // Everything that is not a loader module-table row must inline: this
      // bundle is fetched outside the app's module graph, so a `require()` the
      // table cannot answer is a guaranteed runtime throw.
      neverBundle: (specifier) => specifier === 'react' || specifier === 'react/jsx-runtime',
      alwaysBundle: (specifier) => specifier !== 'react' && specifier !== 'react/jsx-runtime',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
