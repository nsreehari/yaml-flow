#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const cardsGlob = String(input.CARDS_GLOB ?? '').trim();

  if (!boardDir || !cardsGlob) {
    writeFailure('BOARD_DIR and CARDS_GLOB are required');
    process.exit(0);
  }

  runBoardCli(['upsert-card', '--rg', boardDir, '--card-glob', cardsGlob]);

  writeResult({
    result: 'success',
    data: {
      board_dir: boardDir,
      cards_glob: cardsGlob,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
