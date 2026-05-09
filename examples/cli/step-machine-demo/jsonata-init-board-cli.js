#!/usr/bin/env node

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const boardDir = input.BOARD_DIR ?? '';

    if (!boardDir) {
      process.stderr.write('BOARD_DIR missing from input');
      process.exit(1);
      return;
    }

    process.stdout.write(JSON.stringify({
      message: `initialized ${boardDir}`,
      ignored: 'will be filtered by produces_data',
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  }
});

process.stdin.resume();
