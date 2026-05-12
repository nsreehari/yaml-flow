#!/usr/bin/env node
// Ref handler: takes value and multiplier as CLI args, writes JSON to stdout.
// Usage: node scale-handler.js <value> <multiplier>

const value = Number(process.argv[2]);
const multiplier = Number(process.argv[3]);

if (!Number.isFinite(value) || !Number.isFinite(multiplier)) {
  process.stderr.write('scale-handler requires numeric value and multiplier as CLI args\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({ scaled: value * multiplier }));
