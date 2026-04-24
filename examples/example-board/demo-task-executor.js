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
 *     "_requires": { /* upstream token data (from card requires[]) */ },
 *     "_sourcesData": { /* already-fetched sources on this card */ },
 *     "_computed_values": { /* computed_values from the card's compute stage */ }
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
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`[demo-task-executor] ${msg}`);
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

  process.exit(0);
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    await runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[demo-task-executor] fatal: ${err && err.message || err}`);
  process.exit(1);
});
