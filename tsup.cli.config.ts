import { defineConfig } from 'tsup';
import { cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

/** After build, copy jsonata-sync.cjs next to every cli bundle that references it. */
function copyJsonataSyncToCliDirs() {
  const src = 'src/card-compute/jsonata-sync.cjs';
  const outDir = 'cli';
  if (!existsSync(src)) return;
  if (!existsSync(outDir)) return;

  let out = '';
  try {
    out = execSync(`grep -rl "jsonata-sync.cjs" ${outDir}/ --include="*.js"`, { encoding: 'utf-8' }).trim();
  } catch {
    out = '';
  }

  if (!out) {
    console.log('No cli bundles require jsonata-sync.cjs');
    return;
  }

  const dirs = new Set(out.split('\n').filter(Boolean).map((f) => dirname(f)));
  for (const dir of dirs) {
    const dest = join(dir, 'jsonata-sync.cjs');
    if (!existsSync(dest)) {
      cpSync(src, dest);
    }
  }

  console.log(`Copied jsonata-sync.cjs to ${dirs.size} cli directories`);
}

export default defineConfig({
  entry: {
    'node/step-machine-cli': 'src/cli/node/step-machine-cli.ts',
    'node/batch-runner-cli': 'src/cli/node/batch-runner-cli.ts',
    'node/board-live-cards-cli': 'src/cli/node/board-live-cards-cli.ts',
    'node/fs-board-adapter': 'src/cli/node/fs-board-adapter.ts',
    'node/execution-adapter': 'src/cli/node/execution-adapter.ts',
    'node/card-store-cli': 'src/cli/node/card-store-cli.ts',
    'node/artifacts-store-cli': 'src/cli/node/artifacts-store-cli.ts',
    'node/chat-store-cli': 'src/cli/node/chat-store-cli.ts',
    'node/source-cli-task-executor': 'src/cli/node/source-cli-task-executor.ts',
    'browser-api/board-live-cards-browser-adapter': 'src/cli/browser-api/board-live-cards-browser-adapter.ts',
    'browser-api/card-store-browser-api': 'src/cli/browser-api/card-store-browser-api.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'cli',
  onSuccess: async () => { copyJsonataSyncToCliDirs(); },
});
