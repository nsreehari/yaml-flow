import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { invokeStepMachineExecutionRef } from '../src/cli/public/board-worker-adapter.ts';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('board-worker-adapter step-machine invoke support', () => {
  it('applies argsMassaging and outputTransforms for local-process refs', async () => {
    const dir = makeTempDir('yaml-flow-bwa-local-');
    const scriptPath = path.join(dir, 'echo-step.js');
    fs.writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      "const raw = fs.readFileSync(0, 'utf8');",
      "const input = raw ? JSON.parse(raw) : {};",
      "process.stdout.write(JSON.stringify({ result: 'success', data: { message: input.message, flag: input.flag, argv: process.argv.slice(2) } }));",
    ].join('\n'));

    const escapedScriptPath = scriptPath.replace(/\\/g, '\\\\');
    const result = await invokeStepMachineExecutionRef({
      howToRun: 'local-process',
      whatToRun: { kind: 'process-name', value: 'node' },
      argsMassaging: {
        cmdTemplate: [`\"${escapedScriptPath}\"`, `\"--tag\"`, 'tag'],
        stdinTemplate: `{ 'message': text, 'flag': extra.flag }`,
      },
      outputTransforms: {
        dataTemplate: `{ 'reply': output.data.message, 'flag': output.data.flag, 'argv': output.data.argv }`,
      },
      extra: { flag: true },
    }, {
      text: 'hello from test',
      tag: 'probe',
    });

    expect(result).toEqual({
      result: 'success',
      data: {
        reply: 'hello from test',
        flag: true,
        argv: ['--tag', 'probe'],
      },
    });
  });

  it('applies body/header massaging and output transforms for http refs', async () => {
    const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsedBody = body ? JSON.parse(body) : {};
        requests.push({ headers: req.headers, body: parsedBody });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          result: 'success',
          data: {
            echoed: parsedBody.message,
            header: req.headers['x-test-header'],
          },
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('Failed to resolve test server address');
    }

    try {
      const result = await invokeStepMachineExecutionRef({
        howToRun: 'http:post',
        whatToRun: { kind: 'http-url', value: `http://127.0.0.1:${address.port}/invoke` },
        argsMassaging: {
          headerTemplate: `{ 'x-test-header': extra.headerValue }`,
          bodyTemplate: `{ 'message': text }`,
        },
        outputTransforms: {
          dataTemplate: `{ 'reply': output.data.echoed, 'header': output.data.header }`,
        },
        extra: { headerValue: 'adapter-test' },
      }, {
        text: 'hello http',
      });

      expect(result).toEqual({
        result: 'success',
        data: {
          reply: 'hello http',
          header: 'adapter-test',
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({ message: 'hello http' });
      expect(requests[0].headers['x-test-header']).toBe('adapter-test');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
