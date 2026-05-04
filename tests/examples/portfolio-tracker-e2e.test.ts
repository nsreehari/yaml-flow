import { describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portfolioDir = path.join(repoRoot, 'examples', 'browser', 'boards', 'portfolio-tracker');

/**
 * Probe for a working Python interpreter.
 * Tries python3, python, repo venv, and common install paths.
 * Returns the command string or null if none found.
 */
function findPython(): string | null {
  const candidates = [
    'python3',
    'python',
    path.join(repoRoot, '..', '.venv', 'Scripts', 'python.exe'),
    path.join(repoRoot, '..', '.venv', 'bin', 'python'),
  ];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 });
      if (r.status === 0 && r.stdout?.toString().startsWith('Python ')) return cmd;
    } catch {}
  }
  return null;
}

const PYTHON_CMD = findPython();

function runScript(scriptName: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = path.join(portfolioDir, scriptName);
  return new Promise((resolve) => {
    const proc = execFile('node', [scriptPath], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = error ? ((error as any).status ?? (typeof (error as any).code === 'number' ? (error as any).code : 1)) : 0;
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: exitCode,
      });
    });
  });
}

function runPythonScript(scriptName: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = path.join(portfolioDir, scriptName);
  return new Promise((resolve) => {
    const proc = execFile(PYTHON_CMD!, [scriptPath], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = error ? ((error as any).status ?? (typeof (error as any).code === 'number' ? (error as any).code : 1)) : 0;
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: exitCode,
      });
    });
  });
}

describe('portfolio-tracker e2e', () => {
  it('portfolio-tracker-public.js — full 4-card board lifecycle (T0–T3)', async () => {
    const { stdout, stderr, code } = await runScript('portfolio-tracker-public.js');
    const combined = stdout + stderr;

    expect(code).toBe(0);
    expect(combined).toContain('portfolio-tracker-public completed successfully');
    expect(combined).toContain('all 4 card(s) completed');
  }, 120_000);

  it('portfolio-t4.js — rapid-fire 5× upsert converges to iter-5 data', async () => {
    const { stdout, stderr, code } = await runScript('portfolio-t4.js');
    const combined = stdout + stderr;

    expect(code).toBe(0);
    expect(combined).toContain('portfolio-t4 completed');

    // Verify holdings.json output contains all iter-5 tickers
    expect(combined).toContain('"symbol": "AAPL"');
    expect(combined).toContain('"symbol": "MSFT"');
    expect(combined).toContain('"symbol": "GOOG"');
    expect(combined).toContain('"symbol": "AMZN"');
    expect(combined).toContain('"symbol": "TSLA"');

    // Verify iter-5 quantities appear in the holdings.json output
    // (printed before cardstore dump, both have same values when fix works)
    expect(combined).toMatch(/"qty": 45/);   // AAPL
    expect(combined).toMatch(/"qty": 30/);   // MSFT
    expect(combined).toMatch(/"qty": 110/);  // GOOG
    expect(combined).toMatch(/"qty": 140/);  // AMZN
    expect(combined).toMatch(/"qty": 60/);   // TSLA
  }, 120_000);

  it.skipIf(!PYTHON_CMD)('portfolio-tracker.py — CLI-based full board lifecycle (T0–T5)', async () => {
    console.log(`[python] using: ${PYTHON_CMD}`);
    const { stdout, stderr, code } = await runPythonScript('portfolio-tracker.py');
    const combined = stdout + stderr;

    expect(code).toBe(0);
    expect(combined).toContain('portfolio-tracker completed successfully');
    expect(combined).toContain('all cards completed');
    expect(combined).toContain('[T4] assertions passed');
    expect(combined).toContain('[T5] totals assertion passed');
  }, 180_000);
});
