import { describe, expect, it } from 'vitest';
import {
  buildRequiredSourceChecksums,
  decideRequiredSourceAction,
  hasSourceChecksumChanged,
  isSourceInFlight,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
  normalizeSourcePayloadForChecksum,
  type SourceRuntimeEntry,
} from '../../src/cli/board-live-cards-cli.js';

describe('board-live-cards-cli queue/checksum helpers', () => {
  it('classifies source actions from runtime entry state', () => {
    const noEntry = undefined;
    expect(decideRequiredSourceAction(noEntry, 'abc')).toBe('dispatch');

    const requestedNotFetched: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:00.000Z',
    };
    expect(decideRequiredSourceAction(requestedNotFetched, 'abc')).toBe('dispatch');

    const inFlightSameChecksum: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:02.000Z',
      lastFetchedAt: '2026-04-23T10:00:01.000Z',
      lastInputChecksum: 'same',
    };
    expect(decideRequiredSourceAction(inFlightSameChecksum, 'same')).toBe('idle');

    const inFlightChangedChecksum: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:02.000Z',
      lastFetchedAt: '2026-04-23T10:00:01.000Z',
      lastInputChecksum: 'old',
    };
    expect(decideRequiredSourceAction(inFlightChangedChecksum, 'new')).toBe('queue');

    const deliveredChangedChecksum: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:02.000Z',
      lastInputChecksum: 'old',
    };
    expect(decideRequiredSourceAction(deliveredChangedChecksum, 'new')).toBe('dispatch');

    const deliveredSameChecksum: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:02.000Z',
      lastInputChecksum: 'same',
    };
    expect(decideRequiredSourceAction(deliveredSameChecksum, 'same')).toBe('idle');
  });

  it('normalizes checksum payload by stripping execution-only context and self output data', () => {
    const payload = {
      cli: 'node ../fetch-prices.js',
      bindTo: 'prices',
      outputFile: 'prices.json',
      cwd: 'C:/tmp/cards',
      boardDir: 'C:/tmp/board-runtime',
      _requires: { holdings: [{ symbol: 'AAPL', qty: 50 }] },
      _sourcesData: {
        prices: { AAPL: 100.0 },
        unrelated: { marker: true },
      },
    };

    const normalized = normalizeSourcePayloadForChecksum(payload) as Record<string, unknown>;
    expect(normalized.cwd).toBeUndefined();
    expect(normalized.boardDir).toBeUndefined();
    expect((normalized._sourcesData as Record<string, unknown>).prices).toBeUndefined();
    expect((normalized._sourcesData as Record<string, unknown>).unrelated).toEqual({ marker: true });
  });

  it('produces stable checksums across path-format changes and ignores self prices payload', () => {
    const requiredSources = [{ bindTo: 'prices', outputFile: 'prices.json' }] as any[];

    const sourcePayloadA = {
      bindTo: 'prices',
      outputFile: 'prices.json',
      cli: 'node ../fetch-prices.js',
      cwd: 'C:\\tmp\\cards',
      boardDir: 'C:\\tmp\\board-runtime',
      _requires: { holdings: [{ symbol: 'AAPL', qty: 50 }, { symbol: 'MSFT', qty: 30 }] },
      _sourcesData: { prices: { AAPL: 111.11 } },
      _computed_values: {},
    };

    const sourcePayloadB = {
      ...sourcePayloadA,
      cwd: 'C:/tmp/cards',
      boardDir: 'C:/tmp/board-runtime',
      _sourcesData: { prices: { AAPL: 999.99 } },
    };

    const checksumsA = buildRequiredSourceChecksums(requiredSources as any, new Map([['prices.json', sourcePayloadA]]));
    const checksumsB = buildRequiredSourceChecksums(requiredSources as any, new Map([['prices.json', sourcePayloadB]]));

    expect(checksumsA['prices.json']).toBe(checksumsB['prices.json']);
  });

  it('transitions entry state on fetch success/failure with queue semantics', () => {
    const inFlightWithQueued: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:00.000Z',
      lastInputChecksum: 'old',
      queuedInputChecksum: 'new',
    };

    const delivered = nextEntryAfterFetchDelivery(inFlightWithQueued, '2026-04-23T10:00:02.000Z', 'old');
    expect(delivered.lastFetchedAt).toBe('2026-04-23T10:00:02.000Z');
    expect(delivered.lastInputChecksum).toBe('new');
    expect(delivered.queuedInputChecksum).toBeUndefined();
    expect(isSourceInFlight(delivered)).toBe(true);
    expect(hasSourceChecksumChanged(delivered, 'new')).toBe(false);

    const failed = nextEntryAfterFetchFailure(delivered, 'network timeout');
    expect(failed.lastError).toContain('timeout');
    expect(failed.lastFetchedAt).toBeUndefined();
  });
});
