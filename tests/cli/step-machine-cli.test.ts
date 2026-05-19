import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, CliExitError } from '../../src/cli/node/step-machine-cli.js';
import { KVStorageStore } from '../../src/stores/kv.js';
import { createFsKvStorage } from '../../src/cli/node/storage-fs-adapters.js';
import { serializeRef } from '../../src/cli/common/storage-interface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string; combinedOutput: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { outLines.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errLines.push(a.map(String).join(' ')); });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => { errLines.push(a.map(String).join(' ')); });

  let exitCode = 0;
  let unexpected: unknown;
  try {
    await cli(args);
  } catch (e) {
    if (e instanceof CliExitError) {
      exitCode = e.code;
    } else if (e instanceof Error) {
      errLines.push(e.stack ?? e.message);
      exitCode = 1;
    } else {
      unexpected = e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  }

  if (unexpected !== undefined) throw unexpected;

  const stdout = outLines.join('\n');
  const stderr = errLines.join('\n');
  return { status: exitCode, stdout, stderr, combinedOutput: `${stdout}\n${stderr}` };
}

function parseLastJsonObject(text: string) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // keep searching
    }
  }
  throw new Error(`Could not parse JSON from output:\n${text}`);
}

function writeFile(filePath: string, content: string) {
  fs.writeFileSync(filePath, content.trimStart());
}

/** b64url-encode a string the same way KVStorageStore does. */
function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Seed a KV file directly, bypassing the store API, for test setup. */
function seedKVFile(kvDir: string, key: string, value: unknown): void {
  const filePath = path.join(kvDir, `${key}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function seedRunState(storeDir: string, runId: string, state: object): void {
  seedKVFile(storeDir, `state_${b64url(runId)}`, state);
}

function seedRunData(storeDir: string, runId: string, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    seedKVFile(storeDir, `data_${b64url(runId)}_${b64url(key)}`, value);
  }
}

const fsRef = (p: string) => serializeRef({ kind: 'fs-path', value: p });

describe('step-machine-cli', async () => {
  it('prints usage with --help', async () => {
    const run = await runCli(['--help']);

    expect(run.status).toBe(0);
    expect(run.combinedOutput).toContain('Usage: step-machine-cli');
  });

  it('fails when no flow file is provided', async () => {
    const run = await runCli([]);

    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Usage: step-machine-cli');
  });

  it('fails fast for invalid --initial-data json', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-data-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: invalid-data-flow
settings:
  start_step: s1
steps:
  s1:
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
`);

    const run = await runCli([flowPath, '--initial-data', '{bad-json']);

    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Invalid --initial-data value');
  });

  it('fails fast for invalid --persist-runtime-ref kind', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-store-invalid-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: invalid-store-flow
settings:
  start_step: s1
steps:
  s1:
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
`);

    const run = await runCli([flowPath, '--persist-runtime-ref', serializeRef({ kind: 'mem', value: 'runtime-store' })]);

    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('--persist-runtime-ref must be an fs-path ref');
  });

  it('uses memory store when --persist-runtime-ref is omitted', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-store-dir-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: file-store-flow
settings:
  start_step: s1
steps:
  s1:
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
`);

    const run = await runCli([flowPath]);

    expect(run.status).toBe(0);
  });

  it('persists run state when using --persist-runtime-ref', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-file-store-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const storeDir = path.join(tmpRoot, 'runs');
    const persistRuntimeRef = fsRef(storeDir);

    writeFile(flowPath, `
id: persist-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [x]
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x]
`);

    const run = await runCli([
      flowPath,
      '--persist-runtime-ref',
      persistRuntimeRef,
      '--initial-data',
      '{"x":42}',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 42 });

    // Verify the run state was actually persisted via the KVStorage store
    const kvStore = new KVStorageStore(createFsKvStorage(storeDir));
    const savedState = await kvStore.loadRunState(output.runId);
    expect(savedState).not.toBeNull();
    expect(savedState?.status).toBe('completed');
  });

  it('resumes the latest paused run when using --resume with --persist-runtime-ref', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-resume-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const storeDir = path.join(tmpRoot, 'runs');
    const persistRuntimeRef = fsRef(storeDir);
    const runId = 'resume-run-1';
    const startedAt = Date.now() - 1000;

    fs.mkdirSync(storeDir, { recursive: true });

    writeFile(flowPath, `
id: resume-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [x]
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x]
`);

    seedRunState(storeDir, runId, {
      runId,
      flowId: 'resume-flow',
      currentStep: 's1',
      status: 'paused',
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt,
      updatedAt: startedAt,
      pausedAt: startedAt,
    });
    seedRunData(storeDir, runId, { x: 7 });

    const run = await runCli([
      flowPath,
      '--persist-runtime-ref',
      persistRuntimeRef,
      '--resume',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.runId).toBe(runId);
    expect(output.data).toEqual({ x: 7 });
  });

  it('writes a pause request marker when using --pause with --persist-runtime-ref', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-pause-'));
    const storeDir = path.join(tmpRoot, 'runs');
    const persistRuntimeRef = fsRef(storeDir);
    const runId = 'pause-run-1';
    const startedAt = Date.now() - 1000;

    fs.mkdirSync(storeDir, { recursive: true });

    seedRunState(storeDir, runId, {
      runId,
      flowId: 'pause-flow',
      currentStep: 's1',
      status: 'running',
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt,
      updatedAt: startedAt,
    });
    seedRunData(storeDir, runId, {});

    const run = await runCli([
      '--persist-runtime-ref',
      persistRuntimeRef,
      '--pause',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.status).toBe('pause-requested');
    expect(output.persistRuntimeRef).toBe(persistRuntimeRef);
    expect(fs.existsSync(path.join(storeDir, '.pause'))).toBe(true);
  });

  it('shows persisted runtime status with --status for --persist-runtime-ref', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-status-'));
    const storeDir = path.join(tmpRoot, 'runs');
    const persistRuntimeRef = fsRef(storeDir);
    const runId = 'status-run-1';
    const startedAt = Date.now() - 1000;

    fs.mkdirSync(storeDir, { recursive: true });

    seedRunState(storeDir, runId, {
      runId,
      flowId: 'status-flow',
      currentStep: 's1',
      status: 'paused',
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt,
      updatedAt: startedAt,
      pausedAt: startedAt,
    });

    const run = await runCli([
      '--persist-runtime-ref',
      persistRuntimeRef,
      '--status',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.persistRuntimeRef).toBe(persistRuntimeRef);
    expect(output.totalRuns).toBe(1);
    expect(output.runs[0].runId).toBe(runId);
    expect(output.runs[0].status).toBe('paused');

  });

  it('uses passthrough when no step handler is configured', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-pass-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: passthrough-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [x]
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x]
`);

    const run = await runCli([
      flowPath,
      '--initial-data',
      '{"x":7}',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 7 });
  });

  it('runs ref steps and filters by produces_data', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-ref-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'echo-y.js');

    writeFile(flowPath, `
id: ref-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./echo-y.js')}"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x, y, z]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw || '{}');
  const x = Number(input.x);
  process.stdout.write(JSON.stringify({ y: x + 10, z: 999 }));
});
process.stdin.resume();
`);

    const run = await runCli([flowPath, '--initial-data', '{"x":7}']);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 7, y: 17 });
  });

  it('runs compute-jsonata handler with input_validations', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-compute-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: compute-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [a, b]
    produces_data: [c]
    input_validations:
      - $type(a) = "number"
      - $type(b) = "number"
    handler:
      type: compute-jsonata
      expr:
        - data.c = expects_data.a + expects_data.b
        - result = "success"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [a, b, c]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    // Success case
    const run = await runCli([flowPath, '--initial-data', '{"a":5,"b":3}']);
    expect(run.status).toBe(0);
    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ a: 5, b: 3, c: 8 });

    // Validation failure case
    const failRun = await runCli([flowPath, '--initial-data', '{"a":"bad","b":3}']);
    expect(failRun.error).toBeUndefined();
    expect(failRun.status).toBe(0);
    const failOutput = parseLastJsonObject(failRun.stdout ?? '');
    expect(failOutput.intent).toBe('failure');
  });

  it('maps non-zero ref exit into failure transition', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-ref-exit-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'fail.js');

    writeFile(flowPath, `
id: ref-exit-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./fail.js')}"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
process.stderr.write('boom');
process.exit(23);
`);

    const run = await runCli([flowPath]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('treats non-JSON stdout from ref handler as success with stdout fallback', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-ref-json-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'bad-json.js');

    writeFile(flowPath, `
id: ref-json-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./bad-json.js')}"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
process.stdout.write('not-json-output');
`);

    const run = await runCli([flowPath]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
  });

  it('supports ref handler with script path containing spaces', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-space-path-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'double value.js');

    writeFile(flowPath, `
id: space-path-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./double value.js')}"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x, y]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw || '{}');
  const x = Number(input.x);
  process.stdout.write(JSON.stringify({ y: x * 2 }));
});
process.stdin.resume();
`);

    const run = await runCli([flowPath, '--initial-data', '{"x":9}']);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 9, y: 18 });
  });

  it('supports ref handler with argsMassaging.stdinTemplate', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-ref-body-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'echo-y.js');

    writeFile(flowPath, `
id: ref-body-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./echo-y.js')}"
      argsMassaging:
        stdinTemplate: "{ 'X': x }"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [x, y]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw || '{}');
  process.stdout.write(JSON.stringify({ y: Number(input.X) + 5 }));
});
process.stdin.resume();
`);

    const run = await runCli([flowPath, '--initial-data', '{"x":10}']);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 10, y: 15 });
  });

  it('supports mixed compute-jsonata and ref handlers with produces_data filtering', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-mixed-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'double.js');

    writeFile(flowPath, `
id: mixed-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [a, b]
    produces_data: [c]
    handler:
      type: compute-jsonata
      expr:
        - data.c = expects_data.a + expects_data.b
        - result = "success"
    transitions:
      success: s2
      failure: failed_state
  s2:
    expects_data: [c]
    produces_data: [d]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./double.js')}"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [a, b, c, d]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw || '{}');
  const c = Number(input.c);
  process.stdout.write(JSON.stringify({ d: c * 2 }));
});
process.stdin.resume();
`);

    const run = await runCli([
      flowPath,
      '--initial-data',
      '{"a":3,"b":4}',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.stepHistory).toEqual(['s1', 's2']);
    expect(output.data).toEqual({ a: 3, b: 4, c: 7, d: 14 });
  });

  it('supports argsMassaging.stdinTemplate for ref handlers', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-jsonata-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'init-board.js');

    writeFile(flowPath, `
id: jsonata-ref-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [runtime_root, board_name]
    produces_data: [board_dir, message]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./init-board.js')}"
      argsMassaging:
        stdinTemplate: "{ 'BOARD_DIR': runtime_root & '/' & board_name }"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [board_dir, message]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw || '{}');
  if (!input.BOARD_DIR) {
    process.stderr.write('BOARD_DIR missing');
    process.exit(1);
    return;
  }

  process.stdout.write(JSON.stringify({
    board_dir: input.BOARD_DIR,
    message: 'initialized-ok',
  }));
});
process.stdin.resume();
`);

    const run = await runCli([
      flowPath,
      '--initial-data',
      '{"runtime_root":"/tmp/runtime","board_name":"board-a"}',
    ]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({
      board_dir: '/tmp/runtime/board-a',
      message: 'initialized-ok',
    });
  });

  it('routes to failed_state when ref has invalid whatToRun kindref', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-bad-kindref-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: bad-kindref-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "no-kind-prefix"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    const run = await runCli([flowPath, '--initial-data', '{"x":1}']);

    // parseKindRef throws inside handler, step machine catches and routes to failure
    expect(run.status).toBe(0);
    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('routes to failed_state when compute-jsonata expression throws', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-compute-fail-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: compute-failure-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      type: compute-jsonata
      expr:
        - result = $nonExistentFn()
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    const run = await runCli([flowPath]);

    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  // ===========================================================================
  // compute-jsonata: case/switch patterns
  // ===========================================================================

  it('compute-jsonata: object-lookup switch routes to correct transition', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-switch-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: switch-flow
settings:
  start_step: classify
steps:
  classify:
    description: Route based on risk_level via object-lookup switch
    expects_data: [risk_level]
    produces_data: [label]
    handler:
      type: compute-jsonata
      expr:
        - 'data.label = $lookup({"low": "routine", "medium": "review", "high": "escalate"}, expects_data.risk_level)'
        - 'result = data.label != null ? data.label : "unknown"'
    transitions:
      routine:   low_track
      review:    mid_track
      escalate:  high_track
      unknown:   failed_state
  low_track:
    handler:
      type: compute-jsonata
      expr:
        - data.outcome = "approved"
        - result = "success"
    transitions:
      success: success_state
      failure: failed_state
  mid_track:
    handler:
      type: compute-jsonata
      expr:
        - data.outcome = "pending"
        - result = "success"
    transitions:
      success: success_state
      failure: failed_state
  high_track:
    handler:
      type: compute-jsonata
      expr:
        - data.outcome = "blocked"
        - result = "success"
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [risk_level, label, outcome]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    const cases: Array<[string, string, string, string]> = [
      ['low',    'routine',  'approved', 'low_track'],
      ['medium', 'review',   'pending',  'mid_track'],
      ['high',   'escalate', 'blocked',  'high_track'],
    ];

    for (const [risk, label, outcome, track] of cases) {
      const run = await runCli([flowPath, '--initial-data', JSON.stringify({ risk_level: risk })]);
      const out = parseLastJsonObject(run.stdout ?? '');
      expect(out.intent).toBe('success');
      expect(out.data.label).toBe(label);
      expect(out.data.outcome).toBe(outcome);
      expect(out.stepHistory).toContain(track);
    }

    // Unknown value falls through to unknown -> failed_state
    const unknownRun = await runCli([flowPath, '--initial-data', '{"risk_level":"critical"}']);
    const unknownOut = parseLastJsonObject(unknownRun.stdout ?? '');
    expect(unknownOut.intent).toBe('failure');
  });

  it('compute-jsonata: chained ternary grading with local binding', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-grade-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: grade-flow
settings:
  start_step: score_step
steps:
  score_step:
    description: Grade a numeric score using local binding and chained ternary
    expects_data: [score]
    produces_data: [grade, band]
    input_validations:
      - $type(score) = "number"
      - score >= 0 and score <= 100
    handler:
      type: compute-jsonata
      expr:
        - 'data.grade = ($s := expects_data.score; $s >= 90 ? "A" : $s >= 80 ? "B" : $s >= 70 ? "C" : $s >= 60 ? "D" : "F")'
        - 'data.band = ($s := expects_data.score; $s >= 90 ? "distinction" : $s >= 60 ? "pass" : "fail")'
        - 'result = data.grade = "F" ? "failing" : "passing"'
    transitions:
      passing: success_state
      failing: remediation_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [score, grade, band]
  remediation_state:
    return_intent: failure
    return_artifacts: [score, grade, band]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    // A — distinction
    const runA = await runCli([flowPath, '--initial-data', '{"score":95}']);
    const outA = parseLastJsonObject(runA.stdout ?? '');
    expect(outA.intent).toBe('success');
    expect(outA.data).toEqual({ score: 95, grade: 'A', band: 'distinction' });

    // B — pass
    const runB = await runCli([flowPath, '--initial-data', '{"score":82}']);
    const outB = parseLastJsonObject(runB.stdout ?? '');
    expect(outB.intent).toBe('success');
    expect(outB.data).toEqual({ score: 82, grade: 'B', band: 'pass' });

    // F — routes to remediation (failure intent but not an error)
    const runF = await runCli([flowPath, '--initial-data', '{"score":45}']);
    const outF = parseLastJsonObject(runF.stdout ?? '');
    expect(outF.intent).toBe('failure');
    expect(outF.data.grade).toBe('F');
    expect(outF.data.band).toBe('fail');

    // input_validation: out-of-range score
    const runBad = await runCli([flowPath, '--initial-data', '{"score":150}']);
    const outBad = parseLastJsonObject(runBad.stdout ?? '');
    expect(outBad.intent).toBe('failure');
  });

  // ─── outputTransforms ──────────────────────────────────────────────────────

  it('outputTransforms: reshapes raw ref output with resultExpr and dataTemplate (success)', async () => {
    // Script echoes a raw payload. outputTransforms reshapes it via JSONata.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-out-xform-ok-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const scriptPath = path.join(tmpRoot, 'script.js');

    writeFile(flowPath, `
id: output-transforms-ok
settings:
  start_step: step1
steps:
  step1:
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./script.js')}"
      outputTransforms:
        resultExpr: "output.data.code = 200 ? 'success' : 'failure'"
        dataTemplate: "{ 'value': output.data.payload.value }"
    transitions:
      success: done_state
      failure: failed_state
terminal_states:
  done_state:
    return_intent: success
    return_artifacts: [value]
  failed_state:
    return_intent: failure
    return_artifacts: []
`);

    writeFile(scriptPath, `
process.stdout.write(JSON.stringify({ code: 200, payload: { value: 42 } }));
process.exit(0);
`);

    const run = await runCli([flowPath]);
    const out = parseLastJsonObject(run.stdout ?? '');
    expect(out.intent).toBe('success');
    expect(out.data.value).toBe(42);
    expect(out.data.code).toBeUndefined(); // dataTemplate replaced the whole data object
  });

  it('outputTransforms: errorExpr populates error field and routes to failure', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-out-xform-err-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const scriptPath = path.join(tmpRoot, 'script.js');

    writeFile(flowPath, `
id: output-transforms-err
settings:
  start_step: step1
steps:
  step1:
    handler:
      type: ref
      howToRun: local-node
      whatToRun: "${fsRef('./script.js')}"
      outputTransforms:
        resultExpr: "output.data.code = 200 ? 'success' : 'failure'"
        errorExpr: "output.data.code != 200 ? output.data.error_message"
        dataTemplate: "{ 'code': output.data.code }"
    transitions:
      success: done_state
      failure: failed_state
terminal_states:
  done_state:
    return_intent: success
    return_artifacts: []
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(scriptPath, `
process.stdout.write(JSON.stringify({ code: 500, error_message: "boom" }));
process.exit(0);
`);

    const run = await runCli([flowPath]);
    const out = parseLastJsonObject(run.stdout ?? '');
    expect(out.intent).toBe('failure');
    expect(out.data.error).toBe('boom');
  });
});
