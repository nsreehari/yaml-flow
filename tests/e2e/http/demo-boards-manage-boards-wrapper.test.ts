import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKSPACE_ROOT = path.resolve(YAML_FLOW_ROOT, '..');
const DEMO_BOARDS_ROOT = path.join(WORKSPACE_ROOT, 'demo-boards-ns-code');
const HAS_DEMO_BOARDS = fs.existsSync(path.join(DEMO_BOARDS_ROOT, 'package.json'));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000) {
  const useShell = process.platform === 'win32' && cmd === npmCmd;
  const result = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: useShell,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString('utf-8') ?? '',
    stderr: result.stderr?.toString('utf-8') ?? '',
    error: result.error,
  };
}

describe.skipIf(!HAS_DEMO_BOARDS)('e2e: hosted demo-board manage-boards smoke', () => {
  it('MB1, MB2, and MB3 smoke checks pass', () => {
    const start = run(npmCmd, ['run', 'start:hosted'], DEMO_BOARDS_ROOT, 180_000);
    if (start.error) throw start.error;
    if (start.status !== 0) {
      console.error('[demo-boards-manage-boards start stdout]', start.stdout.slice(-4000));
      console.error('[demo-boards-manage-boards start stderr]', start.stderr.slice(-4000));
    }
    expect(start.status).toBe(0);

    try {
      const result = run(process.execPath, [
        path.join('demo-board', 'test', 'my-http-test.js'),
        '--run-tests',
        'MB1,MB2,MB3',
      ], DEMO_BOARDS_ROOT, 180_000);

      if (result.error) throw result.error;
      if (result.status !== 0) {
        console.error('[demo-boards-manage-boards stdout]', result.stdout.slice(-4000));
        console.error('[demo-boards-manage-boards stderr]', result.stderr.slice(-4000));
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('L-MB1');
      expect(result.stdout).toContain('L-MB2');
      expect(result.stdout).toContain('L-MB3');
    } finally {
      const stop = run(npmCmd, ['run', 'stop:hosted'], DEMO_BOARDS_ROOT, 90_000);
      if (stop.status !== 0) {
        console.error('[demo-boards-manage-boards stop stdout]', stop.stdout.slice(-2000));
        console.error('[demo-boards-manage-boards stop stderr]', stop.stderr.slice(-2000));
      }
    }
  }, 240_000);
});