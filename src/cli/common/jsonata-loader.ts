/**
 * cli/common/jsonata-loader — synchronous jsonata wrapper.
 *
 * Mirrors the loader pattern used by card-compute. Uses createRequire so the
 * vendored CommonJS sync build can be loaded from ESM. The canonical source
 * file is `src/card-compute/jsonata-sync.cjs`; the tsup post-build hook copies
 * it next to every dist bundle that references it.
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
  // From src/cli/common/, ../../card-compute/ = src/card-compute/.
  return resolve(_thisDir, '../../card-compute/jsonata-sync.cjs');
}

export const jsonata: (expr: string) => JsonataExpression = _require(_jsonataCjsPath());
