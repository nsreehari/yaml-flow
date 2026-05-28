/**
 * E2E test: wrapper-scripts/cli MCP regression suite.
 *
 * Runs the self-contained mcp-test.js harness that exercises the MCP endpoint
 * using the same step order as test-scripts.js where MCP tools exist.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const MCP_TEST = path.join(YAML_FLOW_ROOT, 'wrapper-scripts', 'cli', 'mcp-test.js');

describe('wrapper-scripts/cli MCP harness', () => {
  it('MCP regression checks pass', () => {
    const result = spawnSync(process.execPath, [MCP_TEST], {
      cwd: path.dirname(MCP_TEST),
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    expect(result.status, `mcp-test.js exited ${result.status}`).toBe(0);
    expect(result.stdout).toContain('All');
    expect(result.stdout).toContain('checks passed');
  }, 300_000);
});