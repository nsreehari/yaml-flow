/**
 * compute-jsonata (Node/npm entry)
 *
 * Sync JSONata compiler/evaluator backed by vendored jsonata-sync.cjs.
 * Intended for npm ESM/CJS consumers in Node-like runtimes.
 */

import { createRequire } from 'module';

export type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
};

export type JsonataCompiler = (expr: string) => JsonataExpression;

const _require = createRequire(import.meta.url);
export const jsonata: JsonataCompiler = _require('./jsonata-sync.cjs');

export function compileSync(expr: string): JsonataExpression {
  return jsonata(expr);
}

export function evaluateSync(expr: string, data: unknown): unknown {
  return compileSync(expr).evaluate(data);
}

const ComputeJsonata = {
  jsonata,
  compileSync,
  evaluateSync,
};

export default ComputeJsonata;
