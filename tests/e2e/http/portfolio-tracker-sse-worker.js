/**
 * portfolio-tracker-sse-worker.js
 *
 * SSE consumer worker thread.
 *
 * Spawned by portfolio-tracker-http-test.js via worker_threads.
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
    buf += chunk;
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx === -1) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) data = line.slice(6);
      }
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

// Worker stays alive as long as the SSE connection is open.
// Main thread calls sseWorker.terminate() to clean up.
