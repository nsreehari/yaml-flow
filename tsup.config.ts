import { defineConfig } from 'tsup';
import { cpSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

/** After build, copy jsonata-sync.cjs next to every dist bundle that references it. */
function copyJsonataSyncToDistDirs() {
  const src = 'src/card-compute/jsonata-sync.cjs';
  if (!existsSync(src)) return;
  // Find all .js/.cjs bundles that contain the require reference
  const out = execSync('grep -rl "jsonata-sync.cjs" dist/ --include="*.js" --include="*.cjs"', { encoding: 'utf-8' }).trim();
  const dirs = new Set(out.split('\n').filter(Boolean).map(f => dirname(f)));
  for (const dir of dirs) {
    const dest = join(dir, 'jsonata-sync.cjs');
    if (!existsSync(dest)) {
      cpSync(src, dest);
    }
  }
  console.log(`Copied jsonata-sync.cjs to ${dirs.size} dist directories`);
}

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'step-machine/index': 'src/step-machine/index.ts',
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
    'cli/node/board-live-cards-cli': 'src/cli/node/board-live-cards-cli.ts',
    'cli/node/fs-board-adapter': 'src/cli/node/fs-board-adapter.ts',
    'cli/node/card-store-cli': 'src/cli/node/card-store-cli.ts',
    'cli/node/source-cli-task-executor': 'src/cli/node/source-cli-task-executor.ts',
    'cli/browser-api/board-live-cards-browser-adapter': 'src/cli/browser-api/board-live-cards-browser-adapter.ts',
    'cli/browser-api/card-store-browser-api': 'src/cli/browser-api/card-store-browser-api.ts',
    'stores/file': 'src/stores/file.ts',
    'storage-refs': 'src/cli/node/public-storage-adapter.ts',
    'execution-refs': 'src/cli/common/execution-interface.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  onSuccess: async () => { copyJsonataSyncToDistDirs(); },
});
