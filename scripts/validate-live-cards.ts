#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import fg from 'fast-glob';
import { validateLiveCardDefinition } from '../src/card-compute/schema-validator.js';

async function main(): Promise<void> {
  const patterns = process.argv.slice(2);
  const inputs = patterns.length > 0 ? patterns : ['examples/**/cards/*.json'];

  const files = await fg(inputs, {
    onlyFiles: true,
    unique: true,
    absolute: false,
  });

  if (files.length === 0) {
    console.error(`No card JSON files found for patterns: ${inputs.join(', ')}`);
    process.exit(1);
  }

  let hadErrors = false;

  for (const file of files) {
    let parsed: unknown;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      hadErrors = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n${file}`);
      console.error(`  - invalid JSON: ${message}`);
      continue;
    }

    const result = validateLiveCardDefinition(parsed);
    if (!result.ok) {
      hadErrors = true;
      console.error(`\n${file}`);
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
    }
  }

  if (hadErrors) {
    console.error('\nLive card validation failed.');
    process.exit(1);
  }

  const relative = files.map(f => path.normalize(f));
  console.log(`Validated ${relative.length} live card file(s) successfully.`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
