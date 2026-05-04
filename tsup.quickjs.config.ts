import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

const quickjsStubPlugin: Plugin = {
  name: 'quickjs-node-stubs',
  setup(build) {
    const stubbed = [
      'fs',
      'path',
      'os',
      'child_process',
      'proper-lockfile',
      'yaml',
      'ajv',
      'ajv-formats',
      'fast-glob',
    ];

    build.onResolve({ filter: /^module$/ }, () => ({
      path: 'quickjs-module-shim',
      namespace: 'quickjs-shim',
    }));

    build.onLoad({ filter: /.*/, namespace: 'quickjs-shim' }, () => ({
      contents: `
        export function createRequire() {
          return function(req) {
            if (req === './jsonata-sync.cjs') {
              return (typeof globalThis !== 'undefined' && globalThis.__jsonataSync)
                || (typeof globalThis !== 'undefined' && globalThis.jsonata);
            }
            throw new Error('Unsupported require in QuickJS bundle: ' + req);
          };
        }
      `,
      loader: 'js',
    }));

    build.onResolve({ filter: /^[^./]/ }, (args) => {
      const base = args.path.split('/')[0];
      if (stubbed.includes(base) || base.startsWith('node:')) {
        return { path: args.path, namespace: 'quickjs-empty' };
      }
      return undefined;
    });

    build.onLoad({ filter: /.*/, namespace: 'quickjs-empty' }, () => ({
      contents: 'export default undefined; export {};',
      loader: 'js',
    }));
  },
};

export default defineConfig({
  entry: {
    'pycli/quickjs-board-runtime': 'src/cli/pycli/quickjs-board-runtime.ts',
  },
  outDir: 'dist',
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',
  splitting: false,
  minify: false,
  sourcemap: true,
  clean: false,
  dts: false,
  treeshake: true,
  esbuildPlugins: [quickjsStubPlugin],
});
