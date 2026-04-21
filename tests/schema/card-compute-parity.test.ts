import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import jsonata from 'jsonata';

import { CardCompute as ServerCardCompute } from '../../src/card-compute/index.js';
import type { ComputeNode, ValidationResult } from '../../src/card-compute/index.js';

type BrowserCardComputeApi = {
  run: (node: ComputeNode, options?: { sourcesData?: Record<string, unknown> }) => Promise<ComputeNode>;
  eval: (expr: string, node: ComputeNode) => Promise<unknown>;
  resolve: (node: ComputeNode, path: string) => unknown;
  validate: (node: unknown) => ValidationResult;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserCardComputePath = path.join(repoRoot, 'browser', 'card-compute.js');

function loadBrowserCardCompute(): BrowserCardComputeApi {
  // Browser bundle expects jsonata as a global; mirror browser runtime in Node tests.
  (globalThis as Record<string, unknown>).jsonata = jsonata;
  delete (globalThis as Record<string, unknown>).CardCompute;

  const source = fs.readFileSync(browserCardComputePath, 'utf-8');
  vm.runInThisContext(source, { filename: browserCardComputePath });

  const browserApi = (globalThis as Record<string, unknown>).CardCompute;
  if (!browserApi || typeof browserApi !== 'object') {
    throw new Error('Failed to load browser CardCompute API');
  }
  return browserApi as BrowserCardComputeApi;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('card-compute parity', () => {
  it('keeps server and browser run/eval/resolve/validate behavior in sync', async () => {
    const BrowserCardCompute = loadBrowserCardCompute();

    const baseNode: ComputeNode = {
      id: 'parity-card',
      card_data: { prices: [{ p: 100 }, { p: 50 }], qty: 3 },
      requires: { fee: 2 },
      compute: [
        { bindTo: 'subtotal', expr: '$sum(card_data.prices.p)' },
        { bindTo: 'total', expr: 'computed_values.subtotal * card_data.qty + requires.fee + $sum(sources.adjustments)' },
      ],
    };
    const options = { sourcesData: { adjustments: [1, 4] } };

    const serverNode = deepClone(baseNode);
    const browserNode = deepClone(baseNode);

    await ServerCardCompute.run(serverNode, options);
    await BrowserCardCompute.run(browserNode, options);

    expect(browserNode.computed_values).toEqual(serverNode.computed_values);
    expect(BrowserCardCompute.resolve(browserNode, 'computed_values.total')).toEqual(
      ServerCardCompute.resolve(serverNode, 'computed_values.total'),
    );
    expect(BrowserCardCompute.resolve(browserNode, 'sources.adjustments')).toEqual(
      ServerCardCompute.resolve(serverNode, 'sources.adjustments'),
    );

    const expr = 'computed_values.total - requires.fee';
    await expect(BrowserCardCompute.eval(expr, browserNode)).resolves.toEqual(
      await ServerCardCompute.eval(expr, serverNode),
    );

    const invalidNode = {
      id: '',
      card_data: { status: 'invalid-status' },
      compute: [{ bindTo: '', expr: '' }],
      view: { elements: [{ kind: 'not-a-real-kind' }] },
      unknown_field: true,
    };

    expect(BrowserCardCompute.validate(invalidNode)).toEqual(ServerCardCompute.validate(invalidNode));
  });
});
