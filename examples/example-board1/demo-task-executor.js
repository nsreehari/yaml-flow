#!/usr/bin/env node

/**
 * demo-task-executor.js — Simple mock source executor for example-board.
 *
 * Protocol (invoked by board-live-cards-cli):
 *   node demo-task-executor.js run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
 *
 * Expected source definition:
 *   { "bindTo": "...", "outputFile": "...", "mock": "keyName" }
 *
 * Behavior:
 *   1. Read mock.db (JSON file next to this script)
 *   2. Look up source.mock value as a key in mock.db
 *   3. Write corresponding value to --out file (as JSON)
 *   4. Exit 0 on success, exit 1 on error
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DB_PATH = path.join(__dirname, 'mock.db');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function interpolatePrompt(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);

  // Remove trailing blank lines first.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  // Remove the standard trailing Copilot metadata footer, if present.
  if (
    lines.length >= 3 &&
    /^Changes\b/i.test(lines[lines.length - 3]) &&
    /^Requests\b/i.test(lines[lines.length - 2]) &&
    /^Tokens\b/i.test(lines[lines.length - 1])
  ) {
    lines.splice(lines.length - 3, 3);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function resolveCopilotPrompt(sourceDef) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};
  
  // Merge explicit args with context from card-handler (_requires includes card-level computed values)
  const interpolationContext = { ...sourceDef._requires, ...args };
  
  if (!template || typeof template !== 'string') return null;
  return interpolatePrompt(template, interpolationContext);
}

function resolveCopilotExecutable() {
  const envBin = process.env.COPILOT_BIN;
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const candidates = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const preferred = candidates.find((p) => /\.(cmd|exe|bat)$/i.test(p));
      if (preferred) return preferred;
      if (candidates[0]) return candidates[0];
    } catch {}
  } else {
    try {
      const out = execFileSync('which', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    } catch {}
  }

  return 'copilot';
}

function runCopilotPrompt(prompt) {
  const copilotBin = resolveCopilotExecutable();
  const copilotArgs = ['--allow-all'];

  try {
    // Prefer stdin prompt delivery to avoid shell/path quoting issues.
    return execFileSync(copilotBin, copilotArgs, {
      input: String(prompt),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (directErr) {
    // Fallback for Git Bash / Windows wrapper path quoting issues.
    if (process.platform === 'win32') {
      const isCmdShim = /\.(bat|cmd)$/i.test(copilotBin);

      if (isCmdShim) {
        try {
          return execFileSync(copilotBin, copilotArgs, {
            input: String(prompt),
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
            shell: true,
          });
        } catch {}
      }

      try {
        // Final fallback: resolve through cmd PATH lookup, still piping prompt on stdin.
        return execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
          input: String(prompt),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (cmdErr) {
        const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
          ? String(directErr.stderr || '')
          : '';
        const stderrCmd = cmdErr && typeof cmdErr === 'object' && 'stderr' in cmdErr
          ? String(cmdErr.stderr || '')
          : '';
        const msg = [stderrDirect.trim(), stderrCmd.trim(), String(cmdErr && cmdErr.message || cmdErr)]
          .filter(Boolean)
          .join(' | ');
        throw new Error(msg || 'copilot invocation failed');
      }
    }

    const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
      ? String(directErr.stderr || '')
      : '';
    const msg = [stderrDirect.trim(), String(directErr && directErr.message || directErr)]
      .filter(Boolean)
      .join(' | ');
    throw new Error(msg || 'copilot invocation failed');
  }
}

function fail(msg, errFile) {
  if (errFile) {
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`[demo-task-executor] ${msg}`);
  process.exit(1);
}

function runSourceFetchSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const outIdx = argv.indexOf('--out');
  const errIdx = argv.indexOf('--err');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? argv[errIdx + 1] : undefined;

  if (!inFile || !outFile) {
    fail('Usage: run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]', errFile);
  }

  if (!fs.existsSync(inFile)) {
    fail(`Input file not found: ${inFile}`, errFile);
  }

  let sourceDef;
  try {
    sourceDef = readJson(inFile);
  } catch (err) {
    fail(`Cannot parse source file: ${String(err && err.message || err)}`, errFile);
  }

  let resultValue;

  if (sourceDef.copilot || sourceDef.prompt_template) {
    const prompt = resolveCopilotPrompt(sourceDef);
    if (!prompt) {
      fail('Source definition missing copilot.prompt_template (or prompt_template)', errFile);
    }

    let rawOutput = '';
    try {
      rawOutput = runCopilotPrompt(prompt);
    } catch (err) {
      const msg = String(err && err.message || err);
      fail(`copilot invocation failed: ${msg}`, errFile);
    }

    resultValue = stripCopilotFooter(rawOutput);
  } else {
    // Default mode: mockdb lookup
    let mockDb;
    try {
      if (!fs.existsSync(MOCK_DB_PATH)) {
        fail(`mock.db not found at ${MOCK_DB_PATH}`, errFile);
      }
      mockDb = readJson(MOCK_DB_PATH);
    } catch (err) {
      fail(`Cannot parse mock.db: ${String(err && err.message || err)}`, errFile);
    }

    const mockKey = sourceDef.mock;
    if (!mockKey) {
      fail('Source definition missing "mock" field (key to lookup)', errFile);
    }

    resultValue = mockDb[mockKey];
    if (resultValue === undefined) {
      fail(`Key "${mockKey}" not found in mock.db`, errFile);
    }
  }

  // Write result to --out as JSON payload, same contract as current mock mode.
  try {
    fs.writeFileSync(outFile, JSON.stringify(resultValue, null, 2));
  } catch (err) {
    fail(`Cannot write output file: ${String(err && err.message || err)}`, errFile);
  }

  process.exit(0);
}

function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main();
