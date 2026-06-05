/**
 * compute-jsonata (browser/vite entry)
 *
 * Browser-safe sync JSONata compiler/evaluator. Reads the compiler from
 * globalThis.jsonataSync, which is provided by yaml-flow/browser/compute-jsonata.js.
 */

export type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
};

export type JsonataCompiler = (expr: string) => JsonataExpression;

function resolveJsonataSync(): JsonataCompiler {
  const candidate = (globalThis as Record<string, unknown>).jsonataSync;
  if (typeof candidate === 'function') return candidate as JsonataCompiler;
  throw new Error(
    '[yaml-flow/compute-jsonata] Missing globalThis.jsonataSync. Load yaml-flow/browser/compute-jsonata.js before importing this browser path.',
  );
}

export function jsonata(expr: string): JsonataExpression {
  return resolveJsonataSync()(expr);
}

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
