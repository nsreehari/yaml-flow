import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const browserSmokeTest = path.join(repoRoot, 'examples', 'board', 'test', 'server-http-test-browser.ts');

function runNodeScript(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('examples/board/test/server-http-test-browser.ts', () => {
  it('passes through the Vitest e2e runner', async () => {
    const result = await runNodeScript(process.execPath, [tsxCli, browserSmokeTest], repoRoot);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('=== All smoke checks passed ===');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('[ASSERT FAILED]');
  }, 15 * 60_000);
});