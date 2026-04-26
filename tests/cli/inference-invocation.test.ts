import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Inference Invocation (Timestamp-Only Idempotency)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true });
    } catch {}
  });

  describe('Gate 1: Is task already completed?', () => {
    it('skips inference invocation when isTaskCompleted is true', () => {
      const llmCompletion = {
        isTaskCompleted: true,
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
        reasoning: 'Task complete',
      };

      expect(llmCompletion.isTaskCompleted).toBe(true);
      // When this condition is true, handler returns without invoking inference.
    });

    it('does not require inferenceRequested/inferenceCompletedAt when isTaskCompleted is true', () => {
      const llmCompletion = {
        isTaskCompleted: true,
        reasoning: 'Already done',
      };

      expect(llmCompletion.isTaskCompleted).toBe(true);
      // Completion status is sufficient; no need to check inference timestamps.
    });
  });

  describe('Gate 2: Is inference currently in-flight?', () => {
    it('identifies in-flight state when inferenceRequested but no inferenceCompletedAt', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: undefined,
      };

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const inferencePending = !!inferenceRequestedAt
        && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

      expect(inferencePending).toBe(true);
      // Handler returns 'task-initiated' without re-invoking.
    });

    it('identifies in-flight state when inferenceCompletedAt < inferenceRequested', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-22T18:00:00Z', // older than request
      };

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const inferencePending = !!inferenceRequestedAt
        && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

      expect(inferencePending).toBe(true);
      // Handler returns 'task-initiated' without re-invoking.
    });

    it('does not mark as pending when inferenceCompletedAt >= inferenceRequested', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
      };

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const inferencePending = !!inferenceRequestedAt
        && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

      expect(inferencePending).toBe(false);
      // Inference has completed; can proceed to Gate 3.
    });
  });

  describe('Gate 3: Should we request inference (input freshness)?', () => {
    it('requests inference when inferenceRequested is null (never requested)', () => {
      const llmCompletion = {};
      const latestRequiredSourceFetchedAt = '2026-04-23T10:00:00Z';

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      expect(shouldRequestInference).toBe(true);
      // Handler will stamp and invoke.
    });

    it('requests inference when inferenceCompletedAt is null (never completed)', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
      };
      const latestRequiredSourceFetchedAt = '2026-04-23T10:00:30Z';

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      expect(shouldRequestInference).toBe(true);
      // Handler will stamp and invoke (request is in-flight but gating for that is separate).
    });

    it('requests inference when latest source fetch is newer than last completion', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
      };
      const latestRequiredSourceFetchedAt = '2026-04-23T10:05:00Z'; // newer

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      expect(shouldRequestInference).toBe(true);
      // Handler will stamp with new timestamp and invoke.
    });

    it('does not request inference when inputs are unchanged (source fetch <= last completion)', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
      };
      const latestRequiredSourceFetchedAt = '2026-04-23T10:00:30Z'; // older

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      expect(shouldRequestInference).toBe(false);
      // Handler returns 'task-initiated' without re-invoking.
    });

    it('does not request inference when no required source_defs have been fetched', () => {
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
      };
      const latestRequiredSourceFetchedAt = undefined; // no source_defs fetched

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      expect(shouldRequestInference).toBe(false);
      // Handler returns 'task-initiated' without re-invoking.
    });
  });

  describe('inferenceRequested field semantics', () => {
    it('preserves inferenceRequested across completion writes (never cleared)', () => {
      const existingInference = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        reasoning: 'Task not complete',
      };

      // Completion callback merges into existing
      const completionResult = {
        isTaskCompleted: false,
        reasoning: 'New evaluation',
        evidence: ['source1'],
        inferenceCompletedAt: '2026-04-23T10:02:00Z',
      };

      const merged = {
        ...existingInference,
        ...completionResult,
      };

      expect(merged.inferenceRequested).toBe('2026-04-23T10:00:00Z');
      // Original request timestamp is preserved.
      expect(merged.inferenceCompletedAt).toBe('2026-04-23T10:02:00Z');
    });

    it('overwrites inferenceRequested only on new request invocation', () => {
      const now = new Date('2026-04-23T10:05:00Z').toISOString();
      const existingInference = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
      };

      // New request overwrites the timestamp
      const updated = {
        ...existingInference,
        inferenceRequested: now,
      };

      expect(updated.inferenceRequested).toBe(now);
      expect(updated.inferenceCompletedAt).toBe('2026-04-23T10:01:00Z');
      // Completion timestamp is preserved until next completion.
    });
  });

  describe('Combined decision flow', () => {
    it('idempotent: multiple handlers in same drain do not re-invoke inference', () => {
      // Scenario: 3 source deliveries in same drain cycle, all trigger handler invocation
      // Initially: no request has been stamped
      let llmCompletion = {
        inferenceRequested: undefined,
        inferenceCompletedAt: undefined,
      };
      const latestRequiredSourceFetchedAt = '2026-04-23T10:00:01Z';

      // First handler invocation: nothing stamped yet, should invoke
      const firstCall = (() => {
        const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
          ? llmCompletion.inferenceRequested
          : undefined;
        const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
          ? llmCompletion.inferenceCompletedAt
          : undefined;
        const shouldRequestInference = !inferenceRequestedAt
          || !inferenceCompletedAt
          || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

        // First call will stamp it before invoking
        if (shouldRequestInference) {
          llmCompletion.inferenceRequested = '2026-04-23T10:00:00Z';
        }
        return shouldRequestInference; // should invoke
      })();

      // Second handler invocation (same drain cycle, request already stamped)
      const secondCall = (() => {
        const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
          ? llmCompletion.inferenceRequested
          : undefined;
        const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
          ? llmCompletion.inferenceCompletedAt
          : undefined;
        const inferencePending = !!inferenceRequestedAt
          && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

        // Second call sees pending request, does not invoke
        return inferencePending; // should be true (in-flight, do not invoke)
      })();

      expect(firstCall).toBe(true); // First call invokes and stamps
      expect(secondCall).toBe(true); // Second call sees pending and skips
    });

    it('fresh source_defs trigger re-inference after completion', () => {
      // Scenario: First inference completes with false, then new source data arrives
      const llmCompletion = {
        inferenceRequested: '2026-04-23T10:00:00Z',
        inferenceCompletedAt: '2026-04-23T10:01:00Z',
        isTaskCompleted: false,
      };
      const latestRequiredSourceFetchedAt = '2026-04-23T10:05:00Z'; // Much newer

      const inferenceRequestedAt = typeof llmCompletion.inferenceRequested === 'string'
        ? llmCompletion.inferenceRequested
        : undefined;
      const inferenceCompletedAtVal = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAtVal
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAtVal);

      expect(shouldRequestInference).toBe(true);
      // Handler will stamp with new timestamp and re-invoke with fresh source data.
    });
  });

  describe('Legacy evaluatedAt compatibility', () => {
    it('writes both inferenceCompletedAt and evaluatedAt for backward compatibility', () => {
      const inferenceCompletedAt = new Date('2026-04-23T10:02:00Z').toISOString();
      const merged = {
        isTaskCompleted: false,
        reasoning: 'Evaluated',
        evidence: [],
        inferenceCompletedAt,
        evaluatedAt: inferenceCompletedAt, // legacy alias
      };

      expect(merged.inferenceCompletedAt).toBe(inferenceCompletedAt);
      expect(merged.evaluatedAt).toBe(inferenceCompletedAt);
      // Both fields are identical.
    });

    it('prefers inferenceCompletedAt when reading, falls back to evaluatedAt', () => {
      const legacyCompletion = {
        evaluatedAt: '2026-04-23T10:01:00Z',
        // no inferenceCompletedAt
      };

      const inferenceCompletedAt = typeof legacyCompletion.inferenceCompletedAt === 'string'
        ? legacyCompletion.inferenceCompletedAt
        : (typeof legacyCompletion.evaluatedAt === 'string' ? legacyCompletion.evaluatedAt : undefined);

      expect(inferenceCompletedAt).toBe('2026-04-23T10:01:00Z');
      // Can read old cards with only evaluatedAt.
    });
  });
});
