#!/usr/bin/env node

let raw = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const c = Number(input.c);

    if (!Number.isFinite(c)) {
      process.stdout.write(JSON.stringify({
        result: 'failure',
        error: 'step2_double requires numeric c',
      }));
      process.exit(0);
      return;
    }

    const d = c * 2;
    process.stdout.write(JSON.stringify({
      status: 'success',
      data: {
        a: 123,
        d,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ result: 'failure', error: message }));
    process.exit(0);
  }
});

process.stdin.resume();
