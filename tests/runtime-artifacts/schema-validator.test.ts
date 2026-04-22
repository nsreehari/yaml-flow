import { describe, expect, it } from 'vitest';

import {
  validateBoardStatusSchema,
  validateCardRuntimeSchema,
} from '../../src/runtime-artifacts/index.js';

describe('runtime artifact schema validators', () => {
  it('accepts a valid board status object', () => {
    const result = validateBoardStatusSchema({
      schema_version: 'v1',
      meta: { board: { path: '/tmp/board' } },
      summary: {
        card_count: 1,
        completed: 1,
        eligible: 0,
        pending: 0,
        blocked: 0,
        unresolved: 0,
        failed: 0,
        in_progress: 0,
        orphan_cards: 0,
        topology: {
          edge_count: 0,
          max_fan_out_card: null,
          max_fan_out: 0,
        },
      },
      cards: [{
        name: 'card-a',
        status: 'completed',
        requires: [],
        requires_satisfied: [],
        requires_missing: [],
        provides_declared: ['card-a'],
        provides_runtime: ['card-a'],
        blocked_by: [],
        unblocks: [],
        runtime: {
          attempt_count: 1,
          restart_count: 0,
          in_progress_since: null,
          last_transition_at: null,
          last_completed_at: null,
          last_restarted_at: null,
          status_age_ms: 0,
        },
      }],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an invalid board status object', () => {
    const result = validateBoardStatusSchema({
      schema_version: 'v2',
      meta: {},
      summary: {},
      cards: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid card runtime artifact', () => {
    const result = validateCardRuntimeSchema({
      schema_version: 'v1',
      card_id: 'card-example',
      computed_values: { total: 35, rows: [{ id: 'A' }, { id: 'B' }] },
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a card runtime artifact with empty computed_values', () => {
    const result = validateCardRuntimeSchema({
      schema_version: 'v1',
      card_id: 'card-example',
      computed_values: {},
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a card runtime artifact missing required fields', () => {
    const result = validateCardRuntimeSchema({ schema_version: 'v1' });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object card runtime artifact', () => {
    const result = validateCardRuntimeSchema(['not', 'an', 'object']);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
