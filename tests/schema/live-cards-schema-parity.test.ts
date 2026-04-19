import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverSchemaPath = path.join(repoRoot, 'schema', 'live-cards.schema.json');
const browserSchemaPath = path.join(repoRoot, 'browser', 'live-cards.schema.json');

describe('live-cards schema parity', () => {
  it('keeps browser and server schema JSON in sync', () => {
    const serverSchema = JSON.parse(fs.readFileSync(serverSchemaPath, 'utf-8')) as unknown;
    const browserSchema = JSON.parse(fs.readFileSync(browserSchemaPath, 'utf-8')) as unknown;

    expect(browserSchema).toEqual(serverSchema);
  });
});
