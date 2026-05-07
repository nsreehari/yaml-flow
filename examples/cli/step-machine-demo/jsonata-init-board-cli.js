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
      process.stdout.write(JSON.stringify({
        result: 'failure',
        error: 'BOARD_DIR missing from input',
      }));
      return;
    }

    process.stdout.write(JSON.stringify({
      result: 'success',
      data: {
        message: `initialized ${boardDir}`,
        ignored: 'will be filtered by produces_data',
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ result: 'failure', error: message }));
  }
});

process.stdin.resume();
