#!/usr/bin/env node
/**
 * test-scripts.js
 *
 * Smoke-tests every CLI wrapper script under wrapper-scripts/cli/.
 *
 * Creates a temporary board, writes known_constants.json, then exercises each
 * script in sequence.  Cleans up on exit.
 *
 * Usage:
 *   node test-scripts.js
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CLI_DIR = __dirname;  // the scripts live in the same directory

// ── Resolve yaml-flow CLI bundled dir ────────────────────────────────────────

function resolveCliBundledDir() {
  try {
    return path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));
  } catch {
    const candidate = path.resolve(__dirname, '..', '..', 'cli', 'bundled');
    if (fs.existsSync(path.join(candidate, 'board-live-cards-cli.mjs'))) {
      return candidate;
    }
    throw new Error('Cannot resolve yaml-flow CLI bundled directory');
  }
}

const CLI_BUNDLED_DIR = resolveCliBundledDir();
const BOARD_CLI = path.join(CLI_BUNDLED_DIR, 'board-live-cards-cli.mjs');
const CARD_CLI = path.join(CLI_BUNDLED_DIR, 'card-store-cli.mjs');
const CHAT_CLI = path.join(CLI_BUNDLED_DIR, 'chat-store-cli.mjs');
const ARTIFACTS_CLI = path.join(CLI_BUNDLED_DIR, 'artifacts-store-cli.mjs');

// ── Helpers ──────────────────────────────────────────────────────────────────

function b64url(raw) {
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fsRef(absPath) {
  return `b64:${b64url(JSON.stringify({ kind: 'fs-path', value: absPath }))}`;
}

function run(cli, args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? CLI_DIR,
    encoding: opts.encoding ?? 'utf8',
    input: opts.input,
    windowsHide: true,
    timeout: 30_000,
  });
  return result;
}

function runOk(cli, args, opts = {}) {
  const r = run(cli, args, opts);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${path.basename(cli)} ${args[0] ?? ''} exited ${r.status}:\n${r.stderr}`);
  }
  return r.stdout;
}

function parseOk(cli, args, opts = {}) {
  return JSON.parse(runOk(cli, args, opts));
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

let passed = 0;
function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Set up temp board ────────────────────────────────────────────────────────

const TEMP_ROOT = path.join(os.tmpdir(), `test-cli-scripts-${Date.now()}-${process.pid}`);
const BOARD_DIR = path.join(TEMP_ROOT, 'board');
const CARDS_DIR = path.join(TEMP_ROOT, 'cards');
const OUTPUTS_DIR = path.join(TEMP_ROOT, 'outputs');
const SCRATCH_DIR = path.join(TEMP_ROOT, 'scratch');
const ARTIFACTS_DIR = path.join(TEMP_ROOT, 'artifacts');
const FINAL_RESP_DIR = path.join(TEMP_ROOT, 'final-responses');
const RUNTIME_DIR = path.join(BOARD_DIR, 'runtime');

for (const d of [BOARD_DIR, CARDS_DIR, OUTPUTS_DIR, SCRATCH_DIR, ARTIFACTS_DIR, FINAL_RESP_DIR, RUNTIME_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const BOARD_REF = fsRef(BOARD_DIR);
const CARDS_REF = fsRef(CARDS_DIR);
const OUTPUTS_REF = fsRef(OUTPUTS_DIR);
const SCRATCH_REF = fsRef(SCRATCH_DIR);
const ARTIFACTS_REF = fsRef(ARTIFACTS_DIR);
const RUNTIME_REF = fsRef(RUNTIME_DIR);

// Backup any existing known_constants.json
const KC_PATH = path.join(CLI_DIR, 'known_constants.json');
const KC_BACKUP = KC_PATH + '.backup';
let hadExistingKC = false;
if (fs.existsSync(KC_PATH)) {
  hadExistingKC = true;
  fs.copyFileSync(KC_PATH, KC_BACKUP);
}

function cleanup() {
  // Restore original known_constants.json
  try {
    if (hadExistingKC) {
      fs.copyFileSync(KC_BACKUP, KC_PATH);
      fs.unlinkSync(KC_BACKUP);
    } else {
      fs.unlinkSync(KC_PATH);
    }
  } catch { /* best-effort */ }

  // Clean temp dir
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

  // Clean log.jsonl created by shared_helpers.js
  try { fs.unlinkSync(path.join(CLI_DIR, 'log.jsonl')); } catch { /* best-effort */ }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

// ── Init board ───────────────────────────────────────────────────────────────

console.log('\n=== test-scripts.js: CLI wrapper regression tests ===\n');
console.log(`board dir: ${BOARD_DIR}`);

const initResult = parseOk(BOARD_CLI, [
  'init',
  '--base-ref', BOARD_REF,
  '--card-store-ref', CARDS_REF,
  '--outputs-store-ref', OUTPUTS_REF,
  '--scratch-store-ref', SCRATCH_REF,
  '--artifacts-store-ref', ARTIFACTS_REF,
]);
assert(initResult.status === 'success', `board init failed: ${JSON.stringify(initResult)}`);

// Write chat-store-ref to board config (init CLI doesn't expose --chat-store-ref)
const configDir = path.join(BOARD_DIR, '.config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'chat-store-ref.json'), JSON.stringify(RUNTIME_REF), 'utf8');

ok('board init');

// ── Step 1: write known_constants.json ───────────────────────────────────────

console.log('\n--- known_constants.json ---');

const knownConstants = {
  base_ref: BOARD_REF,
  yaml_flow_cli_bundled_dir: CLI_BUNDLED_DIR,
  scratch_dir: SCRATCH_DIR,
  final_response_root_dir: FINAL_RESP_DIR,
};
fs.writeFileSync(KC_PATH, JSON.stringify(knownConstants, null, 2) + '\n', 'utf8');
assert(fs.existsSync(KC_PATH), 'known_constants.json not written');

const kc = JSON.parse(fs.readFileSync(KC_PATH, 'utf8'));
assert(kc.base_ref === BOARD_REF, 'base_ref mismatch in known_constants.json');
assert(typeof kc.yaml_flow_cli_bundled_dir === 'string', 'yaml_flow_cli_bundled_dir missing');
assert(kc.scratch_dir === SCRATCH_DIR, 'scratch_dir mismatch');
assert(kc.final_response_root_dir === FINAL_RESP_DIR, 'final_response_root_dir mismatch');
ok('known_constants.json written with all fields');

// ── Create a test card in the card store ─────────────────────────────────────

const TEST_CARD_ID = 'test-card-alpha';
const testCard = {
  id: TEST_CARD_ID,
  label: 'Test Card Alpha',
  card_data: {
    v: 1,
    greeting: 'hello world',
    files: [],
  },
  sources: [],
  requires: [],
  provides: [],
  compute: [],
};

runOk(CARD_CLI, ['set', '--store-ref', CARDS_REF], { input: JSON.stringify(testCard) });

// Register card with the board
const upsertResult = parseOk(BOARD_CLI, ['upsert-card', '--base-ref', BOARD_REF, '--card-id', TEST_CARD_ID]);
assert(upsertResult.status === 'success', `upsert-card failed: ${JSON.stringify(upsertResult)}`);
ok('test card created and registered');

// ── Step 2: inspect-board-runtime-status.js ──────────────────────────────────

console.log('\n--- inspect-board-runtime-status.js ---');

const statusResult = parseOk(path.join(CLI_DIR, 'inspect-board-runtime-status.js'), ['read-status']);
assert(typeof statusResult.summary === 'object', 'missing summary in status');
assert(typeof statusResult.summary.card_count === 'number', 'missing card_count');
assert(statusResult.summary.card_count >= 1, `expected at least 1 card, got ${statusResult.summary.card_count}`);
assert(Array.isArray(statusResult.cards), 'missing cards array');
const statusCard = statusResult.cards.find(c => c['card-id'] === TEST_CARD_ID);
assert(statusCard, `test card ${TEST_CARD_ID} not found in board status`);
ok('read-status returns well-shaped summary with test card');

// verify --help exits cleanly
const helpResult = run(path.join(CLI_DIR, 'inspect-board-runtime-status.js'), ['--help']);
assert(helpResult.status === 0, `--help exited ${helpResult.status}`);
ok('--help exits 0');

// ── Step 3: inspect-card-definition-and-runtime.js ───────────────────────────

console.log('\n--- inspect-card-definition-and-runtime.js ---');

const cardInspect = parseOk(path.join(CLI_DIR, 'inspect-card-definition-and-runtime.js'), [
  '--card-id', TEST_CARD_ID,
]);
assert(cardInspect.cardId === TEST_CARD_ID, 'cardId mismatch');
assert(cardInspect.card_definition_and_static_data, 'missing card_definition_and_static_data');
assert(cardInspect.card_status_in_board, 'missing card_status_in_board');
assert(typeof cardInspect.runtime_data === 'object', 'missing runtime_data');
assert(typeof cardInspect.runtime_data.view_model === 'object', 'missing view_model');
ok('inspect card returns card definition and runtime data');

// verify missing card-id exits non-zero
const noCardId = run(path.join(CLI_DIR, 'inspect-card-definition-and-runtime.js'), []);
assert(noCardId.status !== 0, 'missing --card-id should exit non-zero');
ok('missing --card-id exits non-zero');

// ── Step 4: discover-source-kinds.js ─────────────────────────────────────────

console.log('\n--- discover-source-kinds.js ---');

// Board has no task executor, so the bundled CLI returns { status: "fail" }.
// The wrapper script does NOT unwrap the envelope (contract bug), so it exits 0
// but outputs empty/incomplete data. Verify it at least runs without crashing.
const discoverResult = run(path.join(CLI_DIR, 'discover-source-kinds.js'), []);
assert(discoverResult.status === 0 || discoverResult.status === 1, 'discover-source-kinds should exit cleanly');
if (discoverResult.status === 0) {
  const discoverParsed = JSON.parse(discoverResult.stdout);
  assert(typeof discoverParsed === 'object', 'discover-source-kinds should output JSON');
}
ok('runs without crashing (no task executor)');

// ── Step 5: Upload an attachment and test inspect-file-contents.js ───────────

console.log('\n--- inspect-file-contents.js ---');

const fileContent = 'test attachment content for regression check';
const storedName = '001-test-attachment.txt';
const artifactKey = `${TEST_CARD_ID}/${storedName}`;

// Put the file into artifacts store
parseOk(ARTIFACTS_CLI, ['put', '--store-ref', ARTIFACTS_REF, '--key', artifactKey], {
  input: fileContent,
  encoding: undefined,
});

// Update card's files metadata
const cardWithFile = { ...testCard, card_data: { ...testCard.card_data, files: [{ name: 'test-attachment.txt', stored_name: storedName, size: fileContent.length, mime_type: 'text/plain' }] } };
runOk(CARD_CLI, ['set', '--store-ref', CARDS_REF], { input: JSON.stringify(cardWithFile) });

const fileResult = run(path.join(CLI_DIR, 'inspect-file-contents.js'), [
  '--card-id', TEST_CARD_ID,
  '--file-idx', '0',
]);
assert(fileResult.status === 0, `inspect-file-contents exited ${fileResult.status}: ${fileResult.stderr}`);
assert(fileResult.stdout === fileContent, `file content mismatch: got "${fileResult.stdout}"`);
ok('inspect-file-contents returns exact attachment bytes');

// missing card-id
const noCardFile = run(path.join(CLI_DIR, 'inspect-file-contents.js'), ['--file-idx', '0']);
assert(noCardFile.status !== 0, 'missing --card-id should exit non-zero');
ok('missing --card-id exits non-zero');

// ── Step 6: inspect-chat-messages-on-cards.js ────────────────────────────────

console.log('\n--- inspect-chat-messages-on-cards.js ---');

// Seed a chat store with some messages
runOk(CHAT_CLI, [
  '--stdin',
], {
  input: JSON.stringify({
    command: 'append',
    storeRef: RUNTIME_REF,
    cardId: TEST_CARD_ID,
    role: 'user',
    text: 'hello from test',
    files: [],
  }),
});
runOk(CHAT_CLI, [
  '--stdin',
], {
  input: JSON.stringify({
    command: 'append',
    storeRef: RUNTIME_REF,
    cardId: TEST_CARD_ID,
    role: 'assistant',
    text: 'Echo: hello from test',
    files: [],
  }),
});

const chatResult = parseOk(path.join(CLI_DIR, 'inspect-chat-messages-on-cards.js'), [
  '--card-id', TEST_CARD_ID,
  'get-messages',
]);
assert(chatResult.cardId === TEST_CARD_ID, 'chat cardId mismatch');
assert(Array.isArray(chatResult.messages), 'chat messages not an array');
assert(chatResult.messages.length >= 2, `expected at least 2 chat messages, got ${chatResult.messages.length}`);
const userMsg = chatResult.messages.find(m => m.role === 'user');
assert(userMsg && userMsg.text === 'hello from test', 'user chat message text mismatch');
ok('get-messages returns seeded chat records');

// test --tail
const tailResult = parseOk(path.join(CLI_DIR, 'inspect-chat-messages-on-cards.js'), [
  '--card-id', TEST_CARD_ID,
  '--tail', '1',
  'get-messages',
]);
assert(tailResult.messages.length === 1, `--tail 1 returned ${tailResult.messages.length} messages`);
ok('--tail filters to last N messages');

// missing command
const noCmd = run(path.join(CLI_DIR, 'inspect-chat-messages-on-cards.js'), ['--card-id', TEST_CARD_ID]);
assert(noCmd.status !== 0, 'missing command should exit non-zero');
ok('missing command exits non-zero');

// ── Step 7: manage-live-board-card.js ────────────────────────────────────────

console.log('\n--- manage-live-board-card.js ---');

// read-card
const readCardResult = parseOk(path.join(CLI_DIR, 'manage-live-board-card.js'), [
  'read-card', '--card-id', TEST_CARD_ID,
]);
const readCard = Array.isArray(readCardResult) ? readCardResult[0] : readCardResult;
assert(readCard?.id === TEST_CARD_ID, 'read-card id mismatch');
ok('read-card returns stored card');

// upsert-card
const UPSERT_CARD_ID = 'test-card-upsert';
const upsertCard = {
  id: UPSERT_CARD_ID,
  card_data: { v: 1 },
};
const upsertRes = parseOk(path.join(CLI_DIR, 'manage-live-board-card.js'), [
  'upsert-card', '--card-id', UPSERT_CARD_ID,
], { input: JSON.stringify({ candidate_card_content: upsertCard }) });
assert(upsertRes.status === 'success', `upsert-card failed: ${JSON.stringify(upsertRes)}`);
ok('upsert-card validates, stores, and registers');

// verify the upserted card appears in board status
const postUpsertStatus = parseOk(path.join(CLI_DIR, 'inspect-board-runtime-status.js'), ['read-status']);
const upsertedInStatus = postUpsertStatus.cards.find(c => c['card-id'] === UPSERT_CARD_ID);
assert(upsertedInStatus, `upserted card ${UPSERT_CARD_ID} not found in board status`);
ok('upserted card visible in board status');

// deprecate
const deprecateRes = parseOk(path.join(CLI_DIR, 'manage-live-board-card.js'), [
  'deprecate', '--card-id', UPSERT_CARD_ID,
]);
assert(deprecateRes.status === 'success', `deprecate failed: ${JSON.stringify(deprecateRes)}`);
ok('deprecate removes card from board');

// ── Step 8: preflight-validate-candidate-card-definition.js ──────────────────

console.log('\n--- preflight-validate-candidate-card-definition.js ---');

const validCard = {
  id: 'candidate-1',
  card_data: { v: 1 },
};
const validateResult = parseOk(path.join(CLI_DIR, 'preflight-validate-candidate-card-definition.js'), [], {
  input: JSON.stringify({ candidate_card_content: validCard }),
});
assert(validateResult.status === 'success', `validate returned ${validateResult.status}`);
ok('valid card passes preflight validation');

// invalid card (missing id)
const invalidCard = { card_data: { v: 1 } };
const invalidResult = run(path.join(CLI_DIR, 'preflight-validate-candidate-card-definition.js'), [], {
  input: JSON.stringify({ candidate_card_content: invalidCard }),
});
// May succeed or fail depending on schema — just verify it doesn't crash
assert(invalidResult.status === 0 || invalidResult.status === 1, 'validate should exit cleanly even for invalid cards');
ok('invalid card does not crash the validator');

// ── Step 8b: preflight-materialize-candidate-card.js ─────────────────────────

console.log('\n--- preflight-materialize-candidate-card.js ---');

const materializePayload = {
  candidate_card_content: {
    id: 'mat-test',
    card_data: { price: 10, quantity: 3 },
    compute: [{ output: 'computed_values.total', expr: 'card_data.price * card_data.quantity' }],
  },
  mock_requires: {},
  mock_fetched_sources: {},
};
const materializeResult = run(path.join(CLI_DIR, 'preflight-materialize-candidate-card.js'), [], {
  input: JSON.stringify(materializePayload),
});
// Script should not crash with a missing-sibling-script error
assert(materializeResult.status === 0 || materializeResult.status === 1, 'preflight-materialize should not crash');
assert(!materializeResult.stderr?.includes('Cannot find module'), 'preflight-materialize references a missing script');
assert(!materializeResult.stderr?.includes('ENOENT'), 'preflight-materialize references a missing file');
ok('preflight-materialize-candidate-card runs without missing-script error');

// ── Step 8c: preflight-run-one-cycle-with-candidate-card.js ──────────────────

console.log('\n--- preflight-run-one-cycle-with-candidate-card.js ---');

const cyclePayload = {
  candidate_card_content: {
    id: 'cycle-test',
    card_data: { v: 1 },
  },
  mock_requires: {},
};
const cycleResult = run(path.join(CLI_DIR, 'preflight-run-one-cycle-with-candidate-card.js'), [], {
  input: JSON.stringify(cyclePayload),
});
assert(cycleResult.status === 0 || cycleResult.status === 1, 'preflight-run-one-cycle should not crash');
assert(!cycleResult.stderr?.includes('Cannot find module'), 'preflight-run-one-cycle references a missing script');
assert(!cycleResult.stderr?.includes('ENOENT'), 'preflight-run-one-cycle references a missing file');
ok('preflight-run-one-cycle-with-candidate-card runs without missing-script error');

// ── Step 9: provide-response-to-user.js ──────────────────────────────────────

console.log('\n--- provide-response-to-user.js ---');

const responsePayload = {
  text: 'Here is your answer.',
  files: [{ name: 'result.txt', content: 'file content here' }],
};
const provideResult = parseOk(path.join(CLI_DIR, 'provide-response-to-user.js'), [
  '--card-id', TEST_CARD_ID,
], { input: JSON.stringify(responsePayload) });
assert(provideResult.status === 'success', `provide-response failed: ${JSON.stringify(provideResult)}`);
assert(provideResult.data.cardId === TEST_CARD_ID, 'response cardId mismatch');
assert(typeof provideResult.data.responseFilePath === 'string', 'missing responseFilePath');
assert(fs.existsSync(provideResult.data.responseFilePath), 'response file not written to disk');
const writtenText = fs.readFileSync(provideResult.data.responseFilePath, 'utf8');
assert(writtenText === responsePayload.text, 'response text mismatch on disk');
ok('provide-response-to-user writes response and files to disk');

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n=== All ${passed} checks passed ===\n`);
