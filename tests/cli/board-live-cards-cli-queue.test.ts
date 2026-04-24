import { describe, expect, it } from 'vitest';
import {
  decideSourceAction,
  isSourceInFlight,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
  type SourceRuntimeEntry,
} from '../../src/cli/board-live-cards-cli.js';

describe('board-live-cards-cli queueRequestedAt-based dispatch helpers', () => {
  it('dispatches when no entry exists', () => {
    expect(decideSourceAction(undefined, '2026-04-23T10:00:05.000Z')).toBe('dispatch');
  });

  it('returns in-flight when lastRequestedAt set but no lastFetchedAt yet', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
    };
    expect(decideSourceAction(entry, '2026-04-23T10:00:05.000Z')).toBe('in-flight');
  });

  it('returns in-flight when fetch is still running (lastRequestedAt > lastFetchedAt)', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:03.000Z',
      lastFetchedAt: '2026-04-23T10:00:01.000Z',
    };
    expect(decideSourceAction(entry, '2026-04-23T10:00:05.000Z')).toBe('in-flight');
  });

  it('dispatches when fetch completed before queueRequestedAt (stale result)', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:02.000Z',
      queueRequestedAt: '2026-04-23T10:00:04.000Z',
    };
    // lastFetchedAt (T+2) < queueRequestedAt (T+4) → need another fetch
    expect(decideSourceAction(entry, entry.queueRequestedAt!)).toBe('dispatch');
  });

  it('returns idle when fetch already completed for the current run', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:04.000Z',
      lastFetchedAt: '2026-04-23T10:00:05.000Z',
      queueRequestedAt: '2026-04-23T10:00:03.000Z',
    };
    // lastFetchedAt (T+5) >= queueRequestedAt (T+3) → already served
    expect(decideSourceAction(entry, entry.queueRequestedAt!)).toBe('idle');
  });

  it('isSourceInFlight reflects request/fetch timestamps correctly', () => {
    expect(isSourceInFlight(undefined)).toBe(false);
    expect(isSourceInFlight({ lastRequestedAt: '2026-04-23T10:00:01.000Z' })).toBe(true);
    expect(isSourceInFlight({
      lastRequestedAt: '2026-04-23T10:00:03.000Z',
      lastFetchedAt: '2026-04-23T10:00:01.000Z',
    })).toBe(true);
    expect(isSourceInFlight({
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:03.000Z',
    })).toBe(false);
  });

  it('nextEntryAfterFetchDelivery marks completion; stale queueRequestedAt triggers re-dispatch on next evaluation', () => {
    // queueRequestedAt was updated mid-flight to T+4 while the fetch was already in-flight for T+1
    const inFlight: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:00.000Z',
      queueRequestedAt: '2026-04-23T10:00:04.000Z', // updated mid-flight
    };

    const delivered = nextEntryAfterFetchDelivery(inFlight, '2026-04-23T10:00:02.000Z');
    expect(delivered.lastFetchedAt).toBe('2026-04-23T10:00:02.000Z');
    expect(isSourceInFlight(delivered)).toBe(false);
    // lastFetchedAt (T+2) < queueRequestedAt (T+4) → next card-handler will dispatch again
    expect(decideSourceAction(delivered, delivered.queueRequestedAt!)).toBe('dispatch');
  });

  it('nextEntryAfterFetchDelivery is idle when queueRequestedAt was not updated mid-flight', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:00.000Z',
      queueRequestedAt: '2026-04-23T10:00:01.000Z', // same as when dispatched
    };

    const delivered = nextEntryAfterFetchDelivery(entry, '2026-04-23T10:00:02.000Z');
    // lastFetchedAt (T+2) >= queueRequestedAt (T+1) → idle
    expect(decideSourceAction(delivered, delivered.queueRequestedAt!)).toBe('idle');
  });

  it('nextEntryAfterFetchFailure clears lastFetchedAt and records error', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedAt: '2026-04-23T10:00:01.000Z',
      lastFetchedAt: '2026-04-23T10:00:00.000Z',
    };
    const failed = nextEntryAfterFetchFailure(entry, 'network timeout');
    expect(failed.lastError).toContain('timeout');
    expect(failed.lastFetchedAt).toBeUndefined();
  });
});
