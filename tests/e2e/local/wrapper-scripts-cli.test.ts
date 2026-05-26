/**
 * E2E test: wrapper-scripts/cli regression suite.
 *
 * Runs the self-contained test-scripts.js harness that exercises every CLI
 * wrapper script.  The harness creates a temp board, seeds data, runs each
 * script in sequence, and cleans up on exit.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_SCRIPTS = path.join(YAML_FLOW_ROOT, 'wrapper-scripts', 'cli', 'test-scripts.js');

describe('wrapper-scripts/cli', () => {
  it('all CLI wrapper scripts pass regression checks', () => {
    const result = spawnSync(process.execPath, [TEST_SCRIPTS], {
      cwd: path.dirname(TEST_SCRIPTS),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });

    // Print the harness output for visibility in CI
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    expect(result.error).toBeUndefined();
    expect(result.status, `test-scripts.js exited ${result.status}`).toBe(0);
    expect(result.stdout).toContain('All');
    expect(result.stdout).toContain('checks passed');
  });
});
