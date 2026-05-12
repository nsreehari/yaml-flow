/**
 * cli/common/jsonata-loader — synchronous jsonata wrapper.
 *
 * Mirrors the loader pattern used by card-compute. Uses createRequire so the
 * vendored CommonJS sync build can be loaded from ESM. The canonical source
 * file is `src/card-compute/jsonata-sync.cjs`; the tsup post-build hook copies
 * it next to every dist bundle that references it.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

export type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
};

// Source path resolves via the file's location at src/cli/common/.
// Dist path resolves via the post-build copy that places jsonata-sync.cjs
// alongside the bundled output (handled by tsup's copyJsonataSyncToDistDirs).
function _loadJsonata(): (expr: string) => JsonataExpression {
  // Try sibling first (dist layout). If that fails, fall back to the canonical
  // source location (used when running TypeScript directly under vitest/tsx).
  try {
    return _require('./jsonata-sync.cjs');
  } catch {
    return _require('../../lib/card-compute/jsonata-sync.cjs');
  }
}

export const jsonata: (expr: string) => JsonataExpression = _loadJsonata();
