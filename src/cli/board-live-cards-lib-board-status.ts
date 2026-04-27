/**
 * board-live-cards-lib — Board status object builder.
 *
 * Pure computation on a LiveGraph snapshot — no Node built-ins.
 * Safe for neutral/V8 (PyMiniRacer) compilation.
 */

import type { LiveGraph } from '../continuous-event-graph/types.js';
import { schedule } from '../continuous-event-graph/schedule.js';

// ============================================================================
// Public types
// ============================================================================

export interface BoardStatusCard {
  name: string;
  status: string;
  error?: {
    message: string;
    code?: string;
    at?: string;
    source?: 'task-runtime' | 'source-fetch' | 'timeout' | 'unknown';
  };
  requires: string[];
  requires_satisfied: string[];
  requires_missing: string[];
  provides_declared: string[];
  provides_runtime: string[];
  blocked_by: string[];
  unblocks: string[];
  runtime: {
    attempt_count: number;
    restart_count: number;
    in_progress_since: string | null;
    last_transition_at: string | null;
    last_completed_at: string | null;
    last_restarted_at: string | null;
    status_age_ms: number | null;
  };
}

export interface BoardStatusObject {
  schema_version: 'v1';
  meta: {
    board: {
      /** Absolute path to the board directory (resolved by caller). */
      path: string;
    };
  };
  summary: {
    card_count: number;
    completed: number;
    eligible: number;
    pending: number;
    blocked: number;
    unresolved: number;
    failed?: number;
    in_progress?: number;
    orphan_cards?: number;
    topology?: {
      edge_count: number;
      max_fan_out_card: string | null;
      max_fan_out: number;
    };
  };
  cards: BoardStatusCard[];
}

// ============================================================================
// Pure function — no I/O
// ============================================================================

/**
 * Build a BoardStatusObject from a LiveGraph snapshot.
 *
 * @param boardPath - Absolute path to the board directory (caller resolves).
 *                    The lib does not resolve paths; this keeps the function Node-free.
 * @param live      - LiveGraph snapshot (already restored from board-graph.json).
 */
export function buildBoardStatusObject(boardPath: string, live: LiveGraph): BoardStatusObject {
  const taskState = live.state.tasks;
  const taskConfig = live.config.tasks;
  const cardNames = Object.keys(taskState);
  const sched = schedule(live);

  const statusCounts = {
    completed: 0,
    failed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    unresolved: 0,
  };

  const waitingByCard = new Map<string, string[]>();
  for (const p of sched.pending) waitingByCard.set(p.taskName, p.waitingOn);
  for (const u of sched.unresolved) waitingByCard.set(u.taskName, u.missingTokens);
  for (const b of sched.blocked) waitingByCard.set(b.taskName, b.failedTokens);

  const dependentsByToken = new Map<string, string[]>();
  for (const [name, cfg] of Object.entries(taskConfig)) {
    for (const token of cfg.requires ?? []) {
      const dependents = dependentsByToken.get(token) ?? [];
      dependents.push(name);
      dependentsByToken.set(token, dependents);
    }
  }

  const cards: BoardStatusCard[] = cardNames.sort().map((name) => {
    const state = taskState[name] as {
      status: string;
      data?: Record<string, unknown>;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      lastUpdated?: string;
      executionCount?: number;
      retryCount?: number;
    };
    const cfg = taskConfig[name] ?? { requires: [], provides: [] };

    if (state.status === 'completed') statusCounts.completed += 1;
    else if (state.status === 'failed') statusCounts.failed += 1;
    else if (state.status === 'in-progress') statusCounts.in_progress += 1;

    const requires = cfg.requires ?? [];
    const provides = cfg.provides ?? [];
    const runtimeKeys = Object.keys(state.data ?? {}).sort();
    const requiresSatisfied = requires.filter(token => live.state.availableOutputs.includes(token));
    const requiresMissing = requires.filter(token => !live.state.availableOutputs.includes(token));
    const blockedBy = waitingByCard.get(name) ?? requiresMissing;

    const unblocks = new Set<string>();
    for (const token of provides) {
      for (const dependent of dependentsByToken.get(token) ?? []) {
        if (dependent !== name) unblocks.add(dependent);
      }
    }

    const lastFailureAt = state.failedAt;
    const error = state.error
      ? {
          message: state.error,
          code: 'TASK_FAILED',
          at: lastFailureAt,
          source: 'task-runtime' as const,
        }
      : undefined;

    return {
      name,
      status: state.status,
      error,
      requires,
      requires_satisfied: requiresSatisfied,
      requires_missing: requiresMissing,
      provides_declared: provides,
      provides_runtime: runtimeKeys,
      blocked_by: blockedBy,
      unblocks: Array.from(unblocks).sort(),
      runtime: {
        attempt_count: state.executionCount ?? 0,
        restart_count: state.retryCount ?? 0,
        in_progress_since: state.status === 'in-progress' ? (state.startedAt ?? null) : null,
        last_transition_at: state.lastUpdated ?? null,
        last_completed_at: state.completedAt ?? null,
        last_restarted_at: state.startedAt ?? null,
        status_age_ms: state.lastUpdated ? Math.max(0, Date.now() - Date.parse(state.lastUpdated)) : null,
      },
    };
  });

  statusCounts.pending = sched.pending.length;
  statusCounts.blocked = sched.blocked.length;
  statusCounts.unresolved = sched.unresolved.length;

  const fanOut = cards
    .map(c => ({ name: c.name, fanOut: c.unblocks.length }))
    .sort((a, b) => b.fanOut - a.fanOut || a.name.localeCompare(b.name));
  const maxFanOut = fanOut.length > 0 ? fanOut[0] : { name: null, fanOut: 0 };

  const allRequires = new Set<string>();
  for (const cfg of Object.values(taskConfig)) {
    for (const r of cfg.requires ?? []) allRequires.add(r);
  }
  let orphanCards = 0;
  for (const [name, cfg] of Object.entries(taskConfig)) {
    const requiresNone = (cfg.requires ?? []).length === 0;
    const providesList = cfg.provides ?? [];
    const feedsAny = providesList.some(p => (dependentsByToken.get(p) ?? []).some(d => d !== name));
    if (requiresNone && !feedsAny) orphanCards += 1;
  }

  return {
    schema_version: 'v1',
    meta: {
      board: {
        path: boardPath,
      },
    },
    summary: {
      card_count: cardNames.length,
      completed: statusCounts.completed,
      eligible: sched.eligible.length,
      pending: statusCounts.pending,
      blocked: statusCounts.blocked,
      unresolved: statusCounts.unresolved,
      failed: statusCounts.failed,
      in_progress: statusCounts.in_progress,
      orphan_cards: orphanCards,
      topology: {
        edge_count: Array.from(allRequires).length,
        max_fan_out_card: maxFanOut.name,
        max_fan_out: maxFanOut.fanOut,
      },
    },
    cards,
  };
}
