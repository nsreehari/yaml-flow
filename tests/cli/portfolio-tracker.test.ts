import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const trackerScript = path.join(repoRoot, 'examples', 'browser', 'boards', 'portfolio-tracker', 'portfolio-tracker.js');

describe('portfolio tracker demo', () => {
  it('runs end-to-end as a black-box example', { timeout: 120000 }, () => {
    const result = spawnSync(process.execPath, [trackerScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BOARD_LIVE_CARDS_NO_SPAWN: '1',
      },
      encoding: 'utf-8',
      windowsHide: true,
    });

    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('=== T0: Init board ===');
    expect(combinedOutput).toContain('T1: all cards completed.');
    expect(combinedOutput).toContain('T2: all cards completed.');
    expect(combinedOutput).toContain('T3: all cards completed.');
    expect(combinedOutput).toContain('Portfolio tracker completed successfully');
  });
});