/**
 * artifacts-store-cli.ts
 *
 * Thin arg parser for ArtifactsStore public API.
 */

import * as fs from 'node:fs';
import { parseArtifactsStoreEntryRef, parseRef } from '../common/storage-interface.js';
import { createFsBlobStorage } from './storage-fs-adapters.js';
import { createArtifactsStore } from '../common/artifacts-store-lib.js';
import { createArtifactsStorePublic } from '../common/artifacts-store-lib-public.js';
import { resolvePath } from './process-runner.js';

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

function resolveArtifactLocation(args: string[], usage: string): { storeRef: string; key: string } {
  const ref = optFlag(args, '--ref');
  if (ref) return parseArtifactsStoreEntryRef(ref);
  return {
    storeRef: requireFlag(args, '--store-ref', usage),
    key: requireFlag(args, '--key', usage),
  };
}

async function readStdinBytes(): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(parts));
}

const HELP = [
  'artifacts-store — generic artifact CRUD on a blob-backed store',
  '',
  '  artifacts-store put (--store-ref <ref> --key <key> | --ref <full-ref>) [--file <path> | --text <text>] [--content-type <mime>]',
  '  artifacts-store get (--store-ref <ref> --key <key> | --ref <full-ref>) [--out <path>] [--as text|bytes]',
  '  artifacts-store head (--store-ref <ref> --key <key> | --ref <full-ref>)',
  '  artifacts-store list --store-ref <ref> [--prefix <prefix>]',
  '  artifacts-store del (--store-ref <ref> --key <key> | --ref <full-ref>)',
].join('\n');

export async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.error(HELP);
    return;
  }

  if (cmd === 'put') {
    const { storeRef, key } = resolveArtifactLocation(rest, 'artifacts-store put (--store-ref <ref> --key <key> | --ref <full-ref>)');
    const root = parseRef(storeRef).value;
    const store = createArtifactsStorePublic(createArtifactsStore(createFsBlobStorage(root)));
    const contentType = optFlag(rest, '--content-type');
    const filePath = optFlag(rest, '--file');
    const text = optFlag(rest, '--text');

    let body: unknown;
    if (filePath) {
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      body = { bytes: [...bytes] };
    } else if (typeof text === 'string') {
      body = { text };
    } else if (!process.stdin.isTTY) {
      const bytes = await readStdinBytes();
      body = { bytes: [...bytes] };
    } else {
      throw new Error('put requires --file, --text, or stdin bytes');
    }

    const result = store.put({ params: { key, ...(contentType ? { contentType } : {}) }, body });
    if (result.status !== 'success') throw new Error(result.error || 'put failed');
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
    return;
  }

  if (cmd === 'get') {
    const { storeRef, key } = resolveArtifactLocation(rest, 'artifacts-store get (--store-ref <ref> --key <key> | --ref <full-ref>)');
    const root = parseRef(storeRef).value;
    const store = createArtifactsStorePublic(createArtifactsStore(createFsBlobStorage(root)));
    const as = (optFlag(rest, '--as') || 'bytes').toLowerCase();
    const outPath = optFlag(rest, '--out');
    const result = store.get({ params: { key, as } });
    if (result.status !== 'success') throw new Error(result.error || 'get failed');

    if (as === 'text') {
      const text = result.data.text ?? '';
      if (outPath) fs.writeFileSync(outPath, text, 'utf-8');
      else process.stdout.write(text);
      return;
    }

    const bytes = new Uint8Array(result.data.bytes ?? []);
    if (outPath) fs.writeFileSync(outPath, Buffer.from(bytes));
    else process.stdout.write(JSON.stringify({ ...result.data, bytes: undefined, byteLength: bytes.byteLength }, null, 2) + '\n');
    return;
  }

  if (cmd === 'head') {
    const { storeRef, key } = resolveArtifactLocation(rest, 'artifacts-store head (--store-ref <ref> --key <key> | --ref <full-ref>)');
    const root = parseRef(storeRef).value;
    const store = createArtifactsStorePublic(createArtifactsStore(createFsBlobStorage(root)));
    const result = store.head({ params: { key } });
    if (result.status !== 'success') throw new Error(result.error || 'head failed');
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
    return;
  }

  if (cmd === 'list') {
    const ref = requireFlag(rest, '--store-ref', 'artifacts-store list --store-ref <ref> [--prefix <prefix>]');
    const root = parseRef(ref).value;
    const store = createArtifactsStorePublic(createArtifactsStore(createFsBlobStorage(root)));
    const prefix = optFlag(rest, '--prefix') || '';
    const result = store.list({ params: prefix ? { prefix } : {} });
    if (result.status !== 'success') throw new Error(result.error || 'list failed');
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
    return;
  }

  if (cmd === 'del' || cmd === 'delete' || cmd === 'rm') {
    const { storeRef, key } = resolveArtifactLocation(rest, 'artifacts-store del (--store-ref <ref> --key <key> | --ref <full-ref>)');
    const root = parseRef(storeRef).value;
    const store = createArtifactsStorePublic(createArtifactsStore(createFsBlobStorage(root)));
    const result = store.del({ params: { key } });
    if (result.status !== 'success') throw new Error(result.error || 'del failed');
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
    return;
  }

  throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
}

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
