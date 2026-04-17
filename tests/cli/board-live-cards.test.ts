import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initBoard, loadBoard, saveBoard, cli } from '../../src/cli/board-live-cards.js';
import { createReactiveGraph, createLiveGraph, snapshot } from '../../src/continuous-event-graph/index.js';
import type { ReactiveGraph } from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/event-graph/types.js';

const ts = () => new Date().toISOString();
const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
    const result = initBoard(sub);

    expect(result).toBe('created');
    expect(fs.existsSync(path.join(sub, 'board-graph.json'))).toBe(true);
    const snap = JSON.parse(fs.readFileSync(path.join(sub, 'board-graph.json'), 'utf-8'));
    expect(snap.version).toBe(1);
    expect(Object.keys(snap.config.tasks)).toHaveLength(0);
  });

  it('initBoard is idempotent — returns exists on second call', () => {
    const dir = freshDir();
    const sub = path.join(dir, 'nested');
    expect(initBoard(sub)).toBe('created');
    expect(initBoard(sub)).toBe('exists');
  });

  it('initBoard throws if dir is non-empty without valid board-graph.json', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'some-file.txt'), 'hello');

    expect(() => initBoard(dir)).toThrow('not empty');
  });

  it('loadBoard returns a LiveGraph from board-graph.json', () => {
    const dir = freshDir();
    initBoard(path.join(dir, 'b'));

    const live = loadBoard(path.join(dir, 'b'));
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('full roundtrip: init → addNode → run → save → load → state preserved', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const live = loadBoard(dir);
    const gRef = { rg: null as ReactiveGraph | null };

    rg = createReactiveGraph(live, {
      handlers: {
        src: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { v: 1 }); return 'task-initiated'; },
        calc: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { result: 42 }); return 'task-initiated'; },
      },
    });
    gRef.rg = rg;

    // Add tasks dynamically (since init creates an empty board)
    rg.addNode('src', { provides: ['x'], taskHandlers: ['src'] } as any);
    rg.addNode('calc', { requires: ['x'], provides: ['y'], taskHandlers: ['calc'] } as any);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    expect(rg.getState().state.tasks.src.status).toBe('completed');
    expect(rg.getState().state.tasks.calc.status).toBe('completed');

    saveBoard(dir, rg);
    rg.dispose();

    // Load again — state intact
    const live2 = loadBoard(dir);
    expect(live2.state.tasks.src.status).toBe('completed');
    expect(live2.state.tasks.src.data).toEqual({ v: 1 });
    expect(live2.state.tasks.calc.status).toBe('completed');
    expect(live2.state.tasks.calc.data).toEqual({ result: 42 });
  });
});

// ============================================================================
// CLI commands
// ============================================================================

describe('board-live-cards CLI', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cli init <dir> creates an empty board', () => {
    const dir = path.join(freshDir(), 'myboard');
    cli(['init', dir]);

    expect(fs.existsSync(path.join(dir, 'board-graph.json'))).toBe(true);
    const live = loadBoard(dir);
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('cli init <dir> twice is idempotent', () => {
    const dir = path.join(freshDir(), 'myboard');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    cli(['init', dir]);
    cli(['init', dir]);
    spy.mockRestore();

    expect(logs[0]).toContain('initialized');
    expect(logs[1]).toContain('already initialized');
  });

  it('cli status --rg <dir> prints task info', () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    cli(['status', '--rg', dir]);
    spy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Tasks: 0');
    expect(output).toContain('0 eligible');
  });
});
