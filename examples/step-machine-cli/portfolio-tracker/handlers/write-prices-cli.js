#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJson, writeFailure, writeResult } from './_board-cli.js';

try {
  const input = await readStdinJson();
  const boardDirInput = String(input.BOARD_DIR ?? '').trim();
  const tmpFileName = String(input.TMP_FILE_NAME ?? '').trim() || 'tmp_file1';
  const prices = input.PRICES;

  if (!boardDirInput || !prices || typeof prices !== 'object' || Array.isArray(prices)) {
    writeFailure('BOARD_DIR and PRICES object are required');
    process.exit(0);
  }

  const boardDir = path.resolve(boardDirInput);
  const payload = JSON.stringify(prices);
  const tmpFile = path.join(boardDir, tmpFileName);

  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, payload, 'utf-8');

  writeResult({
    result: 'success',
    data: {
      wrote: true,
      tmp_file: tmpFile,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFailure(message);
}
