#!/usr/bin/env node
/**
 * workiq_wrapper.mjs — Calls the demo-server /api/workiq/ask proxy endpoint.
 *
 * Usage: node workiq_wrapper.mjs <out_file>
 *   WORKIQ_QUERY env var:       the interpolated query string
 *   WORKIQ_SERVER_URL env var:  base URL of demo-server (default: http://127.0.0.1:7799)
 *
 * The demo-server has a TTY so workiq can produce output there.
 * Writes raw WorkIQ response text to <out_file>.
 */

import http from 'node:http';
import fs from 'node:fs';

const outFile = process.argv[2];
const query = process.env.WORKIQ_QUERY;
const serverBase = (process.env.WORKIQ_SERVER_URL || 'http://127.0.0.1:7799').replace(/\/$/, '');

if (!outFile) { console.error('workiq_wrapper: missing <out_file> argument'); process.exit(1); }
if (!query)   { console.error('workiq_wrapper: WORKIQ_QUERY env var not set'); process.exit(1); }

const body = JSON.stringify({ query });
const url = new URL('/api/workiq/ask', serverBase);

const reqOptions = {
  hostname: url.hostname,
  port: url.port || 80,
  path: url.pathname,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};

const req = http.request(reqOptions, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.error) {
        fs.writeFileSync(outFile, `workiq error: ${json.error}`, 'utf8');
        process.exit(1);
      }
      fs.writeFileSync(outFile, json.response || '', 'utf8');
      process.exit(0);
    } catch {
      fs.writeFileSync(outFile, data, 'utf8');
      process.exit(0);
    }
  });
});

req.on('error', (err) => {
  fs.writeFileSync(outFile, `workiq proxy error: ${err.message}\nIs demo-server running at ${serverBase}?`, 'utf8');
  process.exit(1);
});

req.setTimeout(60_000, () => {
  req.destroy();
  fs.writeFileSync(outFile, 'workiq proxy timeout after 60s', 'utf8');
  process.exit(1);
});

req.write(body);
req.end();

