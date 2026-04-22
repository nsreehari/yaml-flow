/**
 * Browser IIFE bundle for board-livegraph-runtime.
 *
 * Output: browser/board-livegraph-runtime.js
 * Global: window.BoardLiveGraph
 *
 * External users need only two script tags:
 *   <script src="https://cdn.jsdelivr.net/npm/jsonata/jsonata.min.js"></script>
 *   <script src="browser/board-livegraph-runtime.js"></script>
 *
 * jsonata is kept external (window.jsonata must be loaded first, same as card-compute.js).
 * All Node-only modules (ajv, ajv-formats, child_process, proper-lockfile, yaml, etc.)
 * are stubbed out — they are dead code in the browser execution path.
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

    build.onLoad({ filter: /.*/, namespace: 'browser-stub' }, () => ({
      contents: 'export default undefined; export {};',
      loader: 'js',
    }));
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
      // Expose window.jsonata as the default export so the card-compute import works.
      contents: `
        const _jsonata = (typeof globalThis !== 'undefined' && globalThis.jsonata)
          || (typeof window !== 'undefined' && window.jsonata);
        export default _jsonata;
        export { _jsonata as jsonata };
      `,
      loader: 'js',
    }));
  },
};

export default defineConfig({
  entry: {
    'board-livegraph-runtime': 'src/board-livegraph-runtime/index.ts',
  },
  outDir: 'browser',
  format: ['iife'],
  globalName: 'BoardLiveGraph',
  platform: 'browser',
  outExtension: () => ({ js: '.js' }),
  target: 'es2020',
  minify: false,
  sourcemap: true,
  dts: false,
  clean: false,
  splitting: false,
  treeshake: true,
  esbuildPlugins: [jsonataGlobalShim, browserStubPlugin],
});
