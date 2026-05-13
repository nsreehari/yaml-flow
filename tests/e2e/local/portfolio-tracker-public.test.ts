import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');

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

describe('e2e: portfolio-tracker-public.js', () => {
  it('full 4-card board lifecycle completes successfully', () => {
    const r = run(process.execPath, [
      '--experimental-vm-modules',
      path.join('tests', 'e2e', 'local', 'portfolio-tracker-public.js'),
    ]);

    if (r.error) throw r.error;
    if (r.status !== 0) {
      console.error('[portfolio-tracker-public.js stdout]', r.stdout.slice(-2000));
      console.error('[portfolio-tracker-public.js stderr]', r.stderr.slice(-2000));
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('portfolio-tracker-public completed successfully');
  }, 120_000);
});
