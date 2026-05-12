/**
 * step-machine-public — jsonata loader
 *
 * Synchronous jsonata wrapper. Mirrors the loader pattern in
 * src/card-compute/index.ts — uses createRequire to load the vendored
 * synchronous CommonJS build.
 *
 * Runtime portability:
 *   - Node ESM: createRequire works.
 *   - Browser/cloud: package this lib for that runtime; the consumer ships
 *     jsonata-sync.cjs alongside (tsup post-build does this automatically).
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'node:fs';

const _thisDir = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

export type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
};

function _jsonataCjsPath(): string {
  // Dist layout: tsup copies jsonata-sync.cjs next to each bundle.
  const sibling = resolve(_thisDir, './jsonata-sync.cjs');
  if (existsSync(sibling)) return sibling;
  // Source layout (vitest/tsx): canonical copy lives in src/card-compute/.
  // From src/step-machine-public/, ../card-compute/ = src/card-compute/.
  return resolve(_thisDir, '../card-compute/jsonata-sync.cjs');
}

export const jsonata: (expr: string) => JsonataExpression = _require(_jsonataCjsPath());
