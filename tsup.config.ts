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
    'cloud-storage': 'src/cli/cloud/index.ts',
    'board-live-cards-public': 'src/cli/common/board-live-cards-public.ts',
    'board-live-cards-mcp': 'src/cli/common/board-live-cards-mcp.ts',
    'card-store-public': 'src/cli/common/card-store-lib-public.ts',
    'queue-storage-public': 'src/cli/common/queue-storage-public.ts',
    'artifacts-store-public': 'src/cli/common/artifacts-store-lib-public.ts',
    'chat-store-public': 'src/cli/common/chat-store-lib-public.ts',
    'board-worker-adapter': 'src/cli/public/board-worker-adapter.ts',
    'step-machine/index': 'src/step-machine/index.ts',
    'step-machine-public/index': 'src/step-machine-public/index.ts',
    'event-graph/index': 'src/event-graph/index.ts',
    'stores/index': 'src/stores/index.ts',
    'stores/memory': 'src/stores/memory.ts',
    'stores/kv': 'src/stores/kv.ts',
    'batch/index': 'src/batch/index.ts',
    'config/index': 'src/config/index.ts',
    'continuous-event-graph/index': 'src/continuous-event-graph/index.ts',
    'board-livegraph-runtime/index': 'src/board-livegraph-runtime/index.ts',
    'compute-jsonata/index': 'src/compute-jsonata/index.ts',
    'compute-jsonata/browser': 'src/compute-jsonata/browser.ts',
    'notification-consumer/index': 'src/notification-consumer/index.ts',
    'board-state-reducer': 'src/board-state-reducer.ts',
    'card-compute/index': 'src/card-compute/index.ts',
    'card-validation': 'src/card-validation.ts',
    'board-live-cards-node': 'src/cli/node/fs-board-adapter.ts',
    'execution-refs': 'src/cli/common/execution-interface.ts',
    'server-runtime/index': 'src/server-runtime/index.ts',
    'board-live-cards-server-runtime': 'src/server-runtime/index.ts',
    'server-runtime-core/index': 'src/server-runtime-core/index.ts',
    'server-runtime-agentface/index': 'src/server-runtime-agentface/index.ts',
    'server-runtime-controlface/index': 'src/server-runtime-controlface/index.ts',
    'server-runtime-watchers/index': 'src/server-runtime-watchers/index.ts',
    'server-runtime-webhooks/index': 'src/server-runtime-webhooks/index.ts',
    'server-jobs-queue-runner/index': 'src/server-jobs-queue-runner/index.ts',
    'firestore-storage/index': 'src/firestore-storage/index.ts',
    'localstorage-storage/index': 'src/localstorage-storage/index.ts',
    'firebase-storage/index': 'src/firebase-storage/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'lib',
  onSuccess: async () => { copyJsonataSyncToLibDirs(); },
});
