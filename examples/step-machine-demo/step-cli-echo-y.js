#!/usr/bin/env node

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const x = Number(input.x);
  if (!Number.isFinite(x)) {
    process.stdout.write(JSON.stringify({ result: 'failure', error: 'x must be numeric' }));
    return;
  }
  process.stdout.write(JSON.stringify({ result: 'success', data: { y: x + 10, z: 999 } }));
});
process.stdin.resume();
