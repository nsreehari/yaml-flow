#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { log_it, readKnownFinalResponseRootDir } from './shared_helpers.js';

const FINAL_RESPONSE_FILE_NAME = '001-response.txt';
const FILE_STAGE_PREFIX = '100-file-';

const usageLines = [
  'Usage:',
  '  cat payload.json | node provide-response-to-user.js --card-id <card-id>',
  '',
  'Payload shape:',
  '  { "text": "<final-assistant-reply>", "files": [] }',
];

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = value;
    index += 1;
  }

  return flags;
}

function requireArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    printUsage(1);
  }

  return flags[key].trim();
}

function resolveFinalResponseDir(flags) {
  const cardId = requireArgText(flags, 'card-id');
  const finalResponseRootDir = readKnownFinalResponseRootDir();
  const containerDir = path.join(finalResponseRootDir, cardId);
  fs.mkdirSync(containerDir, { recursive: true });
  return {
    containerDir,
    cardId,
  };
}

function readPayload() {
  if (process.stdin.isTTY) {
    printUsage(1);
  }

  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) {
    throw new Error('stdin payload is required');
  }

  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('stdin payload must be a JSON object');
  }

  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('payload.text must be a non-empty string');
  }

  if (payload.files !== undefined && !Array.isArray(payload.files)) {
    throw new Error('payload.files must be an array when provided');
  }

  return {
    text: payload.text,
    files: Array.isArray(payload.files) ? payload.files : [],
  };
}

function sanitizeFileSegment(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const baseName = path.basename(value.trim());
  return baseName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function pickStagedFileName(index, fileEntry) {
  const candidateKeys = ['name', 'fileName', 'filename', 'path', 'stored_name', 'key'];
  let candidateName = '';

  if (fileEntry && typeof fileEntry === 'object' && !Array.isArray(fileEntry)) {
    for (const key of candidateKeys) {
      candidateName = sanitizeFileSegment(fileEntry[key]);
      if (candidateName) {
        break;
      }
    }
  }

  const prefix = `${FILE_STAGE_PREFIX}${String(index + 1).padStart(3, '0')}`;
  return candidateName ? `${prefix}-${candidateName}` : `${prefix}.json`;
}

function readFileEntryContent(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
    return JSON.stringify(fileEntry, null, 2);
  }

  const contentKeys = ['content', 'text', 'body', 'data'];
  for (const key of contentKeys) {
    if (typeof fileEntry[key] === 'string') {
      return fileEntry[key];
    }
  }

  return JSON.stringify(fileEntry, null, 2);
}

function stageAdditionalFiles(containerDir, files) {
  return files.map((fileEntry, index) => {
    const fileName = pickStagedFileName(index, fileEntry);
    const filePath = path.join(containerDir, fileName);
    fs.writeFileSync(filePath, readFileEntryContent(fileEntry), 'utf8');
    return {
      fileName,
      filePath,
    };
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  log_it('provide-response-to-user.js', argv.join(' '));
  const flags = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }

  const payload = readPayload();
  const resolvedTarget = resolveFinalResponseDir(flags);
  const { containerDir, cardId } = resolvedTarget;
  const responseFilePath = path.join(containerDir, FINAL_RESPONSE_FILE_NAME);
  fs.writeFileSync(responseFilePath, payload.text, 'utf8');
  const stagedFiles = stageAdditionalFiles(containerDir, payload.files);

  printJson({
    status: 'success',
    data: {
      cardId,
      responseFilePath,
      stagedFiles,
    },
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}