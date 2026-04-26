#!/usr/bin/env node

/**
 * demo-task-executor.js — Simple mock source executor for example-board.
 *
 * Subcommands:
 *   run-source-fetch        — fetch data for one source entry
 *   describe-capabilities   — print supported source kinds + schemas to stdout (JSON)
 *
 * CLI args:
 *   --in    <source.json>   Required. Path to a temp JSON file containing the source definition.
 *   --out   <result.json>   Required. Path where this executor must write its JSON result.
 *   --err   <error.txt>     Optional. Path where this executor writes an error message on failure.
 *   --extra <base64json>    Optional. Base64-encoded JSON with board topology context
 *                           (baked into .task-executor at board init time, passed blindly by the CLI).
 *
 * --in payload (source definition):
 *   {
 *     "bindTo":  "token_name",
 *     "outputFile": "relative/path.json",
 *     "cwd":     "<card directory>",           // injected by CLI
 *     "boardDir":"<board runtime directory>",   // injected by CLI
 *     "_requires":        { ... },             // upstream token data (from card requires[])
 *     "_sourcesData":     { ... },             // already-fetched source_defs on this card
 *     "_computed_values":  { ... },            // computed_values from the card's compute stage
 *     // ...plus any custom fields authored on the source entry
 *   }
 *
 * --extra (decoded):
 *   {
 *     "boardSetupRoot":   "<abs path>",        // board root (parent of runtime/, surface/, runtime-out/)
 *     "boardId":          "<board id>",        // e.g. "default"
 *     "boardRuntimeDir":  "<relative>",        // e.g. "runtime"
 *     "runtimeStatusDir": "<relative>",        // e.g. "runtime-out"
 *     "cardsDir":         "<relative>"         // e.g. "surface/tmp-cards"
 *   }
 *
 * Supported source kinds (based on custom fields in --in):
 *   - { mock: "key" }              → look up key in MOCK_DB (hardcoded below)
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
 *   - http and chartApi results are cached in os.tmpdir()/demo-executor-cache/ for 1 hour
 *     so Yahoo Finance is not hammered on every card refresh during demos
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mock data — used when a source has { mock: "key" }.
// Edit these values to change the demo data without needing a mock.db file.
// ---------------------------------------------------------------------------
const MOCK_DB = {
  quotes: {
    quoteResponse: {
      result: [
        { symbol: 'AAPL',  shortName: 'Apple Inc.',      regularMarketPrice: 198.15, regularMarketChange:  2.15, regularMarketChangePercent:  1.10 },
        { symbol: 'MSFT',  shortName: 'Microsoft Corp.', regularMarketPrice: 415.32, regularMarketChange: -1.23, regularMarketChangePercent: -0.30 },
        { symbol: 'GOOGL', shortName: 'Alphabet Inc.',   regularMarketPrice: 174.89, regularMarketChange:  0.89, regularMarketChangePercent:  0.51 },
        { symbol: 'TSLA',  shortName: 'Tesla Inc.',      regularMarketPrice: 247.12, regularMarketChange:  5.43, regularMarketChangePercent:  2.25 },
      ],
      error: null,
    },
  },
};

// ---------------------------------------------------------------------------
// Simple 1-hour file cache for HTTP / chartApi results.
// Stored in os.tmpdir()/demo-executor-cache/<hash>.json
// ---------------------------------------------------------------------------
const CACHE_DIR = path.join(os.tmpdir(), 'demo-executor-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function readCache(key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}
  return null;
}

function writeCache(key, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch {}
}

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

/**
 * Fetch a URL using the system curl binary (synchronous, no Node event-loop handles).
 * Throws if curl exits non-zero (e.g. HTTP 4xx/5xx with -f, or network error).
 */
function curlFetchJson(url, method, headers) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  // -s  : silent (no progress bar)
  // -S  : show errors despite -s
  // -f  : fail (non-zero exit) on HTTP 4xx/5xx
  // -L  : follow redirects
  // --max-time 10 : hard timeout
  const args = ['-s', '-S', '-f', '-L', '--max-time', '10', '-X', method];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  const raw = execFileSync(bin, args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(raw);
}

function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);

  // Strip CLI-level tool-call telemetry lines emitted by the copilot binary when
  // --allow-all activates MCP tools. These are NOT model output — the prompt cannot
  // suppress them. They look like:
  //   ● Web Search (MCP: github-mcp-server) · ...
  //   └ {"type":"output_text",...}
  const filtered = lines.filter(line => {
    const t = line.trimStart();
    return !(
      /^[●•]\s+/.test(t) ||  // tool invocation lines
      /^└\s+/.test(t)         // tool result lines
    );
  });

  // Remove trailing blank lines.
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();

  // Remove the standard trailing Copilot metadata footer, if present.
  if (
    filtered.length >= 3 &&
    /^Changes\b/i.test(filtered[filtered.length - 3]) &&
    /^Requests\b/i.test(filtered[filtered.length - 2]) &&
    /^Tokens\b/i.test(filtered[filtered.length - 1])
  ) {
    filtered.splice(filtered.length - 3, 3);
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
  return filtered.join('\n');
}

function resolveCopilotPrompt(sourceDef) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};
  
  // Merge all injected context for template interpolation.
  // _requires = upstream token data, _computed_values = card compute stage outputs,
  // _sourcesData = already-fetched source_defs on this card.
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

function runCopilotPrompt(prompt, cwd) {
  const copilotBin = resolveCopilotExecutable();
  const copilotArgs = ['--allow-all'];
  const execOpts = {
    input: String(prompt),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  };

  try {
    // Prefer stdin prompt delivery to avoid shell/path quoting issues.
    return execFileSync(copilotBin, copilotArgs, execOpts);
  } catch (directErr) {
    // Fallback for Git Bash / Windows wrapper path quoting issues.
    if (process.platform === 'win32') {
      const isCmdShim = /\.(bat|cmd)$/i.test(copilotBin);

      if (isCmdShim) {
        try {
          return execFileSync(copilotBin, copilotArgs, {
            ...execOpts,
            shell: true,
          });
        } catch {}
      }

      try {
        // Final fallback: resolve through cmd PATH lookup, still piping prompt on stdin.
        return execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], execOpts);
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

function runSourceFetchSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const outIdx = argv.indexOf('--out');
  const errIdx = argv.indexOf('--err');
  const extraIdx = argv.indexOf('--extra');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? argv[errIdx + 1] : undefined;
  const extraB64 = extraIdx !== -1 ? argv[extraIdx + 1] : undefined;

  let extra = {};
  if (extraB64) {
    try { extra = JSON.parse(Buffer.from(extraB64, 'base64').toString('utf-8')); }
    catch { console.warn('[demo-task-executor] bad --extra base64, ignoring'); }
  }

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
    // Uses curl (synchronous subprocess) to avoid Node.js libuv handle issues.
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
      const chartCacheKey = cacheKey('chartApi:' + tickers.sort().join(',') + chartCfg.url);
      const cached = readCache(chartCacheKey);
      if (cached) {
        console.warn(`[demo-task-executor] chartApi: cache hit for [${tickers.join(', ')}]`);
        resultValue = cached;
      } else {
        try {
          const results = [];
          for (const ticker of tickers) {
            const url = interpolatePrompt(chartCfg.url, { ticker });
            const data = curlFetchJson(url, 'GET', headers);
            const meta = data?.chart?.result?.[0]?.meta;
            if (!meta) throw new Error(`No chart meta for ${ticker}`);
            // Map to quote-compatible shape; compute change from chartPreviousClose
            const price = meta.regularMarketPrice ?? 0;
            const prevClose = meta.chartPreviousClose ?? price;
            const change = price - prevClose;
            const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
            results.push({
              symbol: meta.symbol ?? ticker,
              shortName: meta.shortName ?? meta.longName ?? ticker,
              regularMarketPrice: price,
              regularMarketChange: change,
              regularMarketChangePercent: changePct,
            });
          }
          resultValue = { quoteResponse: { result: results, error: null } };
          writeCache(chartCacheKey, resultValue);
        } catch (chartErr) {
          fail(`chartApi fetch failed: ${chartErr.message}`, errFile);
        }
      }
    }

    if (resultValue === undefined) {
      fail('chartApi: no tickers resolved — cannot fetch', errFile);
    }

  } else if (sourceDef.http) {
    // ---------------------------------------------------------------------------
    // HTTP source kind — uses curl (synchronous subprocess)
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

    const httpCacheKey = cacheKey(`http:${method}:${url}`);
    const httpCached = readCache(httpCacheKey);
    if (httpCached && !httpFetchSkipped) {
      console.warn(`[demo-task-executor] http: cache hit for ${url}`);
      resultValue = httpCached;
    } else {
      try {
        if (httpFetchSkipped) {
          throw new Error('tickersFrom resolved to empty list — skipping fetch');
        }
        resultValue = curlFetchJson(url, method, headers);
        writeCache(httpCacheKey, resultValue);
      } catch (httpErr) {
        fail(`HTTP fetch failed: ${httpErr.message}`, errFile);
      }
    }

  } else if (sourceDef.copilot || sourceDef.prompt_template) {
    const prompt = resolveCopilotPrompt(sourceDef);
    if (!prompt) {
      fail('Source definition missing copilot.prompt_template (or prompt_template)', errFile);
    }

    // Use boardSetupRoot (from --extra) as copilot working directory
    const copilotCwd = extra.boardSetupRoot || undefined;
    let rawOutput = '';
    try {
      rawOutput = runCopilotPrompt(prompt, copilotCwd);
    } catch (err) {
      const msg = String(err && err.message || err);
      fail(`copilot invocation failed: ${msg}`, errFile);
    }

    const cleaned = stripCopilotFooter(rawOutput);
    // If the response is a JSON object/array, parse it so downstream compute
    // can reference fields directly (e.g. fetched_sources.analysis.mix).
    try {
      const parsed = JSON.parse(cleaned);
      resultValue = (parsed && typeof parsed === 'object') ? parsed : cleaned;
    } catch {
      resultValue = cleaned;
    }
  } else if (sourceDef.mock) {
    // MOCK_DB lookup — data hardcoded at the top of this file
    resultValue = MOCK_DB[sourceDef.mock];
    if (resultValue === undefined) {
      fail(`Key "${sourceDef.mock}" not found in MOCK_DB`, errFile);
    }
  } else {
    fail('Source definition has no recognised kind (copilot, http, chartApi, mock)', errFile);
  }

  // Write result to --out as JSON payload, same contract as current mock mode.
  try {
    fs.writeFileSync(outFile, JSON.stringify(resultValue, null, 2));
  } catch (err) {
    fail(`Cannot write output file: ${String(err && err.message || err)}`, errFile);
  }

}

// ---------------------------------------------------------------------------
// validate-source-def — structural validation of a source definition
// ---------------------------------------------------------------------------
function validateSourceDefSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;

  if (!inFile) {
    console.error('[demo-task-executor] Usage: validate-source-def --in <source.json>');
    process.exit(1);
  }

  if (!fs.existsSync(inFile)) {
    console.log(JSON.stringify({ ok: false, errors: [`Input file not found: ${inFile}`] }));
    process.exit(1);
  }

  let sourceDef;
  try {
    sourceDef = readJson(inFile);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`Cannot parse source file: ${err && err.message || err}`] }));
    process.exit(1);
  }

  const errors = [];

  // Determine source kind and validate required fields
  const hasChartApi = !!sourceDef.chartApi;
  const hasHttp = !!sourceDef.http;
  const hasCopilot = !!sourceDef.copilot;
  const hasPromptTemplate = typeof sourceDef.prompt_template === 'string';
  const hasMock = sourceDef.mock !== undefined;

  const kindCount = [hasChartApi, hasHttp, hasCopilot || hasPromptTemplate, hasMock].filter(Boolean).length;

  if (kindCount === 0) {
    errors.push('No recognised source kind (copilot, http, chartApi, mock). Add one of these fields.');
  } else if (kindCount > 1) {
    const kinds = [];
    if (hasChartApi) kinds.push('chartApi');
    if (hasHttp) kinds.push('http');
    if (hasCopilot || hasPromptTemplate) kinds.push('copilot');
    if (hasMock) kinds.push('mock');
    errors.push(`Multiple source kinds specified: [${kinds.join(', ')}]. Use exactly one.`);
  }

  if (hasChartApi) {
    if (typeof sourceDef.chartApi !== 'object') {
      errors.push('chartApi must be an object.');
    } else {
      if (!sourceDef.chartApi.url || typeof sourceDef.chartApi.url !== 'string') {
        errors.push('chartApi.url is required and must be a string.');
      }
    }
    if (!sourceDef.tickersFrom || typeof sourceDef.tickersFrom !== 'string') {
      errors.push('chartApi requires tickersFrom (string, e.g. "holdings.ticker").');
    }
  }

  if (hasHttp) {
    if (typeof sourceDef.http !== 'object') {
      errors.push('http must be an object.');
    } else {
      if (!sourceDef.http.url || typeof sourceDef.http.url !== 'string') {
        errors.push('http.url is required and must be a string.');
      }
    }
  }

  if (hasCopilot) {
    if (typeof sourceDef.copilot !== 'object') {
      errors.push('copilot must be an object.');
    } else {
      if (!sourceDef.copilot.prompt_template && !hasPromptTemplate) {
        errors.push('copilot.prompt_template is required (or use top-level prompt_template).');
      }
    }
  }

  if (hasMock) {
    if (typeof sourceDef.mock !== 'string') {
      errors.push('mock must be a string key.');
    }
  }

  const result = { ok: errors.length === 0, errors };
  console.log(JSON.stringify(result));
  process.exit(errors.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// describe-capabilities — introspection metadata for this executor
// ---------------------------------------------------------------------------
const CAPABILITIES = {
  version: '1.0',
  executor: 'demo-task-executor',
  subcommands: ['run-source-fetch', 'describe-capabilities', 'validate-source-def'],
  sourceKinds: {
    mock: {
      description: 'Look up a key in a hardcoded MOCK_DB dictionary.',
      inputSchema: {
        mock: { type: 'string', required: true, description: 'Key in MOCK_DB (e.g. "quotes").' },
      },
      outputShape: 'Arbitrary JSON — depends on the mock key.',
      example: {
        input:  { mock: 'quotes' },
        output: { quoteResponse: { result: [{ symbol: 'AAPL', regularMarketPrice: 198.15 }], error: null } },
      },
    },
    copilot: {
      description: 'Invoke GitHub Copilot CLI with an interpolated prompt template.',
      inputSchema: {
        copilot: {
          type: 'object', required: false,
          description: 'Object with prompt_template (string) and optional args (object).',
          properties: {
            prompt_template: { type: 'string', required: true, description: 'Prompt with {{key}} placeholders.' },
            args:            { type: 'object', required: false, description: 'Extra interpolation args (highest precedence).' },
          },
        },
        prompt_template: { type: 'string', required: false, description: 'Shorthand — top-level prompt template (alternative to copilot.prompt_template).' },
      },
      outputShape: 'string | object — raw Copilot text, or parsed JSON if the response is valid JSON.',
    },
    http: {
      description: 'Fetch a URL via curl. Supports {{key}} interpolation and tickersFrom extraction.',
      inputSchema: {
        http: {
          type: 'object', required: true,
          properties: {
            url:     { type: 'string', required: true,  description: 'URL template with {{key}} placeholders.' },
            method:  { type: 'string', required: false, description: 'HTTP method (default: GET).' },
            headers: { type: 'object', required: false, description: 'Request headers.' },
            args:    { type: 'object', required: false, description: 'Extra interpolation args for URL template.' },
          },
        },
        tickersFrom: { type: 'string', required: false, description: '"tokenName.fieldName" — extract tickers from _requires for URL interpolation.' },
      },
      outputShape: 'Arbitrary JSON — the parsed response body from the URL.',
    },
    chartApi: {
      description: 'Yahoo Finance chart API — one request per ticker, mapped to quote-compatible shape.',
      inputSchema: {
        chartApi: {
          type: 'object', required: true,
          properties: {
            url:     { type: 'string', required: true,  description: 'Chart API URL with {{ticker}} placeholder.' },
            headers: { type: 'object', required: false, description: 'Request headers.' },
          },
        },
        tickersFrom: { type: 'string', required: true, description: '"tokenName.fieldName" — extract ticker symbols from _requires.' },
      },
      outputShape: '{ quoteResponse: { result: [{ symbol, shortName, regularMarketPrice, regularMarketChange, regularMarketChangePercent }], error } }',
      example: {
        input:  { chartApi: { url: 'https://query2.finance.yahoo.com/v8/finance/chart/{{ticker}}?range=1d&interval=1d' }, tickersFrom: 'holdings.ticker' },
        output: { quoteResponse: { result: [{ symbol: 'AAPL', shortName: 'Apple Inc.', regularMarketPrice: 198.15, regularMarketChange: 2.15, regularMarketChangePercent: 1.10 }], error: null } },
      },
    },
  },
  extraSchema: {
    description: 'Board topology context passed via --extra (base64-encoded JSON, baked at init).',
    properties: {
      boardSetupRoot:   { type: 'string', description: 'Absolute path to board root.' },
      boardId:          { type: 'string', description: 'Board identifier.' },
      boardRuntimeDir:  { type: 'string', description: 'Relative path to runtime dir.' },
      runtimeStatusDir: { type: 'string', description: 'Relative path to runtime-out dir.' },
      cardsDir:         { type: 'string', description: 'Relative path to cards dir.' },
    },
  },
};

function describeCapabilities() {
  console.log(JSON.stringify(CAPABILITIES, null, 2));
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'describe-capabilities') {
    describeCapabilities();
    return;
  }
  if (sub === 'validate-source-def') {
    validateSourceDefSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[demo-task-executor] fatal: ${err && err.message || err}`);
  process.exit(1);
});
