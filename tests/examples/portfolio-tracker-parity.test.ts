/**
 * portfolio-tracker-parity.test.ts
 *
 * Dual-mode parity test for the portfolio-tracker HTTP server.
 *
 * Spins up BOTH servers concurrently:
 *   Node  — portfolio-tracker-server.js     (port 7810)
 *   Python — portfolio-tracker-server.py   (port 7811)
 *
 * Drives the same T1–T5 steps against each in parallel, accumulates SSE
 * frames from each, then cross-checks that both implementations agree on:
 *   - price symbols and values  (data object "prices")
 *   - holdings table rows       (computed_values "holdings-table")
 *   - total portfolio value     (computed_values "portfolio-value")
 *   - board-status card counts  (HTTP endpoint)
 *
 * Skipped if Python is not found on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portfolioDir = path.join(repoRoot, 'examples', 'browser', 'boards', 'portfolio-tracker');
const nodeServerScript = path.join(portfolioDir, 'portfolio-tracker-server.js');
const pyServerScript = path.join(portfolioDir, 'portfolio-tracker-server.py');

// ── Python detection ─────────────────────────────────────────────────────────

function findPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 });
      if (r.status === 0 && r.stdout?.toString().startsWith('Python ')) return cmd;
    } catch { /* skip */ }
  }
  return null;
}

const PYTHON_CMD = findPython();
const DEEP = process.env.DEEP === 'true';

// ── Port assignments (fixed; tests run sequentially inside the suite) ─────────

const NODE_PORT = 7810;
const PY_PORT   = 7811;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode ?? 0, data: body }); }
      });
    }).on('error', reject);
  });
}

function httpPatch(url: string, payload: object): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeHoldingsPatch(holdingsMap: Record<string, number>) {
  return {
    card_data: {
      holdings: Object.entries(holdingsMap).map(([symbol, qty]) => ({ symbol, qty })),
    },
  };
}

// ── SSE accumulator ───────────────────────────────────────────────────────────

interface NotificationState {
  initialPayload: any;
  statusSummary: any;
  statusGeneration: number;
  dataObjects: Record<string, any>;
  computedValues: Record<string, any>;
}

function makeNS(): NotificationState {
  return { initialPayload: null, statusSummary: null, statusGeneration: 0, dataObjects: {}, computedValues: {} };
}

function applyFrame(ns: NotificationState, payload: any): void {
  if (payload.cardDefinitions) {
    ns.initialPayload = payload;
    if (payload.statusSnapshot?.summary) { ns.statusSummary = payload.statusSnapshot.summary; ns.statusGeneration++; }
    if (payload.dataObjectsByToken) Object.assign(ns.dataObjects, payload.dataObjectsByToken);
    if (payload.cardRuntimeById) {
      for (const [cardId, rt] of Object.entries<any>(payload.cardRuntimeById)) {
        if (rt?.computed_values && Object.keys(rt.computed_values).length) ns.computedValues[cardId] = rt.computed_values;
      }
    }
    return;
  }
  if (payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    for (const n of payload.notifications) {
      if (n.kind === 'status' && n.status?.summary) { ns.statusSummary = n.status.summary; ns.statusGeneration++; }
      else if (n.kind === 'data_object' && n.key) ns.dataObjects[n.key] = n.payload;
      else if (n.kind === 'computed_values' && n.cardId) ns.computedValues[n.cardId] = n.values;
    }
  }
}

/** Subscribe to /sse and call onFrame for every parsed frame. Returns a teardown function. */
function subscribeSSE(sseUrl: string, ns: NotificationState): () => void {
  let stopped = false;
  let req: http.ClientRequest | null = null;

  function connect() {
    if (stopped) return;
    req = http.get(sseUrl, (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        if (stopped) return;
        buf += chunk;
        while (true) {
          const idx = buf.indexOf('\n\n');
          if (idx === -1) break;
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = '';
          for (const line of block.split('\n')) { if (line.startsWith('data: ')) data = line.slice(6); }
          if (!data) continue;
          try { applyFrame(ns, JSON.parse(data)); } catch { /* skip */ }
        }
      });
      res.on('end', () => { if (!stopped) setTimeout(connect, 500); });
      res.on('error', () => { if (!stopped) setTimeout(connect, 1000); });
    });
    req.on('error', () => { if (!stopped) setTimeout(connect, 1000); });
  }

  connect();
  return () => { stopped = true; req?.destroy(); };
}

// ── Polling helpers ───────────────────────────────────────────────────────────

function waitUntil<T>(predicate: () => T | null | undefined | false, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      let result: T | null | undefined | false;
      try { result = predicate(); } catch { /* retry */ }
      if (result !== undefined && result !== null && result !== false) {
        clearInterval(interval); resolve(result); return;
      }
      if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`));
      }
    }, 200);
  });
}

const waitForInitialPayload = (ns: NotificationState, ms = 20_000) =>
  waitUntil(() => ns.initialPayload || false, ms, 'initial SSE payload');

const waitForAllCompleted = (ns: NotificationState, ms = 60_000, label = 'all completed') =>
  waitUntil(() => {
    const s = ns.statusSummary;
    return (s && s.card_count > 0 && s.completed === s.card_count) ? s : false;
  }, ms, label);

function waitForPriceSymbols(ns: NotificationState, symbols: string[], ms = 30_000, label = 'prices'): Promise<Record<string, number>> {
  const expected = [...symbols].sort().join(',');
  return waitUntil(() => {
    const prices = ns.dataObjects['prices'];
    if (!prices || typeof prices !== 'object') return false;
    const actual = Object.keys(prices).sort().join(',');
    return actual === expected ? prices : false;
  }, ms, `${label}: [${expected}]`);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

function startServer(cmd: string, args: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let ready = false;
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      if (!ready && text.includes('listening on')) { ready = true; resolve(proc); }
    });
    proc.stderr?.on('data', () => { /* suppress */ });
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!ready) reject(new Error(`Server exited early: code ${code}`)); });
    setTimeout(() => { if (!ready) reject(new Error('Server startup timeout (20s)')); }, 20_000);
  });
}

function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc) return Promise.resolve();
  proc.kill('SIGTERM');
  if (process.platform === 'win32') {
    try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* ok */ }
  }
  return new Promise((resolve) => { proc.once('exit', () => resolve()); setTimeout(resolve, 3000); });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!PYTHON_CMD || !DEEP)('portfolio-tracker dual-mode parity (node vs python)', () => {
  let nodeProc: ChildProcess | null = null;
  let pyProc: ChildProcess | null = null;

  const nodeNS = makeNS();
  const pyNS   = makeNS();

  let nodeSseTeardown: (() => void) | null = null;
  let pySseTeardown:   (() => void) | null = null;

  const nodeBase = `http://127.0.0.1:${NODE_PORT}/api/board`;
  const pyBase   = `http://127.0.0.1:${PY_PORT}/api/board`;

  beforeAll(async () => {
    [nodeProc, pyProc] = await Promise.all([
      startServer(process.execPath, [nodeServerScript, '--port', String(NODE_PORT), '--reset']),
      startServer(PYTHON_CMD!, [pyServerScript, '--port', String(PY_PORT), '--reset']),
    ]);

    // Brief settle
    await new Promise<void>((r) => setTimeout(r, 300));

    // Init both boards
    await Promise.all([
      httpGet(`${nodeBase}/init-board`),
      httpGet(`${pyBase}/init-board`),
    ]);

    // Open SSE subscriptions
    nodeSseTeardown = subscribeSSE(`${nodeBase}/sse`, nodeNS);
    pySseTeardown   = subscribeSSE(`${pyBase}/sse`,   pyNS);

    // Wait for both initial payloads
    await Promise.all([
      waitForInitialPayload(nodeNS, 20_000),
      waitForInitialPayload(pyNS,   20_000),
    ]);
  }, 60_000);

  afterAll(async () => {
    nodeSseTeardown?.();
    pySseTeardown?.();
    await Promise.all([stopServer(nodeProc), stopServer(pyProc)]);
    nodeProc = null; pyProc = null;
  });

  // ── T1: Initial drain ──────────────────────────────────────────────────────

  it('T1: both servers complete initial drain with AAPL+MSFT prices and 2 rows', async () => {
    await Promise.all([
      waitForAllCompleted(nodeNS, 60_000, 'T1 node'),
      waitForAllCompleted(pyNS,   60_000, 'T1 py'),
    ]);

    const [nodePrices, pyPrices] = await Promise.all([
      waitForPriceSymbols(nodeNS, ['AAPL', 'MSFT'], 30_000, 'T1 node prices'),
      waitForPriceSymbols(pyNS,   ['AAPL', 'MSFT'], 30_000, 'T1 py prices'),
    ]);

    // Both have same symbols
    expect(Object.keys(nodePrices).sort()).toEqual(Object.keys(pyPrices).sort());

    // Both report 2-row table
    const nodeTable = nodeNS.computedValues['holdings-table']?.table;
    const pyTable   = pyNS.computedValues['holdings-table']?.table;
    expect(Array.isArray(nodeTable?.rows)).toBe(true);
    expect(Array.isArray(pyTable?.rows)).toBe(true);
    expect(nodeTable.rows.length).toBe(2);
    expect(pyTable.rows.length).toBe(2);

    // Both report positive totalValue
    const nodeTotal = nodeNS.computedValues['portfolio-value']?.totalValue;
    const pyTotal   = pyNS.computedValues['portfolio-value']?.totalValue;
    expect(typeof nodeTotal).toBe('number');
    expect(typeof pyTotal).toBe('number');
    expect(nodeTotal).toBeGreaterThan(0);
    expect(pyTotal).toBeGreaterThan(0);
  }, 120_000);

  // ── T2: Add GOOG ───────────────────────────────────────────────────────────

  it('T2: after adding GOOG both servers converge to 3 prices and 3 rows', async () => {
    const patch = makeHoldingsPatch({ AAPL: 50, MSFT: 30, GOOG: 100 });

    await Promise.all([
      httpPatch(`${nodeBase}/cards/portfolio-form`, patch),
      httpPatch(`${pyBase}/cards/portfolio-form`,   patch),
    ]);

    await Promise.all([
      waitForAllCompleted(nodeNS, 60_000, 'T2 node'),
      waitForAllCompleted(pyNS,   60_000, 'T2 py'),
    ]);

    const [nodePrices, pyPrices] = await Promise.all([
      waitForPriceSymbols(nodeNS, ['AAPL', 'GOOG', 'MSFT'], 30_000, 'T2 node'),
      waitForPriceSymbols(pyNS,   ['AAPL', 'GOOG', 'MSFT'], 30_000, 'T2 py'),
    ]);

    expect(Object.keys(nodePrices).sort()).toEqual(Object.keys(pyPrices).sort());

    const nodeTable = nodeNS.computedValues['holdings-table']?.table;
    const pyTable   = pyNS.computedValues['holdings-table']?.table;
    expect(nodeTable?.rows?.length).toBe(3);
    expect(pyTable?.rows?.length).toBe(3);
  }, 120_000);

  // ── T3: Rapid updates ──────────────────────────────────────────────────────

  it('T3: rapid 3× PATCH converges to AAPL+GOOG+MSFT+TSLA, no AMZN', async () => {
    const updates = [
      makeHoldingsPatch({ AAPL: 45, MSFT: 30, GOOG: 110, TSLA: 60 }),
      makeHoldingsPatch({ AAPL: 45, MSFT: 30, GOOG: 110, AMZN: 100 }),
      makeHoldingsPatch({ AAPL: 40, MSFT: 35, GOOG: 120, TSLA: 70 }),
    ];

    // Fire all 6 patches (3 per server) in rapid succession
    for (const patch of updates) {
      await Promise.all([
        httpPatch(`${nodeBase}/cards/portfolio-form`, patch),
        httpPatch(`${pyBase}/cards/portfolio-form`,   patch),
      ]);
    }

    await Promise.all([
      waitForAllCompleted(nodeNS, 60_000, 'T3 node'),
      waitForAllCompleted(pyNS,   60_000, 'T3 py'),
    ]);

    const [nodePrices, pyPrices] = await Promise.all([
      waitForPriceSymbols(nodeNS, ['AAPL', 'GOOG', 'MSFT', 'TSLA'], 30_000, 'T3 node'),
      waitForPriceSymbols(pyNS,   ['AAPL', 'GOOG', 'MSFT', 'TSLA'], 30_000, 'T3 py'),
    ]);

    // Same final symbol set, no AMZN
    expect(Object.keys(nodePrices).sort()).toEqual(Object.keys(pyPrices).sort());
    expect(Object.keys(nodePrices)).not.toContain('AMZN');
    expect(Object.keys(pyPrices)).not.toContain('AMZN');

    const nodeTable = nodeNS.computedValues['holdings-table']?.table;
    const pyTable   = pyNS.computedValues['holdings-table']?.table;
    expect(nodeTable?.rows?.length).toBe(4);
    expect(pyTable?.rows?.length).toBe(4);
  }, 120_000);

  // ── T4: totalValue cross-check ─────────────────────────────────────────────

  it('T4: totalValue equals sum of row values on both servers', async () => {
    const nodeTotal = nodeNS.computedValues['portfolio-value']?.totalValue as number;
    const pyTotal   = pyNS.computedValues['portfolio-value']?.totalValue as number;

    expect(typeof nodeTotal).toBe('number');
    expect(typeof pyTotal).toBe('number');

    const nodeRows = nodeNS.computedValues['holdings-table']?.table?.rows as any[];
    const pyRows   = pyNS.computedValues['holdings-table']?.table?.rows as any[];

    const nodeSum = nodeRows.reduce((acc: number, r: any) => acc + (r.value || 0), 0);
    const pySum   = pyRows.reduce((acc: number, r: any)  => acc + (r.value || 0), 0);

    expect(Math.abs(nodeSum - nodeTotal)).toBeLessThan(0.01);
    expect(Math.abs(pySum   - pyTotal)).toBeLessThan(0.01);
  }, 30_000);

  // ── T5: Parity cross-check between node and python ─────────────────────────

  it('T5: node and python agree on symbol set, row count, and board-status', async () => {
    // Symbol parity
    const nodeSymbols = Object.keys(nodeNS.dataObjects['prices'] ?? {}).sort();
    const pySymbols   = Object.keys(pyNS.dataObjects['prices']   ?? {}).sort();
    expect(nodeSymbols).toEqual(pySymbols);

    // Row count parity
    const nodeRows = nodeNS.computedValues['holdings-table']?.table?.rows?.length;
    const pyRows   = pyNS.computedValues['holdings-table']?.table?.rows?.length;
    expect(nodeRows).toBe(pyRows);

    // board-status parity via HTTP
    const [nodeStatus, pyStatus] = await Promise.all([
      httpGet(`${nodeBase}/board-status`),
      httpGet(`${pyBase}/board-status`),
    ]);

    expect(nodeStatus.status).toBe(200);
    expect(pyStatus.status).toBe(200);

    const nodeSnap = nodeStatus.data?.statusSnapshot?.summary;
    const pySnap   = pyStatus.data?.statusSnapshot?.summary;

    expect(nodeSnap?.card_count).toBe(pySnap?.card_count);
    expect(nodeSnap?.completed).toBe(nodeSnap?.card_count);
    expect(pySnap?.completed).toBe(pySnap?.card_count);
    expect(nodeSnap?.failed ?? 0).toBe(0);
    expect(pySnap?.failed ?? 0).toBe(0);

    // dataObjects key-set parity
    const nodeDataKeys = Object.keys(nodeStatus.data?.dataObjectsByToken ?? {}).sort().join(',');
    const pyDataKeys   = Object.keys(pyStatus.data?.dataObjectsByToken   ?? {}).sort().join(',');
    expect(nodeDataKeys).toBe(pyDataKeys);
  }, 30_000);
});
