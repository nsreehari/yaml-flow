/**
 * chat-store-cli.ts — thin arg-parsing CLI for the chat store public API.
 *
 * All logic lives in chat-store-lib-public.ts.
 * This file only: parses argv, reads JSON from stdin or flags, calls the public API, prints JSON.
 *
 * Usage (all commands read a JSON envelope from stdin unless flags override):
 *
 *   chat-store append   --store-ref <ref> --card-id <id> --role <role> --text <text> [--files-json <json>] [--turn-id <id>]
 *   chat-store read-all --store-ref <ref> --card-id <id> [--last-user-turns <n>] [--tail-turns <n>] [--turn-id <id>] [--all-turns <true|false>] [--tail-turns-before-id <id>]
 *   chat-store read-after --store-ref <ref> --card-id <id> [--cursor <cursor>]
 *   chat-store clear    --store-ref <ref> --card-id <id>
 *   chat-store set-processing --store-ref <ref> --card-id <id> --active <true|false>
 *   chat-store is-processing  --store-ref <ref> --card-id <id>
 *   chat-store get-config --store-ref <ref> --card-id <id>
 *   chat-store set-config --store-ref <ref> --card-id <id> [--system-prompt <text>]
 *
 * Alternative: pass --stdin and pipe a JSON object with { storeRef, cardId, ... command fields } to stdin.
 * The `command` field selects the operation when using stdin-only mode.
 */

import { createFsBoardChatStorage } from './fs-board-adapter.js';
import { resolvePath } from './process-runner.js';
import {
  createChatStorePublic,
  type ChatStoreCommandBatchEnvelope,
  type ChatStoreCommandEnvelope,
} from '../common/chat-store-lib-public.js';
import { parseRef } from '../common/storage-interface.js';

type CommandResult = { status: string; data?: unknown; error?: string };
type CommandEnvelope = Record<string, unknown>;

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

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(parts).toString('utf-8');
}

const HELP = [
  'chat-store — chat history and state operations for a board card',
  '',
  '  chat-store append   --store-ref <ref> --card-id <id> --role <role> --text <text> [--files-json <json>] [--turn-id <id>]',
  '    Append a message. Prints { id } on success.',
  '',
  '  chat-store read-all --store-ref <ref> --card-id <id> [--last-user-turns <n>] [--tail-turns <n>] [--turn-id <id>] [--all-turns <true|false>] [--tail-turns-before-id <id>]',
  '    Print all messages, or a turn-filtered slice.',
  '',
  '  chat-store read-after --store-ref <ref> --card-id <id> [--cursor <cursor>]',
  '    Print messages after cursor as { records, cursor }.',
  '',
  '  chat-store clear    --store-ref <ref> --card-id <id>',
  '    Remove all messages for the card.',
  '',
  '  chat-store set-processing --store-ref <ref> --card-id <id> --active <true|false>',
  '    Set or clear the processing flag.',
  '',
  '  chat-store is-processing  --store-ref <ref> --card-id <id>',
  '    Print { active: true|false }.',
  '',
  '  chat-store get-config --store-ref <ref> --card-id <id>',
  '    Print the chat config object.',
  '',
  '  chat-store set-config --store-ref <ref> --card-id <id> [--system-prompt <text>]',
  '    Patch the chat config. Extra fields can be piped as JSON to stdin.',
  '',
  '  Alternatively, use --stdin and pipe a JSON object to stdin:',
  '    { "command": "<cmd>", "storeRef": "<ref>", "cardId": "<id>", ... }',
  '  Or pipe a command envelope with defaults plus sequential commands:',
  '    { "storeRef": "<ref>", "cardId": "<id>", "commands": [{ "command": "append", ... }, { "command": "set-processing", ... }] }',
].join('\n');

function createStorePublic(storeRef: string) {
  return createChatStorePublic(createFsBoardChatStorage(parseRef(storeRef).value));
}

export async function cli(argv: string[]): Promise<void> {
  // If the process has piped stdin and argv starts with --stdin, read the
  // entire request from a single JSON envelope.
  if (argv[0] === '--stdin') {
    const raw = await readStdin();
    if (!raw.trim()) {
      console.error(HELP);
      return;
    }
    let envelope: CommandEnvelope;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('chat-store: stdin is not valid JSON');
      process.exit(1);
    }
    const storeRef = envelope.storeRef as string | undefined;
    if (!storeRef) {
      console.error('chat-store: stdin envelope missing "storeRef"');
      process.exit(1);
    }
    const storePublic = createStorePublic(storeRef);
    if (Array.isArray(envelope.commands)) {
      printResult(storePublic.runBatch(toBatchEnvelope(envelope)));
      return;
    }

    printResult(storePublic.run(toCommandEnvelope(envelope)));
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.error(HELP);
    return;
  }

  const storeRef = requireFlag(rest, '--store-ref', `chat-store ${cmd} --store-ref <b64-ref> --card-id <id>`);
  const cardId = optFlag(rest, '--card-id');
  const storePublic = createStorePublic(storeRef);

  if (cmd === 'append') {
    const role = requireFlag(rest, '--role', 'chat-store append --store-ref <ref> --card-id <id> --role <role> --text <text>');
    const text = requireFlag(rest, '--text', 'chat-store append --store-ref <ref> --card-id <id> --role <role> --text <text>');
    const filesJson = optFlag(rest, '--files-json');
    const turn = optFlag(rest, '--turn-id') ?? optFlag(rest, '--turn') ?? '';
    const files = filesJson ? (JSON.parse(filesJson) as unknown[]) : [];
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store append --store-ref <ref> --card-id <id> --role <role> --text <text>');
    printResult(storePublic.append({ params: { cardId: cid }, body: { role, text, files, turn } }));
    return;
  }

  if (cmd === 'read-all') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store read-all --store-ref <ref> --card-id <id>');
    const lastUserTurns = optFlag(rest, '--last-user-turns');
    const tailTurns = optFlag(rest, '--tail-turns');
    const turnId = optFlag(rest, '--turn-id');
    const tailTurnsBeforeId = optFlag(rest, '--tail-turns-before-id');
    const allTurnsRaw = optFlag(rest, '--all-turns');
    if (allTurnsRaw !== undefined && allTurnsRaw !== 'true' && allTurnsRaw !== 'false') {
      console.error('chat-store read-all: --all-turns must be "true" or "false"');
      process.exit(1);
    }
    const body: Record<string, unknown> = {};
    if (lastUserTurns !== undefined) body.lastUserTurns = lastUserTurns;
    if (tailTurns !== undefined) body.tailTurns = tailTurns;
    if (turnId !== undefined) body.turnId = turnId;
    if (tailTurnsBeforeId !== undefined) body.tailTurnsBeforeId = tailTurnsBeforeId;
    if (allTurnsRaw !== undefined) body.allTurns = allTurnsRaw === 'true';
    printResult(storePublic.readAll({ params: { cardId: cid }, body: Object.keys(body).length > 0 ? body : undefined }));
    return;
  }

  if (cmd === 'read-after') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store read-after --store-ref <ref> --card-id <id>');
    const cursor = optFlag(rest, '--cursor') ?? null;
    printResult(storePublic.readAfter({ params: { cardId: cid }, body: { cursor } }));
    return;
  }

  if (cmd === 'clear') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store clear --store-ref <ref> --card-id <id>');
    printResult(storePublic.clear({ params: { cardId: cid } }));
    return;
  }

  if (cmd === 'set-processing') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store set-processing --store-ref <ref> --card-id <id> --active <true|false>');
    const activeStr = requireFlag(rest, '--active', 'chat-store set-processing --store-ref <ref> --card-id <id> --active <true|false>');
    if (activeStr !== 'true' && activeStr !== 'false') {
      console.error('chat-store set-processing: --active must be "true" or "false"');
      process.exit(1);
    }
    printResult(storePublic.setProcessing({ params: { cardId: cid }, body: { active: activeStr === 'true' } }));
    return;
  }

  if (cmd === 'is-processing') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store is-processing --store-ref <ref> --card-id <id>');
    printResult(storePublic.isProcessing({ params: { cardId: cid } }));
    return;
  }

  if (cmd === 'get-config') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store get-config --store-ref <ref> --card-id <id>');
    printResult(storePublic.getConfig({ params: { cardId: cid } }));
    return;
  }

  if (cmd === 'set-config') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store set-config --store-ref <ref> --card-id <id>');
    const systemPrompt = optFlag(rest, '--system-prompt');
    let patch: Record<string, unknown> = {};
    if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
    if (!process.stdin.isTTY) {
      const extra = await readStdin();
      if (extra.trim()) {
        try { Object.assign(patch, JSON.parse(extra) as Record<string, unknown>); } catch { /* ignore */ }
      }
    }
    printResult(storePublic.setConfig({ params: { cardId: cid }, body: patch }));
    return;
  }

  console.error(`chat-store: unknown command "${cmd}"\n${HELP}`);
  process.exit(1);
}

function toCommandEnvelope(envelope: CommandEnvelope): ChatStoreCommandEnvelope {
  const { storeRef: _storeRef, commands: _commands, ...command } = envelope;
  return command as ChatStoreCommandEnvelope;
}

function toBatchEnvelope(envelope: CommandEnvelope): ChatStoreCommandBatchEnvelope {
  const { storeRef: _storeRef, commands, cardId } = envelope;
  return {
    cardId: typeof cardId === 'string' ? cardId : undefined,
    commands: Array.isArray(commands)
      ? commands.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item as ChatStoreCommandEnvelope;
          const { storeRef: _itemStoreRef, commands: _itemCommands, ...command } = item as CommandEnvelope;
          return command as ChatStoreCommandEnvelope;
        })
      : [],
  };
}

function printResult(result: CommandResult): void {
  if (result.status !== 'success') {
    console.error(`chat-store: ${result.status}: ${result.error}`);
    process.exit(1);
  }
  if (result.data !== undefined) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
  }
}

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((e: unknown) => {
    console.error('chat-store:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
