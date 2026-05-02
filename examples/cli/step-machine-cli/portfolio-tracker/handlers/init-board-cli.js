#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();

  if (!boardDir) {
    writeFailure('BOARD_DIR is required');
    process.exit(0);
  }

  runBoardCli(['init', '--base-ref', `::fs-path::${boardDir}`]);
  writeResult({
    result: 'success',
    data: {
      board_dir: boardDir,
      message: `initialized ${boardDir}`,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
