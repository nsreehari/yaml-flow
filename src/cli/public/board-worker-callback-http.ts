import { spawnSync } from 'node:child_process';

export function reportBoardWorkerCallbackHttpSuccess(baseUrl: string, token: string, ref: string): void {
  postBoardWorkerCallbackHttp(normalizeBoardWebhookUrl(baseUrl), JSON.stringify({
    tool: 'webhook.source-fetch-done',
    args: { token, ref },
  }));
}

export function reportBoardWorkerCallbackHttpFailure(baseUrl: string, token: string, reason: string): void {
  postBoardWorkerCallbackHttp(normalizeBoardWebhookUrl(baseUrl), JSON.stringify({
    tool: 'webhook.source-fetch-failed',
    args: { token, reason },
  }));
}

function normalizeBoardWebhookUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function postBoardWorkerCallbackHttp(url: string, body: string): void {
  const script = `
    const rawUrl = ${JSON.stringify(url)};
    const rawBody = ${JSON.stringify(body)};
    const u = new URL(rawUrl);
    const {request} = require(u.protocol === 'https:' ? 'https' : 'http');
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) };
    const req = request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method:'POST',headers:h}, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        const code = res.statusCode || 500;
        if (code < 200 || code >= 300) {
          const msg = responseBody.trim() || res.statusMessage || ('HTTP ' + code);
          process.stderr.write(msg);
          process.exit(1);
        }
      });
    });
    req.on('error', e => { process.stderr.write(e.message); process.exit(1); });
    req.write(rawBody);
    req.end();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', windowsHide: true });
  if (result.status !== 0) throw new Error(`http-post failed: ${result.stderr?.trim()}`);
}