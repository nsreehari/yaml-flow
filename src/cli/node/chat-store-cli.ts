/**
 * chat-store-cli.ts — thin arg-parsing CLI for the chat store public API.
 *
 * All logic lives in chat-store-lib-public.ts.
 * This file only: parses argv, reads JSON from stdin or flags, calls the public API, prints JSON.
 *
 * Usage (all commands read a JSON envelope from stdin unless flags override):
 *
 *   chat-store append   --board-dir <dir> --card-id <id> --role <role> --text <text> [--files-json <json>]
 *   chat-store read-all --board-dir <dir> --card-id <id>
 *   chat-store read-after --board-dir <dir> --card-id <id> [--cursor <cursor>]
 *   chat-store clear    --board-dir <dir> --card-id <id>
 *   chat-store set-processing --board-dir <dir> --card-id <id> --active <true|false>
 *   chat-store is-processing  --board-dir <dir> --card-id <id>
 *   chat-store get-config --board-dir <dir> --card-id <id>
 *   chat-store set-config --board-dir <dir> --card-id <id> [--system-prompt <text>]
 *
 * Alternative: pipe a JSON object with { boardDir, cardId, ... command fields } to stdin.
 * The `command` field selects the operation when using stdin-only mode.
 */

import { createFsBoardChatStorage } from './fs-board-adapter.js';
import { resolvePath } from './process-runner.js';
import {
  createChatStorePublic,
  type ChatStoreCommandBatchEnvelope,
  type ChatStoreCommandEnvelope,
} from '../common/chat-store-lib-public.js';

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
  '  chat-store append --board-dir <dir> --card-id <id> --role <role> --text <text> [--files-json <json>]',
  '    Append a message. Prints { id } on success.',
  '',
  '  chat-store read-all --board-dir <dir> --card-id <id>',
  '    Print all messages as a JSON array.',
  '',
  '  chat-store read-after --board-dir <dir> --card-id <id> [--cursor <cursor>]',
  '    Print messages after cursor as { records, cursor }.',
  '',
  '  chat-store clear --board-dir <dir> --card-id <id>',
  '    Remove all messages for the card.',
  '',
  '  chat-store set-processing --board-dir <dir> --card-id <id> --active <true|false>',
  '    Set or clear the processing flag.',
  '',
  '  chat-store is-processing --board-dir <dir> --card-id <id>',
  '    Print { active: true|false }.',
  '',
  '  chat-store get-config --board-dir <dir> --card-id <id>',
  '    Print the chat config object.',
  '',
  '  chat-store set-config --board-dir <dir> --card-id <id> [--system-prompt <text>]',
  '    Patch the chat config. Extra fields can be piped as JSON to stdin.',
  '',
  '  Alternatively, pipe a JSON object to stdin:',
  '    { "command": "<cmd>", "boardDir": "<dir>", "cardId": "<id>", ... }',
  '  Or pipe a command envelope with defaults plus sequential commands:',
  '    { "boardDir": "<dir>", "cardId": "<id>", "commands": [{ "command": "append", ... }, { "command": "set-processing", ... }] }',
].join('\n');

export async function cli(argv: string[]): Promise<void> {
  // ── stdin-JSON mode ─────────────────────────────────────────────────────
  // If the process has piped stdin and argv is empty (or only --stdin), read
  // the entire request from a single JSON envelope:
  //   { command, boardDir, cardId, role?, text?, files?, cursor?, active?, systemPrompt?, ... }
  if (argv.length === 0 || argv[0] === '--stdin') {
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
    const boardDir = envelope.boardDir as string | undefined;
    if (!boardDir) {
      console.error('chat-store: stdin envelope missing "boardDir"');
      process.exit(1);
    }
    const chatsSubdir = envelope.chatsSubdir as string | undefined;
    const kvSubdir = envelope.kvSubdir as string | undefined;
    const chatOpts: { chatsSubdir?: string; kvSubdir?: string } = {};
    if (chatsSubdir !== undefined) chatOpts.chatsSubdir = chatsSubdir;
    if (kvSubdir !== undefined) chatOpts.kvSubdir = kvSubdir;
    const storePublic = createChatStorePublic(createFsBoardChatStorage(boardDir, chatOpts));
    if (Array.isArray(envelope.commands)) {
      const batchResult = storePublic.runBatch(toBatchEnvelope(envelope));
      printResult(batchResult);
      return;
    }

    const result = storePublic.run(toCommandEnvelope(envelope));
    printResult(result);
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.error(HELP);
    return;
  }

  const boardDir = requireFlag(rest, '--board-dir', `chat-store ${cmd} --board-dir <dir> --card-id <id>`);
  const cardId = optFlag(rest, '--card-id');
  const storePublic = createChatStorePublic(createFsBoardChatStorage(boardDir));

  // ── append ───────────────────────────────────────────────────────────────
  if (cmd === 'append') {
    const role = requireFlag(rest, '--role', 'chat-store append --board-dir <dir> --card-id <id> --role <role> --text <text>');
    const text = requireFlag(rest, '--text', 'chat-store append --board-dir <dir> --card-id <id> --role <role> --text <text>');
    const filesJson = optFlag(rest, '--files-json');
    const files = filesJson ? (JSON.parse(filesJson) as unknown[]) : [];
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store append --board-dir <dir> --card-id <id> --role <role> --text <text>');
    const result = storePublic.append({ params: { cardId: cid }, body: { role, text, files } });
    printResult(result);
    return;
  }

  // ── read-all ─────────────────────────────────────────────────────────────
  if (cmd === 'read-all') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store read-all --board-dir <dir> --card-id <id>');
    const result = storePublic.readAll({ params: { cardId: cid } });
    printResult(result);
    return;
  }

  // ── read-after ───────────────────────────────────────────────────────────
  if (cmd === 'read-after') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store read-after --board-dir <dir> --card-id <id>');
    const cursor = optFlag(rest, '--cursor') ?? null;
    const result = storePublic.readAfter({ params: { cardId: cid }, body: { cursor } });
    printResult(result);
    return;
  }

  // ── clear ────────────────────────────────────────────────────────────────
  if (cmd === 'clear') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store clear --board-dir <dir> --card-id <id>');
    const result = storePublic.clear({ params: { cardId: cid } });
    printResult(result);
    return;
  }

  // ── set-processing ───────────────────────────────────────────────────────
  if (cmd === 'set-processing') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store set-processing --board-dir <dir> --card-id <id> --active <true|false>');
    const activeStr = requireFlag(rest, '--active', 'chat-store set-processing --board-dir <dir> --card-id <id> --active <true|false>');
    if (activeStr !== 'true' && activeStr !== 'false') {
      console.error('chat-store set-processing: --active must be "true" or "false"');
      process.exit(1);
    }
    const result = storePublic.setProcessing({ params: { cardId: cid }, body: { active: activeStr === 'true' } });
    printResult(result);
    return;
  }

  // ── is-processing ────────────────────────────────────────────────────────
  if (cmd === 'is-processing') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store is-processing --board-dir <dir> --card-id <id>');
    const result = storePublic.isProcessing({ params: { cardId: cid } });
    printResult(result);
    return;
  }

  // ── get-config ───────────────────────────────────────────────────────────
  if (cmd === 'get-config') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store get-config --board-dir <dir> --card-id <id>');
    const result = storePublic.getConfig({ params: { cardId: cid } });
    printResult(result);
    return;
  }

  // ── set-config ───────────────────────────────────────────────────────────
  if (cmd === 'set-config') {
    const cid = cardId ?? requireFlag(rest, '--card-id', 'chat-store set-config --board-dir <dir> --card-id <id>');
    const systemPrompt = optFlag(rest, '--system-prompt');
    // Also accept extra fields from stdin
    let patch: Record<string, unknown> = {};
    if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
    // Try reading any additional fields from stdin if there's piped input
    if (!process.stdin.isTTY) {
      const extra = await readStdin();
      if (extra.trim()) {
        try { Object.assign(patch, JSON.parse(extra) as Record<string, unknown>); } catch { /* ignore */ }
      }
    }
    const result = storePublic.setConfig({ params: { cardId: cid }, body: patch });
    printResult(result);
    return;
  }

  console.error(`chat-store: unknown command "${cmd}"\n${HELP}`);
  process.exit(1);
}

function toCommandEnvelope(envelope: CommandEnvelope): ChatStoreCommandEnvelope {
  const { boardDir: _boardDir, commands: _commands, ...command } = envelope;
  return command as ChatStoreCommandEnvelope;
}

function toBatchEnvelope(envelope: CommandEnvelope): ChatStoreCommandBatchEnvelope {
  const { boardDir: _boardDir, commands, cardId } = envelope;
  return {
    cardId: typeof cardId === 'string' ? cardId : undefined,
    commands: Array.isArray(commands)
      ? commands.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item as ChatStoreCommandEnvelope;
          const { boardDir: _itemBoardDir, commands: _itemCommands, ...command } = item as CommandEnvelope;
          return command as ChatStoreCommandEnvelope;
        })
      : [],
  };
}

// ── output helpers ──────────────────────────────────────────────────────────

function printResult(result: CommandResult): void {
  if (result.status !== 'success') {
    console.error(`chat-store: ${result.status}: ${result.error}`);
    process.exit(1);
  }
  if (result.data !== undefined) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((e: unknown) => {
    console.error('chat-store:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
