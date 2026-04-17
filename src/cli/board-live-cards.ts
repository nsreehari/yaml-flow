/**
 * Board Live Cards — Disk persistence for ReactiveGraph.
 *
 * Three operations:
 *   initBoard(dir)     — create dir + empty board-graph.json
 *   loadBoard(dir)     — read board-graph.json → LiveGraph
 *   saveBoard(dir, rg) — rg.snapshot() → write board-graph.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { ReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import type { GraphConfig } from '../event-graph/types.js';

const BOARD_FILE = 'board-graph.json';

export function initBoard(dir: string, config: GraphConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const live = createLiveGraph(config);
  const snap = snapshot(live);
  fs.writeFileSync(path.join(dir, BOARD_FILE), JSON.stringify(snap, null, 2));
}

export function loadBoard(dir: string): LiveGraph {
  const raw = fs.readFileSync(path.join(dir, BOARD_FILE), 'utf-8');
  return restore(JSON.parse(raw));
}

export function saveBoard(dir: string, rg: ReactiveGraph): void {
  const snap = rg.snapshot();
  fs.writeFileSync(path.join(dir, BOARD_FILE), JSON.stringify(snap, null, 2));
}
