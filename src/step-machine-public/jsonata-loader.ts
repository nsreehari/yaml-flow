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

const _require = createRequire(import.meta.url);

export type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
};

export const jsonata: (expr: string) => JsonataExpression = _require('./jsonata-sync.cjs');
