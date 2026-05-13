#!/usr/bin/env node

// @ts-nocheck
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCli = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'node', 'batch-runner-cli.ts');
const tsxCli = path.join(__dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (fs.existsSync(srcCli)) {
  const result = spawnSync(process.execPath, [tsxCli, srcCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[batch-runner-cli] Failed to launch dev fallback: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

const libIndexPath = path.join(__dirname, '..', '..', 'lib', 'index.js');
const stepPublicPath = path.join(__dirname, '..', '..', 'lib', 'step-machine-public', 'index.js');
const batchPath = path.join(__dirname, '..', '..', 'lib', 'batch', 'index.js');
const executionAdapterPath = path.join(__dirname, 'execution-adapter.js');

const { loadStepFlow, createStepMachine, MemoryStore } = await import(pathToFileUrl(libIndexPath).href);
const { buildStepHandlersForFlow } = await import(pathToFileUrl(stepPublicPath).href);
const { batch } = await import(pathToFileUrl(batchPath).href);
const { invokeRefSync } = await import(pathToFileUrl(executionAdapterPath).href);

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return new URL(`file:///${resolved.startsWith('/') ? resolved.slice(1) : resolved}`);
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseCliArgs(args);

  if (parsed.help || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { flowArg, itemsArg, concurrency } = parsed;

  if (!flowArg) {
    throw new Error('[batch-runner-cli] Flow path is required.');
  }
  if (!itemsArg) {
    throw new Error('[batch-runner-cli] --items <json-file-or-inline> is required.');
  }

  const flowPath = resolveInputPath(flowArg);
  const flowDir = path.dirname(flowPath);
  const items = parseItems(itemsArg);

  const flow = await loadStepFlow(flowPath);

  const result = await batch(items, {
    concurrency,
    processor: async (item, index) => {
      const invoke = (ref, args) => invokeRefSync(normalizeExecutionRef(ref), args, { cliDir: flowDir, cwd: flowDir });
      const handlers = buildStepHandlersForFlow(flow, { invoke });
      const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
      return machine.run(item);
    },
    onProgress: (progress) => {
      process.stderr.write(`\r[batch] ${progress.completed + progress.failed}/${progress.total} (${progress.percent}%) — ${progress.active} active`);
    },
  });

  // Clear progress line
  process.stderr.write('\r' + ' '.repeat(80) + '\r');

  console.log(JSON.stringify({
    completed: result.completed,
    failed: result.failed,
    total: result.total,
    durationMs: result.durationMs,
    items: result.items.map((r) => ({
      index: r.index,
      status: r.status,
      durationMs: r.durationMs,
      ...(r.status === 'completed'
        ? { intent: r.result?.intent, data: r.result?.data }
        : { error: r.error?.message }),
    })),
  }, null, 2));

  if (result.failed > 0) {
    process.exit(1);
  }
}

function parseCliArgs(args) {
  const values = {};
  const positionals = [];
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg === '--items') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('[batch-runner-cli] Missing value for --items.');
      }
      values['--items'] = value;
      i++;
      continue;
    }

    if (arg === '--concurrency') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('[batch-runner-cli] Missing value for --concurrency.');
      }
      values['--concurrency'] = value;
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`[batch-runner-cli] Unknown flag: ${arg}`);
    }

    positionals.push(arg);
  }

  return {
    help,
    flowArg: positionals[0],
    itemsArg: values['--items'],
    concurrency: values['--concurrency'] ? parseInt(values['--concurrency'], 10) : 5,
  };
}

function resolveInputPath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(process.cwd(), inputPath);
}

function parseItems(itemsArg) {
  // Try as file path first
  const filePath = resolveInputPath(itemsArg);
  let raw;
  if (fs.existsSync(filePath)) {
    raw = fs.readFileSync(filePath, 'utf-8');
  } else {
    // Treat as inline JSON
    raw = itemsArg;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[batch-runner-cli] Failed to parse items JSON: ${msg}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('[batch-runner-cli] Items must be a JSON array of objects.');
  }

  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i] || typeof parsed[i] !== 'object' || Array.isArray(parsed[i])) {
      throw new Error(`[batch-runner-cli] Item at index ${i} is not a JSON object.`);
    }
  }

  return parsed;
}

function normalizeExecutionRef(ref) {
  if (!ref || typeof ref !== 'object') return ref;
  if (typeof ref.whatToRun !== 'string' || !ref.whatToRun.startsWith('b64:')) return ref;

  try {
    const payload = ref.whatToRun.slice(4);
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const decoded = JSON.parse(json);
    if (!decoded || typeof decoded !== 'object' || typeof decoded.value !== 'string') {
      return ref;
    }
    return { ...ref, whatToRun: decoded };
  } catch {
    return ref;
  }
}

function printUsage() {
  console.error('Usage: batch-runner-cli <step-flow.yaml> --items <items.json> [--concurrency <n>]');
  console.error('');
  console.error('Run a step-machine flow for each item in a JSON array, with concurrency control.');
  console.error('');
  console.error('Options:');
  console.error('  --items <path|json>       JSON file or inline JSON array of input objects');
  console.error('  --concurrency <n>         Max concurrent flows (default: 5)');
  console.error('  -h, --help                Show this help');
  console.error('');
  console.error('Example:');
  console.error('  batch-runner-cli flow.yaml --items items.json --concurrency 3');
  console.error('  batch-runner-cli flow.yaml --items \'[{"a":1,"b":2},{"a":3,"b":4}]\'');
}

main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(msg);
  process.exit(1);
});
