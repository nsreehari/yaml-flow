import { defineConfig } from 'tsup';
import { cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

/** After build, copy jsonata-sync.cjs next to every lib bundle that references it. */
function copyJsonataSyncToLibDirs() {
  const src = 'src/card-compute/jsonata-sync.cjs';
  const outDir = 'lib';
  if (!existsSync(src)) return;
  if (!existsSync(outDir)) return;

  let out = '';
  try {
    out = execSync(`grep -rl "jsonata-sync.cjs" ${outDir}/ --include="*.js" --include="*.cjs"`, { encoding: 'utf-8' }).trim();
  } catch {
    out = '';
  }

  if (!out) {
    console.log('No lib bundles require jsonata-sync.cjs');
    return;
  }

  const dirs = new Set(out.split('\n').filter(Boolean).map(f => dirname(f)));
  for (const dir of dirs) {
    const dest = join(dir, 'jsonata-sync.cjs');
    if (!existsSync(dest)) {
      cpSync(src, dest);
    }
  }
  console.log(`Copied jsonata-sync.cjs to ${dirs.size} lib directories`);
}

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'board-live-cards-public': 'src/cli/common/board-live-cards-public.ts',
    'card-store-public': 'src/cli/common/card-store-lib-public.ts',
    'artifacts-store-public': 'src/cli/common/artifacts-store-lib-public.ts',
    'public-storage-adapter': 'src/cli/node/public-storage-adapter.ts',
    'step-machine/index': 'src/step-machine/index.ts',
    'step-machine-public/index': 'src/step-machine-public/index.ts',
    'event-graph/index': 'src/event-graph/index.ts',
    'stores/index': 'src/stores/index.ts',
    'stores/memory': 'src/stores/memory.ts',
    'stores/localStorage': 'src/stores/localStorage.ts',
    'batch/index': 'src/batch/index.ts',
    'config/index': 'src/config/index.ts',
    'continuous-event-graph/index': 'src/continuous-event-graph/index.ts',
    'board-livegraph-runtime/index': 'src/board-livegraph-runtime/index.ts',
    'inference/index': 'src/inference/index.ts',
    'card-compute/index': 'src/card-compute/index.ts',
    'stores/file': 'src/stores/file.ts',
    'execution-refs': 'src/cli/common/execution-interface.ts',
    'server-runtime/index': 'src/server-runtime/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'lib',
  onSuccess: async () => { copyJsonataSyncToLibDirs(); },
});
