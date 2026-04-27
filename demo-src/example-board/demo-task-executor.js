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
 *     "_projections":   { "refKey": <resolvedValue> }, // named projections from card_data/requires,
 *                                               // declared in source_defs[].projections and resolved
 *                                               // by the engine before invoking the executor
 *     // ...plus any custom fields authored on the source entry (bindTo, outputFile, projections, etc.)
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
 *   - { workiq: { query_template, args? } }   → call WorkIQ (M365 Copilot) with interpolated query
 *   - { "url": { url, method?, headers?, args?, cacheTimeout? }, tickersFrom? }
 *       → single URL fetch via curl with {{key}} interpolation from _projections
 *   - { "url-list": { method?, headers?, cacheTimeout? } }
 *       → fan-out over _projections.url_list (string[]); returns array of responses.
 *         Build url_list in projections: e.g. `requires.holdings.ticker.('https://host/' & $ & '?q=1')`
 *   - { chartApi: { url, headers? }, tickersFrom }  → removed; use url-list instead
 *     prefer url-list for new sources
 *   A real executor can also handle: graphapi, teams, mail, incidentdb, script, etc.
 *
 * url / url-list notes:
 *   - Results cached in os.tmpdir()/demo-executor-cache/ per URL (default 1 hour, override via cacheTimeout)
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
// Simple file cache for url / url-list results.
// Stored in os.tmpdir()/demo-executor-cache/<hash>.json
// ---------------------------------------------------------------------------
const CACHE_DIR = path.join(os.tmpdir(), 'demo-executor-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function readCache(key, ttlMs = CACHE_TTL_MS) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}
  return null;
}

// Shared single-URL fetch helper used by both url and url-list.
// cacheTimeoutSec: override TTL in seconds (null → use CACHE_TTL_MS default).
function doFetchApi(url, method, headers, cacheTimeoutSec, errFile) {
  const ttlMs = cacheTimeoutSec != null ? cacheTimeoutSec * 1000 : CACHE_TTL_MS;
  const k = cacheKey(`url:${method}:${url}`);
  const cached = readCache(k, ttlMs);
  if (cached) {
    console.warn(`[demo-task-executor] url: cache hit for ${url}`);
    return cached;
  }
  const data = curlFetchJson(url, method, headers);
  writeCache(k, data);
  return data;
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

// Reusable prompt fragments available to all copilot source templates.
// Source definitions can interpolate them with {{view_kind_guidance}} and {{card_layout_guidance}}.
const COPILOT_PROMPT_CONTEXT = {
  view_kind_guidance: [
    'VIEW KIND GUIDANCE (for dynamic ref rendering):',
    '- Return a _view object whenever your output data is meant for a ref element.',
    '- Allowed _view.kind values only: table, editable-table, chart, metric, list, badge, text, narrative, markdown, form, filter, todo, alert.',
    '- If uncertain, use "table".',
    '- For array rows that users should edit, prefer "editable-table" and set _view.data.writeTo to a card_data path.',
    '- For chart, set _view.data.chartType and _view.data.columns with [labelField, valueField].',
    '- Keep _view.data minimal and valid JSON (no comments, no trailing text).',
  ].join('\n'),
  card_layout_guidance: [
    'CARD LAYOUT GUIDANCE:',
    '- Prefer compact outputs that fit a card: one primary structure plus concise rationale text.',
    '- Avoid repeating values already present in upstream inputs.',
    '- If you produce both machine-readable and human-readable content, keep machine-readable fields top-level and concise prose in a separate field.',
  ].join('\n'),
};

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

function resolveCopilotPrompt(sourceDef) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};
  
  // Merge _projections into template interpolation context.
  // _projections contains the named data projections declared in source_defs[].projections,
  // evaluated by the engine from card_data/requires before invoking this executor.
  // Explicit args defined on the source take highest precedence.
  const interpolationContext = {
    ...COPILOT_PROMPT_CONTEXT,
    ...sourceDef._projections,
    ...args,
  };
  
  if (!template || typeof template !== 'string') return null;
  return interpolatePrompt(template, interpolationContext);
}

/**
 * Run a copilot prompt via copilot_wrapper.bat (Windows only).
 *
 * The wrapper handles:
 *   - Session management (--resume UUID for multi-turn continuity)
 *   - Noise/footer stripping (via copilot_wrapper_helper.ps1)
 *   - JSON mode extraction with optional result_shape key matching
 *   - Agentic retry: if the first response isn't valid JSON, the wrapper calls
 *     copilot again in the same session with a correction prompt, then re-extracts.
 *
 * @param {string} prompt         - interpolated prompt string
 * @param {object} sourceDef      - source definition (may contain copilot.result_shape)
 * @param {string} wrapperOutFile - path the wrapper writes its JSON output to
 * @param {string} sessionDir     - persistent dir for session UUID (enables --resume)
 * @param {string} cwd            - working directory for copilot (boardSetupRoot)
 * @returns {unknown} parsed JSON result value
 */
function runCopilotViaWrapper(prompt, sourceDef, wrapperOutFile, sessionDir, cwd) {
  const wrapperPath = path.join(__dirname, 'scripts', 'copilot_wrapper.bat');

  const promptFile = wrapperOutFile + '.prompt.txt';
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  // Optional result_shape_file: top-level keys the response JSON must contain.
  // Sourced from sourceDef.copilot.result_shape or sourceDef.result_shape.
  let shapeFile = '';
  const shape = sourceDef?.copilot?.result_shape ?? sourceDef?.result_shape;
  if (shape && typeof shape === 'object') {
    shapeFile = wrapperOutFile + '.shape.json';
    fs.writeFileSync(shapeFile, JSON.stringify(shape), 'utf-8');
  }

  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    execFileSync('cmd.exe', [
      '/d', '/c',
      wrapperPath,
      wrapperOutFile,                    // OUTPUT_FILE
      sessionDir,                        // SESSION_DIR
      cwd || process.cwd(),             // WORKING_DIR
      '@' + promptFile,                 // REQUEST_OR_FILE (@ prefix = file path)
      'json',                           // RESULT_TYPE — wrapper extracts JSON + retries
      sourceDef.bindTo || 'executor',   // AGENT_NAME (for log file naming)
      '',                               // MODEL (empty = wrapper default)
      shapeFile,                        // RESULT_SHAPE_FILE (empty = accept any JSON)
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    if (shapeFile) { try { fs.unlinkSync(shapeFile); } catch {} }
  }

  return JSON.parse(fs.readFileSync(wrapperOutFile, 'utf-8').replace(/^\uFEFF/, ''));
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

  if (sourceDef['url']) {
    // ---------------------------------------------------------------------------
    // url — single URL fetch via curl
    // {{key}} interpolation applied to url from _projections and optional args.
    // cacheTimeout: seconds to cache the response (default: CACHE_TTL_MS / 1000).
    // ---------------------------------------------------------------------------
    const cfg     = sourceDef['url'];
    const method  = (cfg.method || 'GET').toUpperCase();
    const headers = { ...(cfg.headers || {}) };
    const cacheTimeoutSec = cfg.cacheTimeout != null ? Number(cfg.cacheTimeout) : null;

    const fetchArgs = { ...(cfg.args || {}) };
    if (sourceDef.tickersFrom) {
      const dotIdx = sourceDef.tickersFrom.indexOf('.');
      if (dotIdx > 0) {
        const refKey    = sourceDef.tickersFrom.slice(0, dotIdx);
        const fieldName = sourceDef.tickersFrom.slice(dotIdx + 1);
        const arr = sourceDef._projections?.[refKey];
        if (Array.isArray(arr)) {
          fetchArgs.tickers = arr.map(h => h[fieldName]).filter(Boolean).join(',');
        }
      }
    }
    if (sourceDef.tickersFrom && !fetchArgs.tickers) {
      fail('url: tickersFrom resolved to empty list — skipping fetch', errFile);
    }
    const urlContext = { ...(sourceDef._projections || {}), ...fetchArgs };
    const url = interpolatePrompt(cfg.url, urlContext);
    try {
      resultValue = doFetchApi(url, method, headers, cacheTimeoutSec, errFile);
    } catch (err) {
      fail(`url failed: ${err.message}`, errFile);
    }

  } else if (sourceDef['url-list']) {
    // ---------------------------------------------------------------------------
    // url-list — fan-out over a URL list, calling url logic per URL.
    // url_list must be a string[] pre-resolved in _projections.url_list.
    // cacheTimeout: seconds to cache each individual response.
    // ---------------------------------------------------------------------------
    const cfg     = sourceDef['url-list'];
    const method  = (cfg.method || 'GET').toUpperCase();
    const headers = { ...(cfg.headers || {}) };
    const cacheTimeoutSec = cfg.cacheTimeout != null ? Number(cfg.cacheTimeout) : null;

    const urlList = Array.isArray(sourceDef._projections?.url_list)
      ? sourceDef._projections.url_list : null;

    if (!urlList || urlList.length === 0) {
      fail('url-list: _projections.url_list must be a non-empty string array', errFile);
    }

    const results = [];
    for (const u of urlList) {
      try {
        results.push(doFetchApi(u, method, headers, cacheTimeoutSec, errFile));
      } catch (err) {
        fail(`url-list fetch failed for ${u}: ${err.message}`, errFile);
      }
    }
    resultValue = results;

  } else if (sourceDef.copilot || sourceDef.prompt_template) {
    const prompt = resolveCopilotPrompt(sourceDef);
    if (!prompt) {
      fail('Source definition missing copilot.prompt_template (or prompt_template)', errFile);
    }

    // Use boardSetupRoot (from --extra) as copilot working directory
    const copilotCwd = extra.boardSetupRoot || undefined;

    // On Windows, delegate entirely to copilot_wrapper.bat which handles:
    //   - session management (--resume UUID for multi-turn continuity)
    //   - noise/footer stripping, JSON extraction, agentic retry on bad shape
    // On non-Windows, fall back to a basic direct invocation (no retry).
    const wrapperPath = path.join(__dirname, 'scripts', 'copilot_wrapper.bat');
    const useWrapper = process.platform === 'win32' && fs.existsSync(wrapperPath);

    if (useWrapper) {
      // Session dir is stable across refreshes so --resume continues the conversation.
      const sessionDir = path.join(
        extra.boardSetupRoot || os.tmpdir(),
        'copilot-sessions',
        String(sourceDef.bindTo || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      const wrapperOutFile = outFile + '.wrapper-out.json';
      try {
        resultValue = runCopilotViaWrapper(prompt, sourceDef, wrapperOutFile, sessionDir, copilotCwd);
      } catch (err) {
        fail(`copilot invocation failed: ${String(err && err.message || err)}`, errFile);
      } finally {
        try { fs.unlinkSync(wrapperOutFile); } catch {}
      }
    } else {
      // Non-Windows fallback: call copilot directly via cmd.exe and do basic JSON extraction.
      let rawOutput = '';
      try {
        rawOutput = execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
          input: String(prompt),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          ...(copilotCwd ? { cwd: copilotCwd } : {}),
        });
      } catch (err) {
        fail(`copilot invocation failed: ${String(err && err.message || err)}`, errFile);
      }
      // Basic JSON extraction: find first { or [ in output
      const firstBrace = rawOutput.indexOf('{');
      const firstBracket = rawOutput.indexOf('[');
      const jsonStart = (firstBrace === -1) ? firstBracket
        : (firstBracket === -1) ? firstBrace
        : Math.min(firstBrace, firstBracket);
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(rawOutput.slice(jsonStart));
          resultValue = (parsed && typeof parsed === 'object') ? parsed : rawOutput;
        } catch {
          resultValue = rawOutput;
        }
      } else {
        resultValue = rawOutput;
      }
    }
  } else if (sourceDef.workiq) {
    const cfg = typeof sourceDef.workiq === 'object' ? sourceDef.workiq : {};
    if (!cfg.query_template || typeof cfg.query_template !== 'string') {
      fail('Source definition missing workiq.query_template', errFile);
    }
    const interpolationContext = { ...sourceDef._projections, ...(cfg.args ?? {}) };
    const query = interpolatePrompt(cfg.query_template, interpolationContext);

    const wrapperPath = path.join(__dirname, 'scripts', 'workiq_wrapper.mjs');
    if (!fs.existsSync(wrapperPath)) {
      fail('workiq source kind requires workiq_wrapper.js in scripts/', errFile);
    }
    try {
      execFileSync(process.execPath, [wrapperPath, outFile], {
        encoding: 'utf-8',
        stdio: ['inherit', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          WORKIQ_QUERY: query,
          ...(extra.serverUrl ? { WORKIQ_SERVER_URL: extra.serverUrl } : {}),
        },
      });
      return; // wrapper wrote directly to outFile
    } catch (err) {
      fail(`workiq invocation failed: ${String(err && err.message || err)}`, errFile);
    }
  } else if (sourceDef.mock) {
    // MOCK_DB lookup — data hardcoded at the top of this file
    resultValue = MOCK_DB[sourceDef.mock];
    if (resultValue === undefined) {
      fail(`Key "${sourceDef.mock}" not found in MOCK_DB`, errFile);
    }
  } else {
    fail('Source definition has no recognised kind (url, url-list, copilot, workiq, mock)', errFile);
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
  const hasUrl   = !!sourceDef['url'];
  const hasUrlList  = !!sourceDef['url-list'];
  const hasCopilot    = !!sourceDef.copilot;
  const hasPromptTemplate = typeof sourceDef.prompt_template === 'string';
  const hasWorkiq     = !!sourceDef.workiq;
  const hasMock       = sourceDef.mock !== undefined;

  const kindCount = [hasUrl, hasUrlList, hasCopilot || hasPromptTemplate, hasWorkiq, hasMock].filter(Boolean).length;

  if (kindCount === 0) {
    errors.push('No recognised source kind (url, url-list, copilot, workiq, mock). Add one of these fields.');
  } else if (kindCount > 1) {
    const kinds = [];
    if (hasUrl)  kinds.push('url');
    if (hasUrlList) kinds.push('url-list');
    if (hasCopilot || hasPromptTemplate) kinds.push('copilot');
    if (hasWorkiq)    kinds.push('workiq');
    if (hasMock)      kinds.push('mock');
    errors.push(`Multiple source kinds specified: [${kinds.join(', ')}]. Use exactly one.`);
  }

  if (hasUrl) {
    if (typeof sourceDef['url'] !== 'object') {
      errors.push('url must be an object.');
    } else if (!sourceDef['url'].url || typeof sourceDef['url'].url !== 'string') {
      errors.push('url.url is required and must be a string.');
    }
  }

  if (hasUrlList) {
    if (typeof sourceDef['url-list'] !== 'object') {
      errors.push('url-list must be an object.');
    }
    // url_list is supplied via _projections at runtime — no static validation needed.
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

  if (hasWorkiq) {
    if (typeof sourceDef.workiq !== 'object') {
      errors.push('workiq must be an object.');
    } else if (!sourceDef.workiq.query_template || typeof sourceDef.workiq.query_template !== 'string') {
      errors.push('workiq.query_template is required and must be a string.');
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
    workiq: {
      description: 'Query WorkIQ (Microsoft 365 Copilot) with an interpolated query template. Returns raw text response.',
      inputSchema: {
        workiq: {
          type: 'object', required: true,
          properties: {
            query_template: { type: 'string', required: true,  description: 'Query with {{key}} placeholders interpolated from _projections and args.' },
            args:            { type: 'object', required: false, description: 'Extra interpolation args (highest precedence).' },
          },
        },
      },
      outputShape: 'string — raw M365 Copilot response text.',
      note: 'Requires workiq CLI installed and Azure CLI logged in (az login).',
    },
    'url': {
      description: 'Single URL fetch via curl with {{key}} interpolation from _projections. Supports cacheTimeout.',
      inputSchema: {
        'url': {
          type: 'object', required: true,
          properties: {
            url:          { type: 'string', required: true,  description: 'URL template with {{key}} placeholders.' },
            method:       { type: 'string', required: false, description: 'HTTP method (default: GET).' },
            headers:      { type: 'object', required: false, description: 'Request headers.' },
            args:         { type: 'object', required: false, description: 'Extra interpolation args (highest precedence).' },
            cacheTimeout: { type: 'number', required: false, description: 'Cache TTL in seconds (default: 3600).' },
          },
        },
        tickersFrom: { type: 'string', required: false, description: '"refKey.fieldName" — join tickers from _projections into {{tickers}}.' },
      },
      outputShape: 'Arbitrary JSON from the fetched URL.',
    },
    'url-list': {
      description: 'Fan-out over a pre-resolved URL list — calls url logic per URL and returns an array of responses. url_list must be a string[] in _projections.url_list (built via projections JSONata).',
      inputSchema: {
        'url-list': {
          type: 'object', required: true,
          properties: {
            method:       { type: 'string', required: false, description: 'HTTP method (default: GET).' },
            headers:      { type: 'object', required: false, description: 'Request headers.' },
            cacheTimeout: { type: 'number', required: false, description: 'Cache TTL per URL in seconds (default: 3600).' },
          },
        },
      },
      outputShape: 'Array of raw JSON responses, one per URL in _projections.url_list.',
      urlListNote: 'Declare `"projections": { "url_list": "<JSONata producing string[]>" }` on the source def. Example: `requires.holdings.ticker.(\'https://api.example.com/\' & $ & \'?q=1\')`',
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
      serverUrl:        { type: 'string', description: 'Base URL of the hosting server (e.g. http://127.0.0.1:7799). Used by source kinds that call server-side proxy endpoints.' },
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
