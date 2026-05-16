import { describe, expect, it } from 'vitest';
import {
  decideSourceAction,
  isSourceInFlight,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
  type SourceRuntimeEntry,
} from '../../src/cli/common/board-live-cards-lib.js';

describe('board-live-cards-cli queueRequestedToken-based dispatch helpers', () => {
  it('dispatches when no entry exists', () => {
    expect(decideSourceAction(undefined, '2026-04-23T10:00:05.000Z')).toBe('dispatch');
  });

  it('returns in-flight when lastRequestedToken set but no lastCompletedToken yet', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:01.000Z',
    };
    expect(decideSourceAction(entry, '2026-04-23T10:00:05.000Z')).toBe('in-flight');
  });

  it('returns in-flight when the latest dispatch has not yet reached a terminal outcome', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:03.000Z',
      lastCompletedToken: '2026-04-23T10:00:01.000Z',
      lastCompletionStatus: 'success',
    };
    expect(decideSourceAction(entry, '2026-04-23T10:00:05.000Z')).toBe('in-flight');
  });

  it('dispatches when the latest terminal cycle is older than queueRequestedToken', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:02.000Z',
      lastCompletedToken: '2026-04-23T10:00:02.000Z',
      lastCompletionStatus: 'success',
      queueRequestedToken: '2026-04-23T10:00:04.000Z',
    };
    // lastCompletedToken (T+2) < queueRequestedToken (T+4) → need another fetch
    expect(decideSourceAction(entry, entry.queueRequestedToken!)).toBe('dispatch');
  });

  it('returns idle when fetch already completed for the current run', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:05.000Z',
      lastCompletedToken: '2026-04-23T10:00:05.000Z',
      lastCompletionStatus: 'success',
      queueRequestedToken: '2026-04-23T10:00:03.000Z',
    };
    // lastCompletedToken (T+5) >= queueRequestedToken (T+3) → already served
    expect(decideSourceAction(entry, entry.queueRequestedToken!)).toBe('idle');
  });

  it('isSourceInFlight reflects request/completion tokens correctly', () => {
    expect(isSourceInFlight(undefined)).toBe(false);
    expect(isSourceInFlight({ lastRequestedToken: '2026-04-23T10:00:01.000Z' })).toBe(true);
    expect(isSourceInFlight({
      lastRequestedToken: '2026-04-23T10:00:03.000Z',
      lastCompletedToken: '2026-04-23T10:00:01.000Z',
      lastCompletionStatus: 'success',
    })).toBe(true);
    expect(isSourceInFlight({
      lastRequestedToken: '2026-04-23T10:00:01.000Z',
      lastCompletedToken: '2026-04-23T10:00:01.000Z',
      lastCompletionStatus: 'success',
    })).toBe(false);
  });

  it('nextEntryAfterFetchDelivery marks completion; stale queueRequestedToken triggers re-dispatch on next evaluation', () => {
    // queueRequestedToken was updated mid-flight to T+4 while the fetch was already in-flight for T+1
    const inFlight: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:01.000Z',
      lastCompletedToken: '2026-04-23T10:00:00.000Z',
      lastCompletionStatus: 'success',
      queueRequestedToken: '2026-04-23T10:00:04.000Z', // updated mid-flight
    };

    const delivered = nextEntryAfterFetchDelivery(inFlight, '2026-04-23T10:00:01.000Z');
    expect(delivered.lastCompletedToken).toBe('2026-04-23T10:00:01.000Z');
    expect(delivered.lastCompletionStatus).toBe('success');
    expect(isSourceInFlight(delivered)).toBe(false);
    // lastCompletedToken (T+1) < queueRequestedToken (T+4) → next card-handler will dispatch again
    expect(decideSourceAction(delivered, delivered.queueRequestedToken!)).toBe('dispatch');
  });

  it('nextEntryAfterFetchDelivery is idle when queueRequestedToken was not updated mid-flight', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:01.000Z',
      lastCompletedToken: '2026-04-23T10:00:00.000Z',
      lastCompletionStatus: 'success',
      queueRequestedToken: '2026-04-23T10:00:01.000Z', // same as when dispatched
    };

    const delivered = nextEntryAfterFetchDelivery(entry, '2026-04-23T10:00:01.000Z');
    // lastCompletedToken (T+1) >= queueRequestedToken (T+1) → idle
    expect(decideSourceAction(delivered, delivered.queueRequestedToken!)).toBe('idle');
  });

  it('nextEntryAfterFetchFailure marks terminal failure', () => {
    const entry: SourceRuntimeEntry = {
      lastRequestedToken: '2026-04-23T10:00:01.000Z',
      lastCompletedToken: '2026-04-23T10:00:00.000Z',
      lastCompletionStatus: 'success',
    };
    const failed = nextEntryAfterFetchFailure(entry, '2026-04-23T10:00:01.000Z');
    expect(failed.lastCompletedToken).toBe('2026-04-23T10:00:01.000Z');
    expect(failed.lastCompletionStatus).toBe('failure');
  });
});
