#!/usr/bin/env node

import { readStdinJson, runBoardCli, toFsRef, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();

  if (!boardDir) {
    writeFailure('BOARD_DIR is required');
  }

  runBoardCli([
    'init',
    '--base-ref', toFsRef(boardDir),
    '--card-store-ref', toFsRef(boardDir),
    '--outputs-store-ref', toFsRef(boardDir),
  ]);
  writeResult({
    board_dir: boardDir,
    message: `initialized ${boardDir}`,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
