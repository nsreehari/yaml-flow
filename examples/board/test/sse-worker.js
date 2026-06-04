/**
 * sse-worker.js
 *
 * SSE consumer worker thread.
 *
 * Spawned by demo-http-test.js via worker_threads.
 * Receives { sseUrl } in workerData, opens the SSE stream, and forwards
 * every parsed frame to the main thread via parentPort.postMessage.
 *
 * Messages posted to main thread:
 *   { type: 'frame',  payload: <parsed SSE frame object> }
 *   { type: 'error',  message: <string> }
 *   { type: 'closed' }
 */

import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';

const { sseUrl } = workerData;

const req = http.get(sseUrl, (res) => {
  let buf = '';
  res.setEncoding('utf-8');
  res.on('data', (chunk) => {
    // Normalize CRLF-delimited SSE blocks to a single delimiter style.
    buf += chunk.replace(/\r\n/g, '\n');
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx === -1) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      const data = dataLines.join('\n');
      if (!data) continue;
      try {
        parentPort.postMessage({ type: 'frame', payload: JSON.parse(data) });
      } catch { /* ignore malformed */ }
    }
  });
  res.on('end', () => parentPort.postMessage({ type: 'closed' }));
  res.on('error', (err) => parentPort.postMessage({ type: 'error', message: err.message }));
});

req.on('error', (err) => parentPort.postMessage({ type: 'error', message: err.message }));
