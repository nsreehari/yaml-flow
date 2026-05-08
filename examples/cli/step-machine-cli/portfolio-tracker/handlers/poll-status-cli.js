#!/usr/bin/env node

import { readStdinJson, runBoardCli, writeFailure, writeResult } from './_board-cli.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const expectedCardCount = Number(input.EXPECTED_CARD_COUNT ?? 0);
  const timeoutMs = Number(input.TIMEOUT_MS ?? 30000);
  const pollMs = Number(input.POLL_MS ?? 500);

  if (!boardDir || expectedCardCount <= 0) {
    writeFailure('BOARD_DIR and EXPECTED_CARD_COUNT are required');
  }

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const statusJson = runBoardCli(['status', '--base-ref', `::fs-path::${boardDir}`], { capture: true });
    let cards = [];
    try {
      cards = JSON.parse(statusJson)?.data?.cards ?? [];
    } catch { /* ignore parse errors */ }

    const completedCount = cards.filter(c => c.status === 'completed').length;

    if (cards.length >= expectedCardCount && completedCount >= expectedCardCount) {
      writeResult({
        all_completed: true,
        card_count: cards.length,
        completed_count: completedCount,
      });
      process.exit(0);
    }

    await sleep(pollMs);
  }

  // Timeout — exit non-zero
  process.stderr.write(`timed out waiting for ${expectedCardCount} cards to complete`);
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
