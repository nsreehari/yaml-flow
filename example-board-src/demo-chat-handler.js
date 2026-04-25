/**
 * demo-chat-handler.js - Chat handler for example-board.
 *
 * Invoked by reusable-server-runtime after a user message is persisted:
 *   node demo-chat-handler.js --boardId <id> --cardId <id> --extraEncJson <base64json>
 *
 * extraEncJson decodes to:
 *   boardSetupRoot  — absolute path to board root (parent of runtime/, surface/, runtime-out/)
 *   boardRuntimeDir — relative subdir: 'runtime'
 *   runtimeStatusDir— relative subdir: 'runtime-out'
 *   cardsDir        — relative subdir: 'surface/tmp-cards'
 *   chatDir         — relative (from cardsDir): e.g. 'card-portfolio/chats'
 *   lastChatFile    — filename of the just-written user message, e.g. '001_user.txt'
 *
 * Invokes copilot_wrapper.bat with a prompt built from conversation history.
 * Session dir is per-card: os.tmpdir()/demo-chat-handler-sessions/<boardId>_<cardId>
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';
import { spawnSync }     from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null;
}

const boardId  = getArg('--boardId') || '';
const cardId   = getArg('--cardId') || '';
const extraStr = getArg('--extraEncJson') || '';

let extra = {};
try { extra = JSON.parse(Buffer.from(extraStr, 'base64').toString('utf-8')); }
catch { console.error('[demo-chat-handler] bad --extraEncJson'); process.exit(0); }

const { boardSetupRoot, boardRuntimeDir, runtimeStatusDir, cardsDir, chatDir, lastChatFile } = extra;
if (!boardSetupRoot || !chatDir || !lastChatFile) {
  console.error('[demo-chat-handler] missing boardSetupRoot/chatDir/lastChatFile');
  process.exit(0);
}

// Resolve absolute paths from the structured extra fields
const boardRuntimeDirAbs  = path.join(boardSetupRoot, boardRuntimeDir  || 'runtime');
const runtimeStatusDirAbs = path.join(boardSetupRoot, runtimeStatusDir || 'runtime-out');
const cardsDirAbs         = path.join(boardSetupRoot, cardsDir         || path.join('surface', 'tmp-cards'));
const chatDirAbs          = path.join(cardsDirAbs, chatDir);

// ---------------------------------------------------------------------------
// Read conversation history
// ---------------------------------------------------------------------------
function readHistory(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => /^\d+[-_](user|assistant)\.txt$/i.test(f))
      .sort()
      .map(f => {
        const role = /user/i.test(f) ? 'User' : 'Assistant';
        let text = '';
        try { text = fs.readFileSync(path.join(dir, f), 'utf-8').trim(); } catch {}
        return role + ': ' + text;
      });
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Build prompt
// ---------------------------------------------------------------------------
function buildPrompt(cId, bId, history, responseFileRel) {
  const cardSetupDirRel  = path.join(cardsDir, cId).replace(/\\/g, '/');
  const runtimeDirRel    = boardRuntimeDir  || 'runtime';
  const statusDirRel     = runtimeStatusDir || 'runtime-out';
  const chatDirRel       = path.join(cardsDir, chatDir).replace(/\\/g, '/');
  const lastQueryFileRel = path.join(chatDirRel, lastChatFile).replace(/\\/g, '/');

  const contextBlock = [
    'We are currently doing a three way orchestration.',
    'You are the responder who has context of the cards in ' + cardSetupDirRel + ',',
    'card runtime statuses in ' + runtimeDirRel + ',',
    'and computed outputs in ' + statusDirRel + '.',
    'I am just a mediator passing on the query.',
    'The user sees the data available in cards which is rendered, and the status from ' + statusDirRel + '.',
    'Everything else is internal detail not to be exposed to the user.',
    'The conversation history can be found in ' + chatDirRel + ' and the last query is in ' + lastQueryFileRel + '.',
    'Write your response to the user in ' + responseFileRel + ' (relative to your working directory).',
    'Give me only a bare minimum log line on what you did — the response in ' + responseFileRel + ' is what the user will see.',
  ].join(' ');

  return [
    contextBlock,
    '',
    ...history,
    'Assistant:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Invoke copilot_wrapper.bat
// ---------------------------------------------------------------------------
function runWrapper(prompt, sessionDir, workingDir) {
  const wrapperPath = path.join(__dirname, 'scripts', 'copilot_wrapper.bat');
  const tmpBase     = os.tmpdir();
  const ts          = Date.now();
  const outFile     = path.join(tmpBase, 'dch-out-' + cardId + '-' + ts + '.txt');
  const promptFile  = path.join(tmpBase, 'dch-prompt-' + cardId + '-' + ts + '.txt');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  try {
    spawnSync('cmd.exe', [
      '/c', wrapperPath,
      outFile,
      sessionDir,
      workingDir,
      '@' + promptFile,
      'raw',
      'demo-chat',
    ], { stdio: 'inherit', timeout: 120000 });

    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile);    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const serialMatch    = String(lastChatFile).match(/^(\d+)/);
const nextSerial     = serialMatch ? parseInt(serialMatch[1], 10) + 1 : 1;
const nextName       = String(nextSerial).padStart(3, '0') + '-assistant.txt';
const responseFileRel = path.join(cardsDir, chatDir, nextName).replace(/\\/g, '/');

const history    = readHistory(chatDirAbs);
const sessionDir = path.join(os.tmpdir(), 'demo-chat-handler-sessions', boardId + '_' + cardId);
const workingDir = boardSetupRoot;
const prompt     = buildPrompt(cardId, boardId, history, responseFileRel);

try {
  runWrapper(prompt, sessionDir, workingDir);
  console.log('[demo-chat-handler] cardId="' + cardId + '" copilot invoked, response expected at ' + responseFileRel);
} catch (err) {
  console.error('[demo-chat-handler] wrapper failed: ' + (err?.message ?? err));
}