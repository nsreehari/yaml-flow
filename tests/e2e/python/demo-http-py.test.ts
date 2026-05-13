import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function run(cmd: string, args: string[], timeoutMs = 120_000) {
  const result = spawnSync(cmd, args, {
    cwd: YAML_FLOW_ROOT,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    error: result.error,
  };
}

describe('e2e: demo-http-test.py', () => {
  it('demo board HTTP smoke checks pass', () => {
    const r = run(PYTHON, [
      path.join('py-standalone', 'examples', 'pyboard', 'server', 'test', 'demo-http-test.py'),
    ], 120_000);

    if (r.error) throw r.error;
    if (r.status !== 0) {
      console.error('[demo-http-test.py stdout]', r.stdout.slice(-2000));
      console.error('[demo-http-test.py stderr]', r.stderr.slice(-2000));
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('all assertions passed');
  }, 120_000);
});
