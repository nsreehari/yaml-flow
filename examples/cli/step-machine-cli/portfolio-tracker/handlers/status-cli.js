#!/usr/bin/env node

import { readStdinJson, runBoardCli, toFsRef, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();

  if (!boardDir) {
    writeFailure('BOARD_DIR is required');
  }

  const status = runBoardCli(['status', '--base-ref', toFsRef(boardDir)], { capture: true });

  writeResult({
    status,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
