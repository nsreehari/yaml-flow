#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJson, runBoardCli, runBoardCliWithInput, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const cardsGlob = String(input.CARDS_GLOB ?? '').trim();

  if (!boardDir || !cardsGlob) {
    writeFailure('BOARD_DIR and CARDS_GLOB are required');
    process.exit(0);
  }

  // Expand simple glob pattern (e.g. /path/*.json) and upsert each card
  const dir = path.dirname(cardsGlob);
  const basename = path.basename(cardsGlob);
  let files;
  if (basename.startsWith('*.')) {
    const ext = basename.slice(1);
    files = fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => path.join(dir, f));
  } else {
    files = [cardsGlob];
  }

  const baseRef = `::fs-path::${boardDir}`;
  for (const file of files) {
    const card = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cardDir = path.dirname(file);
    // Resolve relative node script paths in source_defs to absolute so the executor
    // can run them from boardDir (which is a runtime temp dir, not the template dir).
    if (Array.isArray(card.source_defs)) {
      card.source_defs = card.source_defs.map(src => {
        if (typeof src.cli !== 'string') return src;
        const parts = src.cli.trim().split(/\s+/);
        if (parts[0] === 'node' && parts.length > 1 && !path.isAbsolute(parts[1]) && !parts[1].startsWith('-')) {
          parts[1] = path.resolve(cardDir, parts[1]);
          return { ...src, cli: parts.join(' ') };
        }
        return src;
      });
    }
    runBoardCliWithInput(
      ['update-in-card-store', '--base-ref', baseRef, '--card-id', card.id],
      JSON.stringify(card),
    );
    runBoardCli(['upsert-card', '--base-ref', baseRef, '--card-id', card.id]);
  }

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
