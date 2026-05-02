#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const task = String(input.TASK ?? '').trim();

  if (!boardDir || !task) {
    writeFailure('BOARD_DIR and TASK are required');
    process.exit(0);
  }

  runBoardCli(['retrigger', '--base-ref', `::fs-path::${boardDir}`, '--id', task]);

  writeResult({
    result: 'success',
    data: {
      task,
      retriggered: true,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
