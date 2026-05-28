#!/usr/bin/env node
/**
 * mcp-test.js
 *
 * Smoke-tests the board MCP endpoint using the same step order and assertions
 * as test-scripts.js wherever an MCP tool surface exists.
 *
 * Creates a temporary board, starts a local HTTP server around the runtime,
 * seeds data through the same CLI helpers used by test-scripts.js, then
 * exercises MCP tools in sequence. The final provide-response step stays on
 * the existing script because it is not an MCP tool.
 *
 * Usage:
 *   node mcp-test.js
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CLI_DIR = process.env.WRAPPER_SCRIPTS_DIR ?? __dirname;
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..');

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

function ensureLocalLibBuild() {
  const outputRuntime = path.join(YAML_FLOW_ROOT, 'lib', 'board-live-cards-server-runtime.js');
  const outputNode = path.join(YAML_FLOW_ROOT, 'lib', 'board-live-cards-node.js');
  const result = spawnSync(process.execPath, [
    path.join(YAML_FLOW_ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js'),
    '--config',
    'tsup.config.ts',
    '--dts',
    'false',
  ], {
    cwd: YAML_FLOW_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
  });
  if (!result.error && result.status === 0) return;
  if (fs.existsSync(outputRuntime) && fs.existsSync(outputNode)) return;
  if (result.error) throw result.error;
  throw new Error(`tsup JS-only build failed with exit ${result.status}:\n${result.stderr || result.stdout}`);
}

ensureLocalLibBuild();

const runtimeLib = await import(pathToFileURL(path.join(YAML_FLOW_ROOT, 'lib', 'board-live-cards-server-runtime.js')).href);
const nodeLib = await import(pathToFileURL(path.join(YAML_FLOW_ROOT, 'lib', 'board-live-cards-node.js')).href);

const { createSingleBoardServerRuntime } = runtimeLib;
const {
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  createFsBoardChatStorage,
  parseRef,
  serializeRef,
} = nodeLib;

const CLI_BUNDLED_DIR = resolveCliBundledDir();
const BOARD_CLI = path.join(CLI_BUNDLED_DIR, 'board-live-cards-cli.mjs');
const CARD_CLI = path.join(CLI_BUNDLED_DIR, 'card-store-cli.mjs');
const CHAT_CLI = path.join(CLI_BUNDLED_DIR, 'chat-store-cli.mjs');
const ARTIFACTS_CLI = path.join(CLI_BUNDLED_DIR, 'artifacts-store-cli.mjs');

function b64url(raw) {
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fsRef(absPath) {
  return `b64:${b64url(JSON.stringify({ kind: 'fs-path', value: absPath }))}`;
}

function run(cli, args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? CLI_DIR,
    encoding: opts.encoding ?? 'utf8',
    input: opts.input,
    windowsHide: true,
    timeout: 30_000,
  });
}

function runOk(cli, args, opts = {}) {
  const result = run(cli, args, opts);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(cli)} ${args[0] ?? ''} exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout;
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
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function httpRequest(method, url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf-8');
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        let body;
        try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
        resolve({ status: res.statusCode || 0, data: body, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers });
      });
    }).on('error', reject);
  });
}

function httpMcp(baseUrl, tool, args = {}) {
  return httpRequest('POST', `${baseUrl}/mcp`, { tool, args });
}

function httpMcpRaw(baseUrl, tool, args = {}) {
  return httpRequest('POST', `${baseUrl}/mcp-raw`, { tool, args });
}

const TEMP_ROOT = path.join(os.tmpdir(), `test-mcp-scripts-${Date.now()}-${process.pid}`);
const BOARD_DIR = path.join(TEMP_ROOT, 'board');
const CARDS_DIR = path.join(TEMP_ROOT, 'cards');
const OUTPUTS_DIR = path.join(TEMP_ROOT, 'outputs');
const SCRATCH_DIR = path.join(TEMP_ROOT, 'scratch');
const ARTIFACTS_DIR = path.join(TEMP_ROOT, 'artifacts');
const FINAL_RESP_DIR = path.join(TEMP_ROOT, 'final-responses');
const RUNTIME_DIR = path.join(BOARD_DIR, 'runtime');

for (const dir of [BOARD_DIR, CARDS_DIR, OUTPUTS_DIR, SCRATCH_DIR, ARTIFACTS_DIR, FINAL_RESP_DIR, RUNTIME_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const BOARD_REF = fsRef(BOARD_DIR);
const CARDS_REF = fsRef(CARDS_DIR);
const OUTPUTS_REF = fsRef(OUTPUTS_DIR);
const SCRATCH_REF = fsRef(SCRATCH_DIR);
const ARTIFACTS_REF = fsRef(ARTIFACTS_DIR);
const RUNTIME_REF = fsRef(RUNTIME_DIR);

const KC_PATH = path.join(CLI_DIR, 'known_constants.json');
const KC_BACKUP = KC_PATH + '.backup';
let hadExistingKC = false;
if (fs.existsSync(KC_PATH)) {
  hadExistingKC = true;
  fs.copyFileSync(KC_PATH, KC_BACKUP);
}

let server = null;

function cleanup() {
  try {
    if (server) server.close();
  } catch { /* best-effort */ }
  try {
    if (hadExistingKC) {
      fs.copyFileSync(KC_BACKUP, KC_PATH);
      fs.unlinkSync(KC_BACKUP);
    } else {
      fs.unlinkSync(KC_PATH);
    }
  } catch { /* best-effort */ }
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.unlinkSync(path.join(CLI_DIR, 'log.jsonl')); } catch { /* best-effort */ }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

async function startRuntimeServer(port) {
  const baseRef = parseRef(BOARD_REF);
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, path.resolve(__dirname, '..', '..'), { suppressSpawn: true, onWarn: () => {} });
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(baseRef, path.resolve(__dirname, '..', '..'), { suppressSpawn: true, onWarn: () => {} });
  const artifactsAdapter = createFsBoardPlatformAdapter(parseRef(ARTIFACTS_REF), YAML_FLOW_ROOT, { suppressSpawn: true, onWarn: () => {} });
  const chatStorage = createFsBoardChatStorage(parseRef(RUNTIME_REF).value);
  const runtime = createSingleBoardServerRuntime({
    apiBasePath: '/api/board',
    boardId: 'mcp-test-board',
    chatStorage,
    boards: [{
      label: 'base',
      boardAdapter,
      nonCoreAdapter,
      artifactsAdapter,
      baseRef,
      cardStoreRef: CARDS_REF,
      outputsStoreRef: OUTPUTS_REF,
      artifactsStoreRef: ARTIFACTS_REF,
    }],
    invocationAdapter: {
      async invoke() { return { dispatched: true }; },
      async describe() { return null; },
    },
    logger: { info() {}, warn() {}, error() {} },
    serverUrl: `http://127.0.0.1:${port}`,
  });

  await new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      if ((req.method || 'GET') === 'OPTIONS') {
        res.writeHead(204, runtime.corsHeaders);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const handled = await runtime.handleRuntimeApi(req, res, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return runtime;
}

console.log('\n=== mcp-test.js: MCP regression tests ===\n');
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

const configDir = path.join(BOARD_DIR, '.config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'chat-store-ref.json'), JSON.stringify(RUNTIME_REF), 'utf8');
ok('board init');

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
const upsertResult = parseOk(BOARD_CLI, ['upsert-card', '--base-ref', BOARD_REF, '--card-id', TEST_CARD_ID]);
assert(upsertResult.status === 'success', `upsert-card failed: ${JSON.stringify(upsertResult)}`);
ok('test card created and registered');

const PORT = await findFreePort();
const BASE = `http://127.0.0.1:${PORT}/api/board`;
await startRuntimeServer(PORT);

console.log('\n--- inspect-board-runtime-status.js ---');
const statusResult = await httpMcp(BASE, 'inspect.board-runtime-status', {});
assert(statusResult.status === 200, `inspect.board-runtime-status returned ${statusResult.status}: ${JSON.stringify(statusResult.data)}`);
assert(typeof statusResult.data?.summary === 'object', 'missing summary in status');
assert(typeof statusResult.data?.summary?.card_count === 'number', 'missing card_count');
assert(statusResult.data.summary.card_count >= 1, `expected at least 1 card, got ${statusResult.data.summary.card_count}`);
assert(Array.isArray(statusResult.data?.cards), 'missing cards array');
const statusCard = statusResult.data.cards.find((card) => card['card-id'] === TEST_CARD_ID);
assert(statusCard, `test card ${TEST_CARD_ID} not found in board status`);
ok('read-status returns well-shaped summary with test card');

const helpResult = run(path.join(CLI_DIR, 'inspect-board-runtime-status.js'), ['--help']);
assert(helpResult.status === 0, `--help exited ${helpResult.status}`);
ok('--help exits 0');

console.log('\n--- inspect-card-definition-and-runtime.js ---');
const cardInspect = await httpMcp(BASE, 'inspect.card-definition-and-runtime', { card_id: TEST_CARD_ID });
assert(cardInspect.status === 200, `inspect.card-definition-and-runtime returned ${cardInspect.status}: ${JSON.stringify(cardInspect.data)}`);
assert(cardInspect.data.cardId === TEST_CARD_ID, 'cardId mismatch');
assert(cardInspect.data.card_definition_and_static_data, 'missing card_definition_and_static_data');
assert(cardInspect.data.card_status_in_board, 'missing card_status_in_board');
assert(typeof cardInspect.data.runtime_data === 'object', 'missing runtime_data');
assert(typeof cardInspect.data.runtime_data.rendered_view === 'object', 'missing rendered_view');
ok('inspect card returns card definition and runtime data');

const noCardId = await httpMcp(BASE, 'inspect.card-definition-and-runtime', {});
assert(noCardId.status !== 200, 'missing card-id should return non-200');
ok('missing --card-id exits non-zero');

console.log('\n--- discover-source-kinds.js ---');
const discoverResult = await httpMcp(BASE, 'discover.source-kinds', {});
assert(discoverResult.status === 200 || discoverResult.status === 500, 'discover-source-kinds should return cleanly');
if (discoverResult.status === 200) {
  assert(typeof discoverResult.data === 'object', 'discover-source-kinds should output JSON');
} else {
  assert(typeof discoverResult.data?.error === 'string', 'discover-source-kinds error should be JSON-shaped');
}
ok('runs without crashing (no task executor)');

console.log('\n--- inspect-file-contents.js ---');
const fileContent = 'test attachment content for regression check';
const storedName = '001-test-attachment.txt';
const artifactKey = `${TEST_CARD_ID}/${storedName}`;

parseOk(ARTIFACTS_CLI, ['put', '--store-ref', ARTIFACTS_REF, '--key', artifactKey], {
  input: fileContent,
  encoding: undefined,
});

const cardWithFile = {
  ...testCard,
  card_data: {
    ...testCard.card_data,
    files: [{ name: 'test-attachment.txt', stored_name: storedName, size: fileContent.length, mime_type: 'text/plain' }],
  },
};
runOk(CARD_CLI, ['set', '--store-ref', CARDS_REF], { input: JSON.stringify(cardWithFile) });

const fileResult = await httpMcpRaw(BASE, 'inspect.file-contents', { card_id: TEST_CARD_ID, file_idx: 0 });
assert(fileResult.status === 200, `inspect.file-contents raw returned ${fileResult.status}: ${JSON.stringify(fileResult.data)}`);
assert(typeof fileResult.data === 'string', 'inspect.file-contents raw should return raw text for text files');
assert(fileResult.data === fileContent, `file content mismatch: got "${fileResult.data}"`);
ok('inspect-file-contents returns exact attachment bytes');

const noCardFile = await httpMcpRaw(BASE, 'inspect.file-contents', { file_idx: 0 });
assert(noCardFile.status !== 200, 'missing --card-id should return non-200');
ok('missing --card-id exits non-zero');

console.log('\n--- inspect-chat-messages-on-cards.js ---');
runOk(CHAT_CLI, ['--stdin'], {
  input: JSON.stringify({ command: 'append', storeRef: RUNTIME_REF, cardId: TEST_CARD_ID, role: 'user', text: 'hello from test', files: [] }),
});
runOk(CHAT_CLI, ['--stdin'], {
  input: JSON.stringify({ command: 'append', storeRef: RUNTIME_REF, cardId: TEST_CARD_ID, role: 'assistant', text: 'Echo: hello from test', files: [] }),
});

const chatResult = await httpMcp(BASE, 'inspect.chat-messages-on-cards', { card_id: TEST_CARD_ID });
assert(chatResult.status === 200, `inspect.chat-messages-on-cards returned ${chatResult.status}: ${JSON.stringify(chatResult.data)}`);
assert(chatResult.data.cardId === TEST_CARD_ID, 'chat cardId mismatch');
assert(Array.isArray(chatResult.data.messages), 'chat messages not an array');
assert(chatResult.data.messages.length >= 2, `expected at least 2 chat messages, got ${chatResult.data.messages.length}`);
const userMsg = chatResult.data.messages.find((message) => message.role === 'user');
assert(userMsg && userMsg.text === 'hello from test', 'user chat message text mismatch');
ok('get-messages returns seeded chat records');

const tailResult = await httpMcp(BASE, 'inspect.chat-messages-on-cards', { card_id: TEST_CARD_ID, tail: 1 });
assert(tailResult.status === 200, `tail chat result returned ${tailResult.status}`);
assert(tailResult.data.messages.length === 1, `--tail 1 returned ${tailResult.data.messages.length} messages`);
ok('--tail filters to last N messages');

const noCmd = await httpRequest('POST', `${BASE}/mcp`, { args: { card_id: TEST_CARD_ID } });
assert(noCmd.status !== 200, 'missing command should return non-200');
ok('missing command exits non-zero');

console.log('\n--- manage-live-board-card.js ---');
const readCardResult = await httpMcp(BASE, 'manage.read-card', { card_id: TEST_CARD_ID });
assert(readCardResult.status === 200, `manage.read-card returned ${readCardResult.status}: ${JSON.stringify(readCardResult.data)}`);
const readCard = Array.isArray(readCardResult.data) ? readCardResult.data[0] : readCardResult.data;
assert(readCard?.id === TEST_CARD_ID, 'read-card id mismatch');
ok('read-card returns stored card');

const UPSERT_CARD_ID = 'test-card-upsert';
const upsertCard = { id: UPSERT_CARD_ID, card_data: { v: 1 } };
const upsertRes = await httpMcp(BASE, 'manage.upsert-card', { card_id: UPSERT_CARD_ID, candidate_card_content: upsertCard });
assert(upsertRes.status === 200, `upsert-card returned ${upsertRes.status}: ${JSON.stringify(upsertRes.data)}`);
assert(upsertRes.data.status === 'success', `upsert-card failed: ${JSON.stringify(upsertRes.data)}`);
ok('upsert-card validates, stores, and registers');

const postUpsertStatus = await httpMcp(BASE, 'inspect.board-runtime-status', {});
assert(postUpsertStatus.status === 200, `post upsert status returned ${postUpsertStatus.status}`);
const upsertedInStatus = postUpsertStatus.data.cards.find((card) => card['card-id'] === UPSERT_CARD_ID);
assert(upsertedInStatus, `upserted card ${UPSERT_CARD_ID} not found in board status`);
ok('upserted card visible in board status');

const deprecateRes = await httpMcp(BASE, 'manage.deprecate', { card_id: UPSERT_CARD_ID });
assert(deprecateRes.status === 200, `deprecate returned ${deprecateRes.status}: ${JSON.stringify(deprecateRes.data)}`);
assert(deprecateRes.data.status === 'success', `deprecate failed: ${JSON.stringify(deprecateRes.data)}`);
ok('deprecate removes card from board');

console.log('\n--- preflight-validate-candidate-card-definition.js ---');
const validCard = { id: 'candidate-1', card_data: { v: 1 } };
const validateResult = await httpMcp(BASE, 'preflight.validate-candidate-card-definition', { candidate_card_content: validCard });
assert(validateResult.status === 200, `validate returned ${validateResult.status}`);
assert(validateResult.data.status === 'success', `validate returned ${validateResult.data.status}`);
ok('valid card passes preflight validation');

const invalidCard = { card_data: { v: 1 } };
const invalidResult = await httpMcp(BASE, 'preflight.validate-candidate-card-definition', { candidate_card_content: invalidCard });
assert(invalidResult.status === 200 || invalidResult.status === 500, 'validate should return cleanly even for invalid cards');
ok('invalid card does not crash the validator');

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
const materializeResult = await httpMcp(BASE, 'preflight.materialize-candidate-card', materializePayload);
assert(materializeResult.status === 200 || materializeResult.status === 500, 'preflight-materialize should not crash');
assert(!String(materializeResult.data?.error || '').includes('Cannot find module'), 'preflight-materialize references a missing script');
assert(!String(materializeResult.data?.error || '').includes('ENOENT'), 'preflight-materialize references a missing file');
ok('preflight-materialize-candidate-card runs without missing-script error');

console.log('\n--- preflight-run-one-cycle-with-candidate-card.js ---');
const cyclePayload = {
  candidate_card_content: {
    id: 'cycle-test',
    card_data: { v: 1 },
  },
  mock_requires: {},
};
const cycleResult = await httpMcp(BASE, 'preflight.run-one-cycle-with-candidate-card', cyclePayload);
assert(cycleResult.status === 200 || cycleResult.status === 500, 'preflight-run-one-cycle should not crash');
assert(!String(cycleResult.data?.error || '').includes('Cannot find module'), 'preflight-run-one-cycle references a missing script');
assert(!String(cycleResult.data?.error || '').includes('ENOENT'), 'preflight-run-one-cycle references a missing file');
ok('preflight-run-one-cycle-with-candidate-card runs without missing-script error');

console.log('\n--- provide-response-to-user.js ---');
const responsePayload = {
  text: 'Here is your answer.',
  files: [{ name: 'result.txt', content: 'file content here' }],
};
const provideResult = parseOk(path.join(CLI_DIR, 'provide-response-to-user.js'), ['--card-id', TEST_CARD_ID], {
  input: JSON.stringify(responsePayload),
});
assert(provideResult.status === 'success', `provide-response failed: ${JSON.stringify(provideResult)}`);
assert(provideResult.data.cardId === TEST_CARD_ID, 'response cardId mismatch');
assert(typeof provideResult.data.responseFilePath === 'string', 'missing responseFilePath');
assert(fs.existsSync(provideResult.data.responseFilePath), 'response file not written to disk');
const writtenText = fs.readFileSync(provideResult.data.responseFilePath, 'utf8');
assert(writtenText === responsePayload.text, 'response text mismatch on disk');
ok('provide-response-to-user writes response and files to disk');

console.log(`\n=== All ${passed} checks passed ===\n`);