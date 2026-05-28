/**
 * E2E test: public-examples/board HTTP+SSE MCP smoke suite.
 *
 * Runs the self-contained server-http-mcp-test.js harness that boots the demo
 * board server, exercises MCP and direct HTTP paths, and verifies the end to
 * end chat/file lifecycle checks.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const HTTP_MCP_TEST = path.join(YAML_FLOW_ROOT, 'public-examples', 'board', 'test', 'server-http-mcp-test.js');

describe('public-examples HTTP MCP smoke harness', () => {
  it('passes the HTTP+SSE MCP smoke checks', () => {
    const result = spawnSync(process.execPath, [HTTP_MCP_TEST], {
      cwd: path.dirname(HTTP_MCP_TEST),
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    expect(result.error).toBeUndefined();
    expect(result.status, `server-http-mcp-test.js exited ${result.status}`).toBe(0);
    expect(result.stdout).toContain('All smoke checks passed');
  }, 300_000);
});