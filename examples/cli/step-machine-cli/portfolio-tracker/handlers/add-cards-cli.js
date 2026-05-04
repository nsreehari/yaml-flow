#!/usr/bin/env node

import { readStdinJson, runBoardCli, runCardStoreCliWithInput, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const cards = Array.isArray(input.CARDS) ? input.CARDS : [];

  if (!boardDir || cards.length === 0) {
    writeFailure('BOARD_DIR and CARDS (array) are required');
    process.exit(0);
  }

  const baseRef = `::fs-path::${boardDir}`;

  // Write all cards to the card store in one call
  runCardStoreCliWithInput(
    ['set', '--store-ref', baseRef],
    JSON.stringify(cards),
  );

  // Upsert all cards at once
  runBoardCli(['upsert-card', '--base-ref', baseRef, '--all']);

  writeResult({
    result: 'success',
    data: {
      board_dir: boardDir,
      count: cards.length,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
