/**
 * Browser IIFE bundles for yaml-flow.
 *
 * Outputs: browser/board-livecards-localstorage.js
 * Global:  window.BoardLiveCardsLocalStorage
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
  // ── board-livecards-localstorage — full board engine + localStorage adapter + selectors ─
  {
    ...sharedBrowserOptions,
    entry: { 'board-livecards-localstorage': 'src/board-livecards-localstorage-runtime/index.ts' },
    globalName: 'BoardLiveCardsLocalStorage',
    esbuildPlugins: [jsonataGlobalShim, browserStubPlugin],
  },
]);
