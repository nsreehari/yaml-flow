#!/usr/bin/env node
/**
 * portfolio-tracker-fetch-prices.js
 *
 * Task executor for the portfolio board demo.
 * Handles run-source-fetch requests for source_defs with kind: "mock-quotes".
 * Generates random prices (2dp, 10.00–999.99) for each projected ticker.
 *
 * Protocol:
 *   node portfolio-tracker-fetch-prices.js run-source-fetch \
 *     --in-ref <::kind::value> \
 *     --out-ref <::kind::value> \
 *     --err-ref <::kind::value>
 */

import { parseRef, blobStorageForRef, reportComplete, reportFailed } from 'yaml-flow/storage-refs';

// ── Arg parsing ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let subcommand = '';
let inRefStr = '';
let outRefStr = '';
let errRefStr = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === 'run-source-fetch') {
    subcommand = 'run-source-fetch';
  } else if (args[i] === '--in-ref' && i + 1 < args.length) {
    inRefStr = args[++i];
  } else if (args[i] === '--out-ref' && i + 1 < args.length) {
    outRefStr = args[++i];
  } else if (args[i] === '--err-ref' && i + 1 < args.length) {
    errRefStr = args[++i];
  }
}

if (subcommand !== 'run-source-fetch' || !inRefStr || !outRefStr || !errRefStr) {
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

// ── Main logic (top-level await — ESM module) ──────────────────────────────────
// Read and parse the envelope up front so `callback` is always available for
// reportFailed — even if a later validation step throws.
const rawIn = inStorage.read(inRef.value);
if (!rawIn) {
  console.error(`[portfolio-tracker-fetch-prices] input envelope not found at: ${inRefStr}`);
  process.exit(1);
}
const _envelope = JSON.parse(rawIn);
const callback = _envelope.source_def ? _envelope.callback : undefined;

let _didReport = false;
const safeReportFailed = (msg) => {
  if (_didReport) return;
  _didReport = true;
  try { errStorage.write(errRef.value, msg); } catch { /* best-effort */ }
  if (callback) { reportFailed(callback, msg); } else { process.exit(1); }
};

try {
  // Step 3: extract sourceDef
  const sourceDef = _envelope.source_def ?? _envelope;

  // Step 4: validate kind
  if (sourceDef.kind !== 'mock-quotes') {
    throw new Error(
      `Unsupported source kind: expected "mock-quotes", got "${sourceDef.kind}"`,
    );
  }

  // Step 5: extract tickers from projections
  const tickers = sourceDef._projections?.tickers;
  if (!Array.isArray(tickers)) {
    throw new Error(
      'sourceDef._projections.tickers is missing or not an array',
    );
  }

  // Step 6: random 200–300 ms delay (simulates a real market data fetch)
  await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100));

  // Step 7: generate random prices — 2dp, range 10.00–999.99
  const prices = {};
  for (const ticker of tickers) {
    prices[ticker] = Math.round((10 + Math.random() * 989.99) * 100) / 100;
  }

  // Step 8: write output
  outStorage.write(outRef.value, JSON.stringify(prices));
  console.log(
    `[portfolio-tracker-fetch-prices] wrote prices for: ${tickers.join(', ')}`,
  );

  // Step 9: report completion
  _didReport = true;
  if (callback) {
    reportComplete(callback, outRef);
  } else {
    process.exit(0);
  }
} catch (error) {
  // Step 10: report failure
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[portfolio-tracker-fetch-prices] error: ${msg}`);
  safeReportFailed(msg);
}
