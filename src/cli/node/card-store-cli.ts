/**
 * card-store-cli.ts — thin arg-parsing CLI for the card store public API.
 *
 * All logic lives in card-store-lib-public.ts.
 * This file only: parses argv, reads files/stdin, calls the public API, prints JSON.
 *
 * Commands:
 *   card-store get --store-ref <ref> [--id <card-id>] [--yaml]
 *   card-store set --store-ref <ref> [--ref <jsonfile> | --ref-yaml <yamlfile>] [--yaml]
 *   card-store del --store-ref <ref> --id <card-id> [--id <card-id> ...]
 */

import * as fs from 'node:fs';
import { parseRef } from '../common/storage-interface.js';
import { createCardStore } from '../common/board-live-cards-lib.js';
import { createCardStorePublic } from '../common/card-store-lib-public.js';
import { createFsCardStorageAdapter } from './storage-fs-adapters.js';

function requireFlag(args: string[], flag: string, usage: string): string {
  const idx = args.indexOf(flag);
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (!val) throw new Error(`Missing ${flag}\nUsage: ${usage}`);
  return val;
}

function optFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(parts).toString('utf-8');
}

const HELP = [
  'card-store — JSON/YAML read/write for a board card store',
  '',
  '  card-store get --store-ref <ref> [--id <card-id>] [--yaml]',
  '    Print one card (--id) or all cards.',
  '    Default: JSON array.  --yaml: YAML multi-doc.',
  '',
  '  card-store set --store-ref <ref> [--ref <jsonfile> | --ref-yaml <yamlfile>] [--yaml]',
  '    Write cards into the store.',
  '    --ref <file>       JSON file (array or single object)',
  '    --ref-yaml <file>  YAML multi-doc file',
  '    --yaml             treat stdin as YAML (default stdin format is JSON)',
  '    Each card must contain a string `id` field.',
  '',
  '  card-store del --store-ref <ref> --id <card-id> [--id <card-id> ...]',
  '    Delete one or more cards by ID.',
].join('\n');

export async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.error(HELP);
    return;
  }

  const br = requireFlag(rest, '--store-ref', `card-store ${cmd} --store-ref <::kind::value>`);
  const baseRef = parseRef(br);
  const storePublic = createCardStorePublic(
    createCardStore(createFsCardStorageAdapter(baseRef.value), (msg) => console.error(`[card-store] ${msg}`)),
  );

  const asYaml = hasFlag(rest, '--yaml');

  // ── get ──────────────────────────────────────────────────────────────────
  if (cmd === 'get') {
    const id = optFlag(rest, '--id');
    const result = storePublic.get({ params: id ? { id } : {} });
    if (result.status !== 'success') {
      console.error(`card-store get: ${result.error}`);
      process.exit(1);
    }
    const cards = result.data.cards;
    if (cards.length === 0) return;

    if (asYaml) {
      const { stringify } = await import('yaml');
      process.stdout.write(cards.map(c => `---\n${stringify(c)}`).join(''));
    } else {
      process.stdout.write(JSON.stringify(cards, null, 2) + '\n');
    }
    return;
  }

  // ── set ──────────────────────────────────────────────────────────────────
  if (cmd === 'set') {
    const refJson = optFlag(rest, '--ref');
    const refYaml = optFlag(rest, '--ref-yaml');

    let cards: Array<Record<string, unknown>>;

    if (refYaml) {
      const { parseAllDocuments } = await import('yaml');
      const text = fs.readFileSync(refYaml, 'utf-8');
      cards = parseYamlDocs(parseAllDocuments(text));
    } else if (refJson) {
      cards = parseJsonCards(fs.readFileSync(refJson, 'utf-8'), refJson);
    } else {
      const text = await readStdin();
      if (!text.trim()) {
        console.error('card-store set: no input (provide --ref, --ref-yaml, or pipe to stdin)');
        process.exit(1);
      }
      if (asYaml) {
        const { parseAllDocuments } = await import('yaml');
        cards = parseYamlDocs(parseAllDocuments(text));
      } else {
        cards = parseJsonCards(text, 'stdin');
      }
    }

    const result = storePublic.set({ body: cards });
    if (result.status !== 'success') {
      console.error(`card-store set: ${result.error}`);
      process.exit(1);
    }
    console.error(`card-store set: wrote ${result.data.count} card(s)`);
    return;
  }

  // ── del ──────────────────────────────────────────────────────────────────
  if (cmd === 'del' || cmd === 'delete') {
    const ids: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--id' && rest[i + 1]) {
        ids.push(rest[++i]);
      }
    }
    const result = storePublic.del({ body: { ids } });
    if (result.status !== 'success') {
      console.error(`card-store del: ${result.error}`);
      process.exit(1);
    }
    console.error(`card-store del: removed ${result.data.count} card(s)`);
    return;
  }

  console.error(`card-store: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────

function parseYamlDocs(docs: import('yaml').Document[]): Array<Record<string, unknown>> {
  return docs.map((doc, i) => {
    if (doc.errors.length > 0) {
      console.error(`card-store set: YAML parse error in document ${i + 1}: ${doc.errors[0]}`);
      process.exit(1);
    }
    return doc.toJS() as Record<string, unknown>;
  });
}

function parseJsonCards(text: string, source: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`card-store set: JSON parse error from ${source}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  console.error(`card-store set: JSON from ${source} must be an object or an array of objects`);
  process.exit(1);
}

// Run when invoked directly (tsx or dist)
import { resolvePath } from './process-runner.js';
const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}

