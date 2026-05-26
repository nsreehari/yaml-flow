#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveKnownYamlFlowCliPath } from './shared_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

export function isHelpRequested(args) {
  return Boolean(args.help || args.h);
}

export function printUsage(lines, exitCode = 0) {
  const text = `${lines.join('\n')}\n`;
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(text);
  process.exit(exitCode);
}

export function requireArgText(args, key, usageLines) {
  if (typeof args[key] !== 'string' || !args[key].trim()) {
    printUsage(usageLines, 1);
  }
  return args[key].trim();
}

function readStdinJson() {
  if (process.stdin.isTTY) {
    return null;
  }
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : null;
}

export function readCandidateCardPayload(usageLines, requiredMockFields = []) {
  const stdinPayload = readStdinJson();
  if (!stdinPayload) {
    printUsage(usageLines, 1);
  }

  if (typeof stdinPayload !== 'object' || Array.isArray(stdinPayload)) {
    throw new Error('stdin payload must be a JSON object');
  }

  if (!Object.prototype.hasOwnProperty.call(stdinPayload, 'candidate_card_content')) {
    throw new Error('payload must include candidate_card_content');
  }

  if (stdinPayload.candidate_card_content == null || typeof stdinPayload.candidate_card_content !== 'object' || Array.isArray(stdinPayload.candidate_card_content)) {
    throw new Error('payload candidate_card_content must be a JSON object');
  }

  for (const field of requiredMockFields) {
    if (!Object.prototype.hasOwnProperty.call(stdinPayload, field)) {
      throw new Error(`payload must include ${field}`);
    }
    if (stdinPayload[field] == null || typeof stdinPayload[field] !== 'object' || Array.isArray(stdinPayload[field])) {
      throw new Error(`payload ${field} must be a JSON object`);
    }
  }

  const payload = { ...stdinPayload };
  payload['card-content'] = payload.candidate_card_content;
  delete payload.candidate_card_content;

  if (Object.prototype.hasOwnProperty.call(payload, 'mock_requires')) {
    payload['mock-requires'] = payload.mock_requires;
    delete payload.mock_requires;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'mock_fetched_sources')) {
    payload['mock-fetched-sources'] = payload.mock_fetched_sources;
    delete payload.mock_fetched_sources;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'mock_projections')) {
    payload['mock-projections'] = payload.mock_projections;
    delete payload.mock_projections;
  }

  return payload;
}

function runNodeScript(scriptPath, scriptArgs, payload) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }

  const out = result.stdout.trim();
  return out ? JSON.parse(out) : null;
}

export function runBoardLiveCardsCli(subcommand, args, payload) {
  const result = runNodeScript(boardLiveCardsCliPath, [subcommand, ...args], payload);
  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${subcommand} failed`);
  }
  return result;
}

export function runSiblingScript(scriptName, args, payload) {
  return runNodeScript(path.join(__dirname, scriptName), args, payload);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
