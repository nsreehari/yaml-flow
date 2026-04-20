import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stepMachineCli = path.join(repoRoot, 'step-machine-cli.js');

function runStepMachineCli(args: string[]) {
  const result = spawnSync(process.execPath, [stepMachineCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });

  return {
    ...result,
    combinedOutput: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
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

describe('step-machine-cli', () => {
  it('prints usage with --help', () => {
    const run = runStepMachineCli(['--help']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.combinedOutput).toContain('Usage: step-machine-cli');
  });

  it('fails when no flow file is provided', () => {
    const run = runStepMachineCli([]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Usage: step-machine-cli');
  });

  it('fails fast for invalid --initial-data json', () => {
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

    const run = runStepMachineCli([flowPath, '--initial-data', '{bad-json']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Invalid --initial-data value');
  });

  it('fails fast for invalid --store value', () => {
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

    const run = runStepMachineCli([flowPath, '--store', 'redis']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Invalid --store value');
  });

  it('requires --store-dir when --store file is used', () => {
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

    const run = runStepMachineCli([flowPath, '--store', 'file']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('--store file requires --store-dir');
  });

  it('persists run state when using --store file', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-file-store-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const storeDir = path.join(tmpRoot, 'runs');

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

    const run = runStepMachineCli([
      flowPath,
      '--store',
      'file',
      '--store-dir',
      storeDir,
      '--initial-data',
      '{"x":42}',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 42 });

    const runStatePath = path.join(storeDir, `${output.runId}.run.json`);
    const runDataPath = path.join(storeDir, `${output.runId}.data.json`);
    expect(fs.existsSync(runStatePath)).toBe(true);
    expect(fs.existsSync(runDataPath)).toBe(true);
  });

  it('resumes the latest paused run when using --resume with --store file', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-resume-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const storeDir = path.join(tmpRoot, 'runs');
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

    writeFile(path.join(storeDir, `${runId}.run.json`), `
{
  "runId": "${runId}",
  "flowId": "resume-flow",
  "currentStep": "s1",
  "status": "paused",
  "stepHistory": [],
  "iterationCounts": {},
  "retryCounts": {},
  "startedAt": ${startedAt},
  "updatedAt": ${startedAt},
  "pausedAt": ${startedAt}
}
`);

    writeFile(path.join(storeDir, `${runId}.data.json`), `
{
  "x": 7
}
`);

    const run = runStepMachineCli([
      flowPath,
      '--store',
      'file',
      '--store-dir',
      storeDir,
      '--resume',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.runId).toBe(runId);
    expect(output.data).toEqual({ x: 7 });
  });

  it('writes a pause request marker when using --pause with --store file', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-pause-'));
    const storeDir = path.join(tmpRoot, 'runs');
    const runId = 'pause-run-1';
    const startedAt = Date.now() - 1000;

    fs.mkdirSync(storeDir, { recursive: true });

    writeFile(path.join(storeDir, `${runId}.run.json`), `
{
  "runId": "${runId}",
  "flowId": "pause-flow",
  "currentStep": "s1",
  "status": "running",
  "stepHistory": [],
  "iterationCounts": {},
  "retryCounts": {},
  "startedAt": ${startedAt},
  "updatedAt": ${startedAt}
}
`);

    writeFile(path.join(storeDir, `${runId}.data.json`), `
{}
`);

    const run = runStepMachineCli([
      '--store',
      'file',
      '--store-dir',
      storeDir,
      '--pause',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.status).toBe('pause-requested');
    expect(fs.existsSync(path.join(storeDir, '.pause'))).toBe(true);
  });

  it('shows store status with --status for file store directory', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-status-'));
    const storeDir = path.join(tmpRoot, 'runs');
    const runId = 'status-run-1';
    const startedAt = Date.now() - 1000;

    fs.mkdirSync(storeDir, { recursive: true });

    writeFile(path.join(storeDir, `${runId}.run.json`), `
{
  "runId": "${runId}",
  "flowId": "status-flow",
  "currentStep": "s1",
  "status": "paused",
  "stepHistory": [],
  "iterationCounts": {},
  "retryCounts": {},
  "startedAt": ${startedAt},
  "updatedAt": ${startedAt},
  "pausedAt": ${startedAt}
}
`);

    writeFile(path.join(storeDir, `${runId}.data.json`), `
{}
`);

    const run = runStepMachineCli([
      '--store',
      'file',
      '--store-dir',
      storeDir,
      '--status',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.totalRuns).toBe(1);
    expect(output.runs[0].runId).toBe(runId);
    expect(output.runs[0].status).toBe('paused');

  });

  it('uses passthrough when no step handler is configured', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-pass-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const handlersPath = path.join(tmpRoot, 'handlers.js');

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

    writeFile(handlersPath, `
export default {
  s1: async () => ({ result: 'success', data: { x: 999 } }),
};
`);

    const run = runStepMachineCli([
      flowPath,
      '--handlers',
      handlersPath,
      '--initial-data',
      '{"x":7}',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    // If fallback by step-name were still active, this would be 999.
    expect(output.data).toEqual({ x: 7 });
  });

  it('runs cli-only steps without --handlers and filters by produces_data', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-cli-only-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'echo-y.js');

    writeFile(flowPath, `
id: cli-only-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      cli: node ./echo-y.js
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
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const x = Number(input.x);
  process.stdout.write(JSON.stringify({
    result: 'success',
    data: { y: x + 10, z: 999 },
  }));
});
process.stdin.resume();
`);

    const run = runStepMachineCli([flowPath, '--initial-data', '{"x":7}']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 7, y: 17 });
  });

  it('fails fast when inline handler name is missing from handlers module', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-inline-missing-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const handlersPath = path.join(tmpRoot, 'handlers.js');

    writeFile(flowPath, `
id: inline-missing-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      inline: not_present
    transitions:
      success: success_state
terminal_states:
  success_state:
    return_intent: success
`);

    writeFile(handlersPath, `
export default {
  other: async () => ({ result: 'success', data: {} }),
};
`);

    const run = runStepMachineCli([flowPath, '--handlers', handlersPath]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.combinedOutput).toContain('Inline handler "not_present"');
  });

  it('maps non-zero CLI exit into failure transition', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-cli-exit-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'fail.js');

    writeFile(flowPath, `
id: cli-exit-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      cli: node ./fail.js
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

    const run = runStepMachineCli([flowPath]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('maps invalid JSON stdout from CLI handler into failure transition', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-cli-json-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'bad-json.js');

    writeFile(flowPath, `
id: cli-json-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      cli: node ./bad-json.js
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

    const run = runStepMachineCli([flowPath]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('supports handler.cli command with quoted script path containing spaces', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-quoted-path-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'double value.js');

    writeFile(flowPath, `
id: quoted-cli-path-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      cli: node "./double value.js"
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
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const x = Number(input.x);
  process.stdout.write(JSON.stringify({
    result: 'success',
    data: { y: x * 2 },
  }));
});
process.stdin.resume();
`);

    const run = runStepMachineCli([flowPath, '--initial-data', '{"x":9}']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 9, y: 18 });
  });

  it('supports top-level handler_vars in CLI command templating', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-handler-vars-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'echo-y.js');

    writeFile(flowPath, `
id: handler-vars-flow
handler_vars:
  SCRIPT_PATH: ./echo-y.js
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    produces_data: [y]
    handler:
      cli: node "%%SCRIPT_PATH%%"
      input-transforms:
        X: x
      output-transforms:
        y: data.y
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
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  process.stdout.write(JSON.stringify({
    result: 'success',
    data: { y: Number(input.X) + 5 },
  }));
});
process.stdin.resume();
`);

    const run = runStepMachineCli([flowPath, '--initial-data', '{"x":10}']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({ x: 10, y: 15 });
  });

  it('supports mixed inline and cli handlers with produces_data filtering', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-mixed-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const handlersPath = path.join(tmpRoot, 'handlers.js');
    const cliScriptPath = path.join(tmpRoot, 'double.js');

    writeFile(flowPath, `
id: mixed-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [a, b]
    produces_data: [c, e]
    handler:
      inline: add_inputs
    transitions:
      success: s2
      failure: failed_state
  s2:
    expects_data: [c]
    produces_data: [d, e]
    handler:
      cli: node ./double.js
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [a, b, c, d, e, noise]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(handlersPath, `
export default {
  async add_inputs(input) {
    const a = Number(input.a);
    const b = Number(input.b);
    return {
      result: 'success',
      data: { a, b, c: a + b, noise: 'ignore-me' },
    };
  },
};
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const c = Number(input.c);
  process.stdout.write(JSON.stringify({
    status: 'success',
    data: { d: c * 2, a: 123, noise: 'ignore-me-too' },
  }));
});
process.stdin.resume();
`);

    const run = runStepMachineCli([
      flowPath,
      '--handlers',
      handlersPath,
      '--initial-data',
      '{"a":3,"b":4}',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.stepHistory).toEqual(['s1', 's2']);
    expect(output.data).toEqual({ a: 3, b: 4, c: 7, d: 14 });
    expect(output.data.e).toBeUndefined();
  });

  it('supports JSONata input/output transforms and command templating for cli handlers', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-jsonata-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const cliScriptPath = path.join(tmpRoot, 'init-board.js');

    writeFile(flowPath, `
id: jsonata-cli-flow
settings:
  start_step: t0_init_board
steps:
  t0_init_board:
    expects_data: [runtime_root, board_name]
    produces_data: [board_dir, init_message]
    handler:
      cli: node ./init-board.js "%%BOARD_DIR%%"
      input-transforms:
        BOARD_DIR: runtime_root & "/" & board_name
      output-transforms:
        board_dir: BOARD_DIR
        init_message: data.message
    transitions:
      success: success_state
      failure: failed_state
terminal_states:
  success_state:
    return_intent: success
    return_artifacts: [board_dir, init_message, ignored]
  failed_state:
    return_intent: failure
    return_artifacts: [error]
`);

    writeFile(cliScriptPath, `
#!/usr/bin/env node
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const boardDirArg = process.argv[2] ?? '';
  if (!boardDirArg || boardDirArg !== input.BOARD_DIR) {
    process.stdout.write(JSON.stringify({ result: 'failure', error: 'board dir mismatch' }));
    return;
  }

  process.stdout.write(JSON.stringify({
    result: 'success',
    data: {
      message: 'initialized-ok',
      ignored: 'should-not-be-merged',
    },
  }));
});
process.stdin.resume();
`);

    const run = runStepMachineCli([
      flowPath,
      '--initial-data',
      '{"runtime_root":"/tmp/runtime","board_name":"board-a"}',
    ]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.data).toEqual({
      board_dir: '/tmp/runtime/board-a',
      init_message: 'initialized-ok',
    });
  });

  it('fails when a command template placeholder is unresolved', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-template-missing-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');

    writeFile(flowPath, `
id: unresolved-template-flow
settings:
  start_step: s1
steps:
  s1:
    expects_data: [x]
    handler:
      cli: node ./does-not-matter.js "%%MISSING_KEY%%"
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

    const run = runStepMachineCli([flowPath, '--initial-data', '{"x":1}']);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('routes to failed_state when inline handler returns failure', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step-machine-cli-inline-failure-'));
    const flowPath = path.join(tmpRoot, 'flow.yaml');
    const handlersPath = path.join(tmpRoot, 'handlers.js');

    writeFile(flowPath, `
id: inline-failure-flow
settings:
  start_step: s1
steps:
  s1:
    handler:
      inline: always_fail
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

    writeFile(handlersPath, `
export default {
  async always_fail() {
    return { result: 'failure', data: { error: 'inline failure' } };
  },
};
`);

    const run = runStepMachineCli([flowPath, '--handlers', handlersPath]);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);

    const output = parseLastJsonObject(run.stdout ?? '');
    expect(output.intent).toBe('failure');
  });

  it('e2e: portfolio-tracker example runs to success', () => {
    const exampleDir = path.resolve(repoRoot, 'examples/cli/step-machine-cli/portfolio-tracker');
    const inputData = JSON.parse(
      fs.readFileSync(path.join(exampleDir, 'portfolio-tracker.input.json'), 'utf-8')
    );
    inputData.runtime_root = path.join(os.tmpdir(), 'yaml-flow-step-machine-portfolio-tracker-test');

    const result = spawnSync(
      process.execPath,
      [stepMachineCli, 'portfolio-tracker.flow.yaml', '--initial-data', JSON.stringify(inputData)],
      {
        cwd: exampleDir,
        encoding: 'utf-8',
        windowsHide: true,
        env: { ...process.env, BOARD_LIVE_CARDS_NO_SPAWN: '1' },
        timeout: 110_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const output = parseLastJsonObject(result.stdout ?? '');
    expect(output.intent).toBe('success');
    expect(output.finalStep).toBe('success_state');
    expect(output.data.t1_done).toBe(true);
    expect(output.data.t2_done).toBe(true);
    expect(output.data.t3_done).toBe(true);
  }, 120_000);
});
