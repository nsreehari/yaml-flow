/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 *
 * Library:
 *   initBoard(dir)     — create dir + board-graph.json (idempotent)
 *   loadBoard(dir)     — read board-graph.json → LiveGraph
 *   saveBoard(dir, rg) — rg.snapshot() → write board-graph.json
 *
 * CLI:
 *   board-live-cards init <dir>
 *   board-live-cards status --rg <dir>
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { ReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import { schedule } from '../continuous-event-graph/schedule.js';
import type { GraphConfig } from '../event-graph/types.js';

const BOARD_FILE = 'board-graph.json';
const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'all-tasks-done' }, tasks: {} } as GraphConfig;

// ============================================================================
// Library
// ============================================================================

/**
 * Initialize a board directory.
 * - Dir doesn't exist → create it, write empty board-graph.json
 * - Dir exists + valid board-graph.json → no-op, return 'exists'
 * - Dir exists + non-empty (no valid board-graph.json) → throw
 */
export function initBoard(dir: string): 'created' | 'exists' {
  const boardPath = path.join(dir, BOARD_FILE);

  if (fs.existsSync(boardPath)) {
    // Validate it's a real board
    restore(JSON.parse(fs.readFileSync(boardPath, 'utf-8')));
    return 'exists';
  }

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`Directory "${dir}" is not empty and has no valid ${BOARD_FILE}`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const live = createLiveGraph(EMPTY_CONFIG);
  const snap = snapshot(live);
  fs.writeFileSync(boardPath, JSON.stringify(snap, null, 2));
  return 'created';
}

export function loadBoard(dir: string): LiveGraph {
  const raw = fs.readFileSync(path.join(dir, BOARD_FILE), 'utf-8');
  return restore(JSON.parse(raw));
}

export function saveBoard(dir: string, rg: ReactiveGraph): void {
  const snap = rg.snapshot();
  fs.writeFileSync(path.join(dir, BOARD_FILE), JSON.stringify(snap, null, 2));
}

// ============================================================================
// CLI
// ============================================================================

function cmdInit(args: string[]): void {
  const dir = args[0];
  if (!dir) { console.error('Usage: board-live-cards init <dir>'); process.exit(1); }

  const result = initBoard(dir);
  if (result === 'exists') {
    console.log(`Board already initialized at ${path.resolve(dir)}`);
  } else {
    console.log(`Board initialized at ${path.resolve(dir)}`);
  }
}

function cmdStatus(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  if (!dir) { console.error('Usage: board-live-cards status --rg <dir>'); process.exit(1); }

  const live = loadBoard(dir);
  const tasks = live.state.tasks;
  const taskNames = Object.keys(tasks);
  const sched = schedule(live);

  console.log(`Board: ${path.resolve(dir)}`);
  console.log(`Tasks: ${taskNames.length}`);
  console.log('');

  for (const name of taskNames.sort()) {
    const t = tasks[name];
    const dataKeys = t.data ? Object.keys(t.data).join(', ') : '';
    console.log(`  ${t.status.padEnd(12)} ${name}${dataKeys ? ` — [${dataKeys}]` : ''}`);
  }

  console.log('');
  console.log(`Schedule: ${sched.eligible.length} eligible, ${sched.pending.length} pending, ${sched.blocked.length} blocked, ${sched.unresolved.length} unresolved`);
}

export function cli(argv: string[]): void {
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'init':   return cmdInit(rest);
    case 'status': return cmdStatus(rest);
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: init, status');
      process.exit(1);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2));
}
