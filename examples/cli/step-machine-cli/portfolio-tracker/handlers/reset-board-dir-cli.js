#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJson, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDirInput = String(input.BOARD_DIR ?? '').trim();

  if (!boardDirInput) {
    writeFailure('BOARD_DIR is required');
    process.exit(0);
  }

  const boardDir = path.resolve(boardDirInput);
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
