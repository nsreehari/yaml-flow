#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();

  if (!boardDir) {
    writeFailure('BOARD_DIR is required');
    process.exit(0);
  }

  const status = runBoardCli(['status', '--rg', boardDir], { capture: true });

  writeResult({
    result: 'success',
    data: {
      status,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
