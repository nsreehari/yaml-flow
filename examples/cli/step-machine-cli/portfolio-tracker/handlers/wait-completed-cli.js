#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const tasks = Array.isArray(input.COMPLETION_TASKS) ? input.COMPLETION_TASKS : [];
  const label = String(input.LABEL ?? 'WAIT');
  const timeoutMs = Number(input.TIMEOUT_MS ?? 30000);
  const pollMs = Number(input.POLL_MS ?? 500);

  if (!boardDir || tasks.length === 0) {
    writeFailure('BOARD_DIR and COMPLETION_TASKS are required');
    process.exit(0);
  }

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const status = runBoardCli(['status', '--rg', boardDir], { capture: true });
    const complete = tasks.every((task) => new RegExp(`\\bcompleted\\s+${task}\\b`).test(status));

    if (complete) {
      writeResult({
        result: 'success',
        data: {
          label,
          completed: true,
        },
      });
      process.exit(0);
    }

    await sleep(pollMs);
  }

  writeResult({
    result: 'timeout',
    data: {
      label,
      completed: false,
      error: `${label}: timed out waiting for completion`,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
