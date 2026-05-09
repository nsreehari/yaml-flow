/**
 * Browser IIFE entry for vendored jsonata-sync.
 *
 * Bundles jsonata-sync.cjs inline (esbuild CJS interop) and sets
 * globalThis.jsonataSync so board-livecards-localstorage.js can call
 * the jsonata function at runtime via the createRequire shim.
 *
 * Consumers: load this before board-livecards-localstorage.js.
 * No other scripts need to know about this global.
 */

// esbuild inlines jsonata-sync.cjs via CJS interop; module.exports becomes the default.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — vendored CJS bundle, no type declarations
import jsonataFn from './jsonata-sync.cjs';

(globalThis as Record<string, unknown>).jsonataSync = jsonataFn;
