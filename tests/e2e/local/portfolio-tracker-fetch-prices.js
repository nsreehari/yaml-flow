#!/usr/bin/env node
/**
 * portfolio-tracker-fetch-prices.js
 *
 * Task executor for the portfolio board demo.
 * Handles run-source-fetch requests for source_defs with kind: "mock-quotes".
 * Generates random prices (2dp, 10.00–999.99) for each projected ticker.
 *
 * Subcommands:
 *   run-source-fetch      — fetch mock prices for tickers from _projections
 *   validate-source-def   — validate source def structure; prints { ok, errors } JSON
 *   describe-capabilities — print executor capabilities JSON
 *
 * run-source-fetch protocol:
 *   node portfolio-tracker-fetch-prices.js run-source-fetch \
 *     --in-ref <::kind::value> \
 *     --out-ref <::kind::value> \
 *     --err-ref <::kind::value>
 *
 * validate-source-def protocol:
 *   node portfolio-tracker-fetch-prices.js validate-source-def --in <source.json>
 */

import fs from 'node:fs';
import { parseRef, blobStorageForRef, reportComplete, reportFailed } from 'yaml-flow/storage-refs';

// ---------------------------------------------------------------------------
// validate-source-def — structural validation of a source definition
// ---------------------------------------------------------------------------
function validateSourceDefSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;

  if (!inFile) {
    console.error('[portfolio-tracker-fetch-prices] Usage: validate-source-def --in <source.json>');
    process.exit(1);
  }

  if (!fs.existsSync(inFile)) {
    console.log(JSON.stringify({ ok: false, errors: [`Input file not found: ${inFile}`] }));
    process.exit(1);
  }

  let sourceDef;
  try {
    sourceDef = JSON.parse(fs.readFileSync(inFile, 'utf-8'));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`Cannot parse source file: ${err && err.message || err}`] }));
    process.exit(1);
  }

  const errors = [];

  if (sourceDef.kind !== 'mock-quotes') {
    errors.push(`kind must be "mock-quotes"; got "${sourceDef.kind}".`);
  }
  if (!sourceDef.bindTo || typeof sourceDef.bindTo !== 'string') {
    errors.push('bindTo is required and must be a string.');
  }
  if (!sourceDef.outputFile || typeof sourceDef.outputFile !== 'string') {
    errors.push('outputFile is required and must be a string.');
  }
  if (!sourceDef.projections || typeof sourceDef.projections.tickers !== 'string') {
    errors.push('projections.tickers is required and must be a JSONata expression string.');
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
  executor: 'portfolio-tracker-fetch-prices',
  subcommands: ['run-source-fetch', 'validate-source-def', 'describe-capabilities'],
  sourceKinds: {
    'mock-quotes': {
      description: 'Generates random mock market prices (10.00–999.99) for each ticker in _projections.tickers.',
      inputSchema: {
        kind:       { type: 'string', required: true,  description: 'Must be "mock-quotes".' },
        bindTo:     { type: 'string', required: true,  description: 'Token name for the output binding.' },
        outputFile: { type: 'string', required: true,  description: 'Relative path to write prices JSON.' },
        projections: {
          type: 'object', required: true,
          properties: {
            tickers: { type: 'string', required: true, description: 'JSONata expression resolving to a string[] of ticker symbols (e.g. "requires.holdings.symbol").' },
          },
        },
      },
      outputShape: '{ [ticker: string]: number } — map of ticker symbol to random price (2dp).',
      example: {
        input:  { kind: 'mock-quotes', bindTo: 'prices', outputFile: 'prices.json', projections: { tickers: 'requires.holdings.symbol' } },
        output: { AAPL: 152.34, MSFT: 310.45 },
      },
    },
  },
};

function describeCapabilities() {
  console.log(JSON.stringify(CAPABILITIES, null, 2));
}

// ---------------------------------------------------------------------------
// run-source-fetch — generate random prices and report back
// ---------------------------------------------------------------------------
async function runSourceFetchSubcommand(argv) {
  let inRefStr = '';
  let outRefStr = '';
  let errRefStr = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in-ref' && i + 1 < argv.length)  inRefStr  = argv[++i];
    else if (argv[i] === '--out-ref' && i + 1 < argv.length) outRefStr = argv[++i];
    else if (argv[i] === '--err-ref' && i + 1 < argv.length) errRefStr = argv[++i];
  }

  if (!inRefStr || !outRefStr || !errRefStr) {
    console.error(
      'Usage: portfolio-tracker-fetch-prices.js run-source-fetch' +
      ' --in-ref <ref> --out-ref <ref> --err-ref <ref>',
    );
    process.exit(1);
  }

  const inRef  = parseRef(inRefStr);
  const outRef = parseRef(outRefStr);
  const errRef = parseRef(errRefStr);

  const inStorage  = blobStorageForRef(inRef);
  const outStorage = blobStorageForRef(outRef);
  const errStorage = blobStorageForRef(errRef);

  // Read and parse the envelope up front so `callback` is always available for
  // reportFailed — even if a later validation step throws.
  const rawIn = inStorage.read(inRef.value);
  if (!rawIn) {
    console.error(`[portfolio-tracker-fetch-prices] input envelope not found at: ${inRefStr}`);
    process.exit(1);
  }
  const envelope = JSON.parse(rawIn);
  const callback = envelope.source_def ? envelope.callback : undefined;

  let didReport = false;
  const safeReportFailed = (msg) => {
    if (didReport) return;
    didReport = true;
    try { errStorage.write(errRef.value, msg); } catch { /* best-effort */ }
    if (callback) { reportFailed(callback, msg); } else { process.exit(1); }
  };

  try {
    const sourceDef = envelope.source_def ?? envelope;

    if (sourceDef.kind !== 'mock-quotes') {
      throw new Error(`Unsupported source kind: expected "mock-quotes", got "${sourceDef.kind}"`);
    }

    const tickers = sourceDef._projections?.tickers;
    if (!Array.isArray(tickers)) {
      throw new Error('sourceDef._projections.tickers is missing or not an array');
    }

    // Random 200–300 ms delay (simulates a real market data fetch)
    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100));

    // Generate random prices — 2dp, range 10.00–999.99
    const prices = {};
    for (const ticker of tickers) {
      prices[ticker] = Math.round((10 + Math.random() * 989.99) * 100) / 100;
    }

    outStorage.write(outRef.value, JSON.stringify(prices));
    console.log(`[portfolio-tracker-fetch-prices] wrote prices for: ${tickers.join(', ')}`);

    didReport = true;
    if (callback) {
      reportComplete(callback, outRef);
    } else {
      process.exit(0);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[portfolio-tracker-fetch-prices] error: ${msg}`);
    safeReportFailed(msg);
  }
}

// ---------------------------------------------------------------------------
// main — subcommand routing
// ---------------------------------------------------------------------------
async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    await runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'validate-source-def') {
    validateSourceDefSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'describe-capabilities') {
    describeCapabilities();
    return;
  }
  console.error(
    'Usage: portfolio-tracker-fetch-prices.js <subcommand> [...args]\n' +
    'Subcommands: run-source-fetch, validate-source-def, describe-capabilities',
  );
  process.exit(1);
}

main().catch(err => {
  console.error(`[portfolio-tracker-fetch-prices] fatal: ${err && err.message || err}`);
  process.exit(1);
});
