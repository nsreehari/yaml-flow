import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createExecutionRefInvoker,
  evaluateArgsMassaging,
  invokeExecutionRef,
  invokeExecutionRefSync,
  serializeRef,
} from '../../src/cli/node/fs-board-adapter.js';
import type { ExecutionRef } from '../../src/cli/common/execution-interface.js';

describe('ExecutionRef public invoker API', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('evaluateArgsMassaging resolves local and http fields against the provided context', () => {
    const result = evaluateArgsMassaging(
      {
        cmdTemplate: ["'run'", 'name'],
        stdinTemplate: '{"token": extra.token, "value": value}',
        urlTemplate: "whatToRun & '?name=' & name",
        headerTemplate: '{"x-token": extra.token}',
        bodyTemplate: '{"payload": value}',
      },
      {
        name: 'demo',
        value: 42,
        whatToRun: 'https://example.test/exec',
        extra: { token: 'abc123' },
      },
      'test-evaluate',
    );

    expect(result).toEqual({
      cmdArgs: ['run', 'demo'],
      stdin: { token: 'abc123', value: 42 },
      url: 'https://example.test/exec?name=demo',
      headers: { 'x-token': 'abc123' },
      body: { payload: 42 },
    });
  });

  it('invokeExecutionRefSync runs local-node refs with argsMassaging and normalizes stdout', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-ref-'));
    const scriptPath = path.join(tmpDir, 'echo.mjs');
    fs.writeFileSync(
      scriptPath,
      [
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        "const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
        "const args = process.argv.slice(2);",
        "console.log(JSON.stringify({ args, payload }));",
      ].join('\n'),
      'utf8',
    );

    const ref: ExecutionRef = {
      howToRun: 'local-node',
      whatToRun: serializeRef({ kind: 'fs-path', value: scriptPath }),
      extra: { token: 'local-extra' },
      argsMassaging: {
        cmdTemplate: ["'--name'", 'name'],
        stdinTemplate: '{"seen": value, "token": extra.token}',
      },
    };

    const result = invokeExecutionRefSync(ref, { name: 'delta', value: 9 });

    expect(result).toEqual({
      result: 'success',
      data: {
        args: ['--name', 'delta'],
        payload: { seen: 9, token: 'local-extra' },
      },
    });
  });

  it('invokeExecutionRef dispatches http:post refs and preserves normalized response envelopes', async () => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'posted', data: { body } }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ref: ExecutionRef = {
        howToRun: 'http:post',
        whatToRun: serializeRef({ kind: 'http-url', value: `http://127.0.0.1:${port}/invoke` }),
        argsMassaging: {
          bodyTemplate: '{"renamed": value}',
        },
      };

      const result = await invokeExecutionRef(ref, { value: 'payload' });
      expect(result).toMatchObject({
        result: 'posted',
        data: { body: { renamed: 'payload' } },
        headers: { 'content-type': 'application/json' },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('createExecutionRefInvoker accepts custom transport handlers for new howToRun values', async () => {
    const invoker = createExecutionRefInvoker({
      transports: {
        'custom:echo': async (ref, args) => ({
          result: 'custom',
          data: {
            meta: ref.meta ?? null,
            args,
          },
        }),
      },
      syncTransports: {
        'custom:echo': (ref, args) => ({
          result: 'custom-sync',
          data: {
            meta: ref.meta ?? null,
            args,
          },
        }),
      },
    });

    const ref: ExecutionRef = {
      meta: 'custom-transport',
      howToRun: 'custom:echo',
      whatToRun: serializeRef({ kind: 'custom', value: 'noop' }),
    };

    await expect(invoker.invoke(ref, { value: 1 })).resolves.toEqual({
      result: 'custom',
      data: { meta: 'custom-transport', args: { value: 1 } },
    });

    expect(invoker.invokeSync(ref, { value: 2 })).toEqual({
      result: 'custom-sync',
      data: { meta: 'custom-transport', args: { value: 2 } },
    });
  });
});