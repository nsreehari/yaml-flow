/**
 * Browser IIFE bundles for yaml-flow.
 *
 * Outputs: browser/*.js browser/*.map
 *
 * Exports: create(), selectLiveCardModel(), selectAllLiveCardModels()
 *
 * jsonataSync is kept external (window.jsonataSync must be loaded first).
 * All Node-only modules are stubbed out — dead code in the browser execution path.
 */
import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

/**
 * Stub plugin: intercepts Node-only and unused modules that tsup would otherwise
 * try to bundle, replacing them with empty no-op modules.
 */
const browserStubPlugin: Plugin = {
  name: 'browser-node-stubs',
  setup(build) {
    build.onResolve({ filter: /^module$/ }, () => ({
      path: 'browser-module-shim',
      namespace: 'browser-stub',
    }));

    const stubbed = [
      'ajv',
      'ajv-formats',
      'child_process',
      'proper-lockfile',
      'yaml',
      'fast-glob',
      'fs',
      'path',
      'os',
    ];

    // Exact-match bare specifiers
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      const base = args.path.split('/')[0];
      if (stubbed.includes(base) || base.startsWith('node:')) {
        return { path: args.path, namespace: 'browser-stub' };
      }
      return undefined;
    });

    build.onLoad({ filter: /.*/, namespace: 'browser-stub' }, (args) => {
      if (args.path === 'browser-module-shim') {
        return {
          contents: `
            export function createRequire() {
              return function(req) {
                if (req === './jsonata-sync.cjs') {
                  return (typeof globalThis !== 'undefined' && globalThis.__jsonataSync)
                    || (typeof globalThis !== 'undefined' && globalThis.jsonataSync);
                }
                throw new Error('Unsupported require in browser bundle: ' + req);
              };
            }
          `,
          loader: 'js',
        };
      }
      return {
        contents: 'export default undefined; export {};',
        loader: 'js',
      };
    });
  },
};

/**
 * jsonata inject shim: the browser bundle treats jsonata as external (window.jsonata),
 * but the TS source imports it as an ES module default.
 * We provide a thin shim file that re-exports window.jsonata so the IIFE build can
 * replace the import without bundling the whole library.
 */
const jsonataGlobalShim: Plugin = {
  name: 'jsonata-window-shim',
  setup(build) {
    build.onResolve({ filter: /^jsonata$/ }, () => ({
      path: 'jsonata-shim',
      namespace: 'jsonata-global-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'jsonata-global-shim' }, () => ({
      // Expose window.jsonataSync as the default export so the card-compute import works.
      contents: `
        const _jsonata = (typeof globalThis !== 'undefined' && globalThis.jsonataSync)
          || (typeof window !== 'undefined' && window.jsonataSync);
        export default _jsonata;
        export { _jsonata as jsonata };
      `,
      loader: 'js',
    }));
  },
};

/**
 * Shared browser build options (minus entry/globalName).
 */
const sharedBrowserOptions = {
  outDir: 'browser',
  format: ['iife' as const],
  platform: 'browser' as const,
  outExtension: () => ({ js: '.js' }),
  target: 'es2020',
  minify: true,
  sourcemap: true,
  dts: false,
  clean: false,
  splitting: false,
  treeshake: true,
};

export default defineConfig([
  // ── live-cards — browser UI runtime exposed as globalThis.LiveCard ───────────────────
  {
    ...sharedBrowserOptions,
    entry: { 'live-cards': 'src/live-cards/browser-entry.ts' },
    globalName: 'LiveCardBundle',
    esbuildPlugins: [browserStubPlugin],
  },
  // ── compute-jsonata — vendored jsonata-sync, sets globalThis.jsonataSync ─────────────
  {
    ...sharedBrowserOptions,
    entry: { 'compute-jsonata': 'src/card-compute/browser-jsonata-entry.ts' },
    globalName: 'ComputeJsonata',
    esbuildPlugins: [browserStubPlugin],
  },
  // ── board-sse-state — platform-free SSE-frame -> UI snapshot reducer ─────────────────
  // Consumer brain (notification-consumer + board-state-reducer). No node:* and no
  // jsonata dependency, so it loads self-contained into any lighter JS engine (V8).
  // Global: globalThis.BoardSseState (applyBoardSseFrame, createEmptyBoardSnapshot).
  {
    ...sharedBrowserOptions,
    entry: { 'board-sse-state': 'src/board-sse-state.ts' },
    globalName: 'BoardSseState',
    esbuildPlugins: [browserStubPlugin],
  },
  // ── server-runtime-controlface — board control-plane runtime (browser edition) ────────
  // Platform-free: no node:* imports in the runtime or its transitive deps.
  // Use with a Firestore JS SDK adapter for in-browser board orchestration.
  // Global: window.ServerRuntimeControlface
  {
    ...sharedBrowserOptions,
    entry: { 'server-runtime-controlface': 'src/server-runtime-controlface/browser.ts' },
    globalName: 'ServerRuntimeControlface',
    esbuildPlugins: [jsonataGlobalShim, browserStubPlugin],
  },
  // ── Storage adapters — emitted under browser/adapters/ so CDN/NPM consumers
  //    can address them as a clearly-scoped subdir of pluggable adapters.
  // ── firestore-storage — browser-safe Firestore storage/queue adapter primitives ─────
  {
    ...sharedBrowserOptions,
    outDir: 'browser/adapters',
    entry: { 'firestore-storage': 'src/firestore-storage/index.ts' },
    globalName: 'FirestoreStorage',
    esbuildPlugins: [browserStubPlugin],
  },
  // ── localstorage-storage — browser-safe in-memory/localStorage adapter ────────────────
  {
    ...sharedBrowserOptions,
    outDir: 'browser/adapters',
    entry: { 'localstorage-storage': 'src/localstorage-storage/index.ts' },
    globalName: 'LocalStorageStorage',
    esbuildPlugins: [browserStubPlugin],
  },
  // ── firebase-storage — Firebase Storage (GCS) blob/scratch wrappers.
  //    No firebase SDK imports; host passes in a firebase.storage() handle.
  {
    ...sharedBrowserOptions,
    outDir: 'browser/adapters',
    entry: { 'firebase-storage': 'src/firebase-storage/index.ts' },
    globalName: 'FirebaseStorage',
    esbuildPlugins: [browserStubPlugin],
  },
]);
