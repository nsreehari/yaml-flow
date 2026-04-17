import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initBoard, loadBoard, saveBoard } from '../../src/cli/board-live-cards.js';
import { createReactiveGraph, restore } from '../../src/continuous-event-graph/index.js';
import type { ReactiveGraph } from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/event-graph/types.js';

const ts = () => new Date().toISOString();
const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function makeConfig(): GraphConfig {
  return {
    settings: { completion: 'all-tasks-done', conflict_strategy: 'parallel-all' },
    tasks: {
      src: { provides: ['x'], taskHandlers: ['src'] },
      calc: { requires: ['x'], provides: ['y'], taskHandlers: ['calc'] },
    },
  } as GraphConfig;
}

describe('board-live-cards', () => {
  let tmpDir: string;
  let rg: ReactiveGraph | null = null;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
    return tmpDir;
  }

  afterEach(() => {
    rg?.dispose();
    rg = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initBoard creates dir and board-graph.json', () => {
    const dir = freshDir();
    const sub = path.join(dir, 'nested');
    initBoard(sub, makeConfig());

    expect(fs.existsSync(path.join(sub, 'board-graph.json'))).toBe(true);
    const snap = JSON.parse(fs.readFileSync(path.join(sub, 'board-graph.json'), 'utf-8'));
    expect(snap.version).toBe(1);
    expect(snap.config.tasks.src).toBeDefined();
    expect(snap.state.tasks.src.status).toBe('not-started');
  });

  it('loadBoard returns a LiveGraph from board-graph.json', () => {
    const dir = freshDir();
    initBoard(dir, makeConfig());

    const live = loadBoard(dir);
    expect(live.config.tasks.src).toBeDefined();
    expect(live.state.tasks.src.status).toBe('not-started');
  });

  it('full roundtrip: init → load → run → save → load → state preserved', async () => {
    const dir = freshDir();
    initBoard(dir, makeConfig());

    // Load and create reactive graph
    const live = loadBoard(dir);
    const gRef = { rg: null as ReactiveGraph | null };

    rg = createReactiveGraph(live, {
      handlers: {
        src: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { v: 1 }); return 'task-initiated'; },
        calc: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { result: 42 }); return 'task-initiated'; },
      },
    });
    gRef.rg = rg;

    // Drive the graph
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    expect(rg.getState().state.tasks.src.status).toBe('completed');
    expect(rg.getState().state.tasks.calc.status).toBe('completed');

    // Save
    saveBoard(dir, rg);
    rg.dispose();

    // Load again — state should be intact
    const live2 = loadBoard(dir);
    expect(live2.state.tasks.src.status).toBe('completed');
    expect(live2.state.tasks.src.data).toEqual({ v: 1 });
    expect(live2.state.tasks.calc.status).toBe('completed');
    expect(live2.state.tasks.calc.data).toEqual({ result: 42 });

    // Can create a new reactive graph from it and continue
    rg = createReactiveGraph(live2, {
      handlers: {
        src: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { v: 2 }); return 'task-initiated'; },
        calc: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { result: 99 }); return 'task-initiated'; },
      },
    });
    gRef.rg = rg;

    // Push new data
    rg.push({ type: 'task-completed', taskName: 'src', data: { v: 2 }, timestamp: ts() });
    await ticks(100);

    expect(rg.getState().state.tasks.calc.data).toEqual({ result: 99 });

    saveBoard(dir, rg);
    const live3 = loadBoard(dir);
    expect(live3.state.tasks.calc.data).toEqual({ result: 99 });
  });
});
