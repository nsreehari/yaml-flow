#!/usr/bin/env node

import * as fs from 'node:fs';
import { readStdinJson, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDir = String(input.BOARD_DIR ?? '').trim();

  if (!boardDir) {
    writeFailure('BOARD_DIR is required');
    process.exit(0);
  }

  fs.rmSync(boardDir, { recursive: true, force: true });

  writeResult({
    result: 'success',
    data: {
      board_dir: boardDir,
      reset: true,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
