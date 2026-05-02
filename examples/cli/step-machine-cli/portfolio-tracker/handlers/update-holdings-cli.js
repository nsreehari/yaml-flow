#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJson, runBoardCli, runBoardCliWithInput, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const cardsDir = String(input.CARDS_DIR ?? '').trim();
  const holdings = input.HOLDINGS;

  if (!boardDir || !cardsDir || !Array.isArray(holdings)) {
    writeFailure('BOARD_DIR, CARDS_DIR and HOLDINGS array are required');
    process.exit(0);
  }

  const cardPath = path.join(cardsDir, 'portfolio-form.json');
  const raw = fs.readFileSync(cardPath, 'utf-8');
  const card = JSON.parse(raw);
  card.card_data = card.card_data ?? {};
  card.card_data.holdings = holdings;
  fs.writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');

  const baseRef = `::fs-path::${boardDir}`;
  runBoardCliWithInput(
    ['update-in-card-store', '--base-ref', baseRef, '--card-id', card.id],
    JSON.stringify(card),
  );
  runBoardCli(['upsert-card', '--base-ref', baseRef, '--card-id', card.id, '--restart']);

  writeResult({
    result: 'success',
    data: {
      saved: true,
      holdings_count: holdings.length,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
