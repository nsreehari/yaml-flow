#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJson, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();
  const prices = input.PRICES;

  if (!boardDir || !prices || typeof prices !== 'object' || Array.isArray(prices)) {
    writeFailure('BOARD_DIR and PRICES object are required');
    process.exit(0);
  }

  const payload = JSON.stringify(prices);
  const candidates = [
    path.join(boardDir, 'tmp_file1'),
    path.join(process.cwd(), 'tmp_file1'),
    path.join(process.cwd(), 'board-runtime', 'tmp_file1'),
    path.join(process.cwd(), '..', 'board-runtime', 'tmp_file1'),
  ];

  for (const tmpFile of candidates) {
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, payload, 'utf-8');
  }

  writeResult({
    result: 'success',
    data: {
      wrote: true,
      tmp_file: candidates[0],
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
