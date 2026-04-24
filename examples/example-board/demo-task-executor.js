#!/usr/bin/env node

/**
 * demo-task-executor.js — Simple mock source executor for example-board.
 *
 * Protocol (invoked by board-live-cards-cli):
 *   node demo-task-executor.js run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
 *
 * Expected source definition (--in payload):
 *   {
 *     "bindTo": "...",
 *     "outputFile": "...",
 *     // custom fields authored on the source entry (e.g. mock, copilot, http, prompt_template, etc.)
 *     "cwd": "<card directory>",
 *     "boardDir": "<board runtime directory>",
 *     "_requires": { },   // upstream token data (from card requires[])
 *     "_sourcesData": { }, // already-fetched sources on this card
 *     "_computed_values": { } // computed_values from the card's compute stage
 *   }
 *
 * Supported source kinds (based on custom fields):
 *   - { mock: "key" }              → look up key in mock.db
 *   - { copilot: { prompt_template, args? } }  → call Copilot CLI with interpolated prompt
 *   - { prompt_template: "..." }   → shorthand copilot call (top-level template)
 *   - { http: { url, method?, headers?, args? }, tickersFrom? }  → HTTP fetch (Node 18+ fetch)
 *   - { chartApi: { url, headers? }, tickersFrom }  → Yahoo Finance chart API, one request per ticker;
 *     returns { quoteResponse: { result: [...] } } compatible with the quote API shape
 *   A real executor can also handle: graphapi, teams, mail, incidentdb, script, etc.
 *
 * http / chartApi source notes:
 *   - URL supports {{key}} interpolation (http) or {{ticker}} (chartApi)
 *   - tickersFrom: "tokenName.fieldName" extracts tickers from a _requires array
 *   - If the fetch fails AND the source has a "mock" field, falls back to mock.db
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DB_PATH = path.join(__dirname, 'mock.db');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function interpolatePrompt(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);

  // Remove trailing blank lines first.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  // Remove the standard trailing Copilot metadata footer, if present.
  if (
    lines.length >= 3 &&
    /^Changes\b/i.test(lines[lines.length - 3]) &&
    /^Requests\b/i.test(lines[lines.length - 2]) &&
    /^Tokens\b/i.test(lines[lines.length - 1])
  ) {
    lines.splice(lines.length - 3, 3);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function resolveCopilotPrompt(sourceDef) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};
  
  // Merge all injected context for template interpolation.
  // _requires = upstream token data, _computed_values = card compute stage outputs,
  // _sourcesData = already-fetched sources on this card.
  // Explicit args defined on the source take highest precedence.
  const interpolationContext = {
    ...sourceDef._requires,
    ...sourceDef._sourcesData,
    ...sourceDef._computed_values,
    ...args,
  };
  
  if (!template || typeof template !== 'string') return null;
  return interpolatePrompt(template, interpolationContext);
}

function resolveCopilotExecutable() {
  const envBin = process.env.COPILOT_BIN;
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const candidates = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const preferred = candidates.find((p) => /\.(cmd|exe|bat)$/i.test(p));
      if (preferred) return preferred;
      if (candidates[0]) return candidates[0];
    } catch {}
  } else {
    try {
      const out = execFileSync('which', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    } catch {}
  }

  return 'copilot';
}

function runCopilotPrompt(prompt) {
  const copilotBin = resolveCopilotExecutable();
  const copilotArgs = ['--allow-all'];

  try {
    // Prefer stdin prompt delivery to avoid shell/path quoting issues.
    return execFileSync(copilotBin, copilotArgs, {
      input: String(prompt),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (directErr) {
    // Fallback for Git Bash / Windows wrapper path quoting issues.
    if (process.platform === 'win32') {
      const isCmdShim = /\.(bat|cmd)$/i.test(copilotBin);

      if (isCmdShim) {
        try {
          return execFileSync(copilotBin, copilotArgs, {
            input: String(prompt),
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
            shell: true,
          });
        } catch {}
      }

      try {
        // Final fallback: resolve through cmd PATH lookup, still piping prompt on stdin.
        return execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
          input: String(prompt),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (cmdErr) {
        const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
          ? String(directErr.stderr || '')
          : '';
        const stderrCmd = cmdErr && typeof cmdErr === 'object' && 'stderr' in cmdErr
          ? String(cmdErr.stderr || '')
          : '';
        const msg = [stderrDirect.trim(), stderrCmd.trim(), String(cmdErr && cmdErr.message || cmdErr)]
          .filter(Boolean)
          .join(' | ');
        throw new Error(msg || 'copilot invocation failed');
      }
    }

    const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
      ? String(directErr.stderr || '')
      : '';
    const msg = [stderrDirect.trim(), String(directErr && directErr.message || directErr)]
      .filter(Boolean)
      .join(' | ');
    throw new Error(msg || 'copilot invocation failed');
  }
}

function fail(msg, errFile) {
  if (errFile) {
    try { fs.writeFileSync(errFile, msg); } catch {}
  }
  console.error(`[demo-task-executor] ${msg}`);
  // In probe mode: throw so probeSourceSubcommand can catch and report gracefully
  if (globalThis.__probeMode) {
    globalThis.__probeFailMsg = msg;
    throw new Error(msg);
  }
  process.exit(1);
}

async function runSourceFetchSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const outIdx = argv.indexOf('--out');
  const errIdx = argv.indexOf('--err');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? argv[errIdx + 1] : undefined;

  if (!inFile || !outFile) {
    fail('Usage: run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]', errFile);
  }

  if (!fs.existsSync(inFile)) {
    fail(`Input file not found: ${inFile}`, errFile);
  }

  let sourceDef;
  try {
    sourceDef = readJson(inFile);
  } catch (err) {
    fail(`Cannot parse source file: ${String(err && err.message || err)}`, errFile);
  }

  let resultValue;

  if (sourceDef.chartApi) {
    // ---------------------------------------------------------------------------
    // chartApi source kind — Yahoo Finance v8/finance/chart (free, per-ticker)
    // Makes one request per ticker and assembles a quoteResponse-compatible shape.
    // URL template must contain {{ticker}}, e.g.:
    //   https://query1.finance.yahoo.com/v8/finance/chart/{{ticker}}?interval=1d&range=1d
    // ---------------------------------------------------------------------------
    const chartCfg = sourceDef.chartApi;
    const headers = { ...(chartCfg.headers || {}) };

    // Extract tickers array from _requires via tickersFrom
    let tickers = [];
    if (sourceDef.tickersFrom) {
      const dotIdx = sourceDef.tickersFrom.indexOf('.');
      if (dotIdx > 0) {
        const tokenName = sourceDef.tickersFrom.slice(0, dotIdx);
        const fieldName = sourceDef.tickersFrom.slice(dotIdx + 1);
        const arr = sourceDef._requires?.[tokenName];
        if (Array.isArray(arr)) {
          tickers = arr.map(h => h[fieldName]).filter(Boolean);
        }
      }
    }

    if (tickers.length === 0) {
      console.warn('[demo-task-executor] chartApi: tickersFrom resolved to empty list — falling back to mock');
    } else {
      try {
        const results = await Promise.all(tickers.map(async (ticker) => {
          const url = interpolatePrompt(chartCfg.url, { ticker });
          const abort = new AbortController();
          const timeoutId = setTimeout(() => abort.abort(), 10_000);
          let resp;
          try {
            resp = await fetch(url, { headers, signal: abort.signal });
          } finally {
            clearTimeout(timeoutId);
          }
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} for ${ticker}`);
          }
          const data = await resp.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) throw new Error(`No chart meta for ${ticker}`);
          // Map to quote-compatible shape; compute change from chartPreviousClose
          const price = meta.regularMarketPrice ?? 0;
          const prevClose = meta.chartPreviousClose ?? price;
          const change = price - prevClose;
          const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
          return {
            symbol: meta.symbol ?? ticker,
            shortName: meta.shortName ?? meta.longName ?? ticker,
            regularMarketPrice: price,
            regularMarketChange: change,
            regularMarketChangePercent: changePct,
          };
        }));
        resultValue = { quoteResponse: { result: results, error: null } };
      } catch (chartErr) {
        if (sourceDef.mock) {
          console.warn(`[demo-task-executor] chartApi fetch failed (${chartErr.message}), falling back to mock key "${sourceDef.mock}"`);
        } else {
          fail(`chartApi fetch failed: ${chartErr.message}`, errFile);
        }
      }
    }

    // Fall back to mock if fetch failed or tickers were empty
    if (resultValue === undefined) {
      if (!sourceDef.mock) {
        fail('chartApi: no tickers and no mock fallback defined', errFile);
      }
      let mockDb;
      try {
        mockDb = readJson(MOCK_DB_PATH);
      } catch (e) {
        fail(`chartApi failed and cannot read mock.db: ${String(e && e.message || e)}`, errFile);
      }
      resultValue = mockDb[sourceDef.mock];
      if (resultValue === undefined) {
        fail(`chartApi mock key "${sourceDef.mock}" not found in mock.db`, errFile);
      }
    }

  } else if (sourceDef.http) {
    // ---------------------------------------------------------------------------
    // HTTP source kind (Node 18+ built-in fetch)
    // ---------------------------------------------------------------------------
    const httpCfg = sourceDef.http;

    // Build tickers string if tickersFrom is specified on the source
    // e.g. tickersFrom: "holdings.ticker" → joins _requires.holdings[*].ticker with ','
    const httpArgs = { ...(httpCfg.args || {}) };
    if (sourceDef.tickersFrom) {
      const dotIdx = sourceDef.tickersFrom.indexOf('.');
      if (dotIdx > 0) {
        const tokenName = sourceDef.tickersFrom.slice(0, dotIdx);
        const fieldName = sourceDef.tickersFrom.slice(dotIdx + 1);
        const arr = sourceDef._requires?.[tokenName];
        if (Array.isArray(arr)) {
          httpArgs.tickers = arr.map(h => h[fieldName]).filter(Boolean).join(',');
        }
      }
    }

    // Interpolate URL template with all available context
    const urlContext = {
      ...(sourceDef._requires || {}),
      ...(sourceDef._computed_values || {}),
      ...httpArgs,
    };
    const url = interpolatePrompt(httpCfg.url, urlContext);
    const method = (httpCfg.method || 'GET').toUpperCase();
    const headers = { ...(httpCfg.headers || {}) };

    // Skip fetch entirely if tickers ended up empty (guard against empty ?symbols=)
    const httpFetchSkipped = sourceDef.tickersFrom && !httpArgs.tickers;

    try {
      if (httpFetchSkipped) {
        throw new Error('tickersFrom resolved to empty list — skipping fetch');
      }
      // Hard timeout: 10 s — prevents the subprocess from hanging indefinitely
      const abort = new AbortController();
      const timeoutId = setTimeout(() => abort.abort(), 10_000);
      let resp;
      try {
        resp = await fetch(url, { method, headers, signal: abort.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}`);
      }
      resultValue = await resp.json();
    } catch (httpErr) {
      // If source also declares a mock key, fall back to mock.db (useful for offline dev)
      if (sourceDef.mock) {
        console.warn(`[demo-task-executor] HTTP fetch failed (${httpErr.message}), falling back to mock key "${sourceDef.mock}"`);
        let mockDb;
        try {
          mockDb = readJson(MOCK_DB_PATH);
        } catch (e) {
          fail(`HTTP fetch failed and cannot read mock.db: ${String(e && e.message || e)}`, errFile);
        }
        resultValue = mockDb[sourceDef.mock];
        if (resultValue === undefined) {
          fail(`HTTP fetch failed and mock key "${sourceDef.mock}" not found in mock.db`, errFile);
        }
      } else {
        fail(`HTTP fetch failed: ${httpErr.message}`, errFile);
      }
    }

  } else if (sourceDef.copilot || sourceDef.prompt_template) {
    const prompt = resolveCopilotPrompt(sourceDef);
    if (!prompt) {
      fail('Source definition missing copilot.prompt_template (or prompt_template)', errFile);
    }

    let rawOutput = '';
    try {
      rawOutput = runCopilotPrompt(prompt);
    } catch (err) {
      const msg = String(err && err.message || err);
      fail(`copilot invocation failed: ${msg}`, errFile);
    }

    resultValue = stripCopilotFooter(rawOutput);
  } else {
    // Default mode: mockdb lookup
    let mockDb;
    try {
      if (!fs.existsSync(MOCK_DB_PATH)) {
        fail(`mock.db not found at ${MOCK_DB_PATH}`, errFile);
      }
      mockDb = readJson(MOCK_DB_PATH);
    } catch (err) {
      fail(`Cannot parse mock.db: ${String(err && err.message || err)}`, errFile);
    }

    const mockKey = sourceDef.mock;
    if (!mockKey) {
      fail('Source definition missing "mock" field (key to lookup)', errFile);
    }

    resultValue = mockDb[mockKey];
    if (resultValue === undefined) {
      fail(`Key "${mockKey}" not found in mock.db`, errFile);
    }
  }

  // Write result to --out as JSON payload, same contract as current mock mode.
  try {
    fs.writeFileSync(outFile, JSON.stringify(resultValue, null, 2));
  } catch (err) {
    fail(`Cannot write output file: ${String(err && err.message || err)}`, errFile);
  }

  // In probe mode, return normally so probeSourceSubcommand can read the result
  if (!globalThis.__probeMode) {
    process.exit(0);
  }
}

/**
 * probe-source — Agent-facing validation subcommand.
 *
 * Usage:
 *   node demo-task-executor.js probe-source \
 *     --card <card.json>         path to the card file to probe
 *     --source-idx <n>           0-based index into card.sources[]
 *   [ --source-bind <name> ]     alternative: select source by bindTo name
 *   [ --mock-requires <json> ]   JSON string (or @file.json) providing _requires tokens
 *                                If omitted, stubs are auto-generated from the card's
 *                                requires[] declarations using card_data where possible
 *   [ --out <result.json> ]      optional: also write result to this file
 *
 * Exits 0 and prints a PROBE_PASS / PROBE_FAIL report to stdout.
 * The report is machine-readable JSON on the last line (prefixed [probe:result]).
 *
 * Example — agents can run this after authoring a card:
 *   node demo-task-executor.js probe-source \
 *     --card examples/example-board/cards/card-market-prices.json \
 *     --source-idx 0 \
 *     --mock-requires '{"holdings":[{"ticker":"AAPL","quantity":10},{"ticker":"MSFT","quantity":5}]}'
 */
async function probeSourceSubcommand(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const cardPath  = get('--card');
  const idxArg    = get('--source-idx');
  const bindArg   = get('--source-bind');
  const mockReqArg = get('--mock-requires');
  const outArg    = get('--out');

  if (!cardPath) {
    console.error('[probe] ERROR: --card <card.json> is required');
    process.exit(1);
  }

  // ── Load card ─────────────────────────────────────────────────────────────
  let card;
  try {
    card = readJson(path.resolve(cardPath));
  } catch (e) {
    console.error(`[probe] ERROR: cannot read card file: ${e.message}`);
    process.exit(1);
  }

  const sources = card.sources || [];
  if (sources.length === 0) {
    console.error(`[probe] ERROR: card "${card.id}" has no sources`);
    process.exit(1);
  }

  // ── Select source ─────────────────────────────────────────────────────────
  let sourceIdx;
  if (bindArg) {
    sourceIdx = sources.findIndex(s => s.bindTo === bindArg);
    if (sourceIdx === -1) {
      console.error(`[probe] ERROR: no source with bindTo="${bindArg}" in card "${card.id}"`);
      process.exit(1);
    }
  } else {
    sourceIdx = idxArg !== undefined ? parseInt(idxArg, 10) : 0;
    if (isNaN(sourceIdx) || sourceIdx < 0 || sourceIdx >= sources.length) {
      console.error(`[probe] ERROR: --source-idx ${idxArg} out of range (card has ${sources.length} source(s))`);
      process.exit(1);
    }
  }

  const sourceDef = sources[sourceIdx];
  const cardDir   = path.resolve(path.dirname(cardPath));

  // ── Build _requires ────────────────────────────────────────────────────────
  // Priority: --mock-requires arg > auto-stub from card_data + requires[]
  let mockRequires = {};

  if (mockReqArg) {
    const raw = mockReqArg.startsWith('@')
      ? fs.readFileSync(path.resolve(mockReqArg.slice(1)), 'utf-8')
      : mockReqArg;
    try {
      mockRequires = JSON.parse(raw);
    } catch (e) {
      console.error(`[probe] ERROR: --mock-requires is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Auto-generate stubs from card.requires[] + card_data where possible.
    // For each required token, look for a matching key in card_data first
    // (e.g. the portfolio card stores holdings in card_data.holdings).
    // If not found, generate a minimal typed stub based on known token shapes.
    const KNOWN_STUBS = {
      holdings: [{ ticker: 'AAPL', quantity: 10 }, { ticker: 'MSFT', quantity: 5 }],
    };
    for (const token of (card.requires || [])) {
      if (card.card_data?.[token] !== undefined) {
        mockRequires[token] = card.card_data[token];
      } else if (KNOWN_STUBS[token]) {
        mockRequires[token] = KNOWN_STUBS[token];
        console.log(`[probe] auto-stub for requires["${token}"]: ${JSON.stringify(KNOWN_STUBS[token])}`);
      } else {
        mockRequires[token] = {};
        console.log(`[probe] auto-stub for requires["${token}"]: {} (unknown token — provide --mock-requires for accuracy)`);
      }
    }
  }

  // ── Assemble --in payload ──────────────────────────────────────────────────
  const inPayload = {
    ...sourceDef,
    cwd: cardDir,
    boardDir: cardDir,
    _requires: mockRequires,
    _sourcesData: {},
    _computed_values: {},
  };

  // ── Run via temp files (reuses runSourceFetchSubcommand unchanged) ─────────
  const os = await import('node:os');
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const inFile  = path.join(tmpDir, 'probe-in.json');
  const outFile = path.join(tmpDir, 'probe-out.json');

  fs.writeFileSync(inFile, JSON.stringify(inPayload, null, 2));

  // Identify source kind label for the report
  const sourceKind = sourceDef.chartApi ? 'chartApi'
    : sourceDef.http ? 'http'
    : sourceDef.copilot || sourceDef.prompt_template ? 'copilot'
    : 'mock';

  console.log(`[probe] card:        ${card.id}`);
  console.log(`[probe] source[${sourceIdx}]:  bindTo="${sourceDef.bindTo}" kind=${sourceKind}`);
  console.log(`[probe] _requires:   ${JSON.stringify(mockRequires)}`);
  console.log(`[probe] running fetch...`);

  let probeResult;
  let probeError = null;
  let exitedOk = false;

  globalThis.__probeMode = true;
  globalThis.__probeFailMsg = null;

  try {
    await runSourceFetchSubcommand(['--in', inFile, '--out', outFile]);
    exitedOk = true;
  } catch (e) {
    probeError = globalThis.__probeFailMsg || e.message;
  } finally {
    globalThis.__probeMode = false;
    globalThis.__probeFailMsg = null;
  }

  // Read result if written
  if (fs.existsSync(outFile)) {
    try {
      probeResult = readJson(outFile);
    } catch {}
  }

  // Cleanup temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // ── Report ─────────────────────────────────────────────────────────────────
  const passed = exitedOk && probeResult !== undefined;

  if (passed) {
    const resultSize = JSON.stringify(probeResult).length;
    const sample = JSON.stringify(probeResult).slice(0, 300);
    console.log(`[probe] STATUS:      PROBE_PASS`);
    console.log(`[probe] result size: ${resultSize} bytes`);
    console.log(`[probe] sample:      ${sample}${resultSize > 300 ? '...' : ''}`);
  } else {
    console.log(`[probe] STATUS:      PROBE_FAIL`);
    if (probeError) console.log(`[probe] error:       ${probeError}`);
  }

  // Machine-readable summary line for agent consumption
  const summary = {
    status: passed ? 'PROBE_PASS' : 'PROBE_FAIL',
    cardId: card.id,
    sourceIdx,
    bindTo: sourceDef.bindTo,
    sourceKind,
    mockRequiresKeys: Object.keys(mockRequires),
    resultSizeBytes: probeResult !== undefined ? JSON.stringify(probeResult).length : 0,
    error: probeError || undefined,
  };
  console.log(`[probe:result] ${JSON.stringify(summary)}`);

  // Optionally write result to --out
  if (outArg && probeResult !== undefined) {
    fs.writeFileSync(path.resolve(outArg), JSON.stringify(probeResult, null, 2));
    console.log(`[probe] result written to: ${outArg}`);
  }

  process.exit(passed ? 0 : 1);
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    await runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'probe-source') {
    await probeSourceSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[demo-task-executor] fatal: ${err && err.message || err}`);
  process.exit(1);
});
