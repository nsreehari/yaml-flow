#!/usr/bin/env node
// Ref handler: reads JSON from stdin, doubles the "sum" field, writes JSON to stdout.

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const sum = Number(input.sum);
    if (!Number.isFinite(sum)) {
      process.stderr.write('double-handler requires numeric sum\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ doubled: sum * 2 }));
  } catch (err) {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  }
});
