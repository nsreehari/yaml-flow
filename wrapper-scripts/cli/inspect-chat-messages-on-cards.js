#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  log_it,
  readKnownBaseRef,
  resolveKnownYamlFlowCliPath,
} from './shared_helpers.js';

const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');
const chatStoreCliPath = resolveKnownYamlFlowCliPath('chat-store-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> get-messages',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> --last-user-turns <n> get-messages',
  '  node inspect-chat-messages-on-cards.js --card-id <card-id> --tail <n> get-messages',
];

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
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

  return {
    command: positional[0],
    flags,
  };
}

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function requireArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    printUsage(1);
  }

  return flags[key].trim();
}

function parseOptionalPositiveInteger(flags, key) {
  if (flags[key] === undefined) {
    return null;
  }

  const value = Number.parseInt(String(flags[key]), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return value;
}

function runJsonScript(scriptPath, scriptArgs, input) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    input,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout.trim());
}

function unwrapSuccessfulEnvelope(result, commandName) {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null;
  }

  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }

  throw new Error(`${commandName} returned an unexpected response shape`);
}

function readStoreRef(baseRef, getterCommand, commandName) {
  const result = runJsonScript(boardLiveCardsCliPath, [getterCommand, '--base-ref', baseRef]);
  const data = unwrapSuccessfulEnvelope(result, commandName);
  const storeRef = data?.storeRef ?? data?.value;
  if (typeof storeRef !== 'string' || !storeRef.trim()) {
    throw new Error(`${commandName} did not return a store ref`);
  }
  return storeRef.trim();
}

function readAttachmentRefs(baseRef, cardId) {
  const cardStoreRefResult = runJsonScript(boardLiveCardsCliPath, ['get-card-store-ref', '--base-ref', baseRef]);
  const cardStoreData = unwrapSuccessfulEnvelope(cardStoreRefResult, 'get-card-store-ref');
  const storeRef = cardStoreData?.storeRef ?? cardStoreData?.value;
  if (typeof storeRef !== 'string' || !storeRef.trim()) {
    return [];
  }

  let cardResult;
  try {
    cardResult = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
  } catch {
    return [];
  }

  const card = Array.isArray(cardResult) ? cardResult[0] : cardResult;
  const files = Array.isArray(card?.card_data?.files) ? card.card_data.files : [];
  return files
    .map((file, idx) => ({ idx, stored_name: file?.stored_name }))
    .filter((entry) => typeof entry.stored_name === 'string' && entry.stored_name.length > 0);
}

function readChatRecords(chatStoreRef, cardId, lastUserTurns = null) {
  const scriptArgs = ['read-all', '--store-ref', chatStoreRef, '--card-id', cardId];
  if (lastUserTurns !== null) {
    scriptArgs.push('--last-user-turns', String(lastUserTurns));
  }

  const result = runJsonScript(chatStoreCliPath, scriptArgs);
  const raw = Array.isArray(result) ? result : Array.isArray(result?.records) ? result.records : [];
  return raw.filter((record) => record && typeof record === 'object');
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseSystemMessageFileIndex(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*.*?#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) {
    return null;
  }

  const fileIndex = Number.parseInt(match[2], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return null;
  }

  return fileIndex;
}

function enhanceChatMessageWithAttachmentHint(message, cardId, attachments) {
  const enhanced = {
    ...message,
  };

  const role = typeof message?.role === 'string'
    ? message.role
    : typeof message?.payload?.role === 'string'
      ? message.payload.role
      : '';
  const messageText = typeof message?.text === 'string'
    ? message.text
    : typeof message?.payload?.text === 'string'
      ? message.payload.text
      : '';

  if (role === 'system') {
    const fileIndex = parseSystemMessageFileIndex(messageText);
    const hasAttachment = fileIndex !== null && attachments.some((attachment) => attachment.idx === fileIndex);
    if (hasAttachment) {
      const retrievalHint = `Retrieve using inspect-file-contents.js --card-id ${cardId} --file-idx ${fileIndex}`;
      enhanced.retrieval_hint = retrievalHint;
      if (message?.payload && typeof message?.role !== 'string') {
        enhanced.payload = {
          ...message.payload,
          retrieval_hint: retrievalHint,
        };
      }
    }
  }

  return enhanced;
}

function handleGetMessages(flags) {
  const baseRef = readKnownBaseRef();
  const cardId = requireArgText(flags, 'card-id');
  const lastUserTurns = parseOptionalPositiveInteger(flags, 'last-user-turns');
  const tail = parseOptionalPositiveInteger(flags, 'tail');
  const chatStoreRef = readStoreRef(baseRef, 'get-chat-store-ref', 'get-chat-store-ref');
  const attachments = readAttachmentRefs(baseRef, cardId);
  const messages = readChatRecords(chatStoreRef, cardId, lastUserTurns)
    .map((message) => enhanceChatMessageWithAttachmentHint(message, cardId, attachments));
  const visibleMessages = tail === null ? messages : messages.slice(-tail);

  printJson({
    cardId,
    messages: visibleMessages,
  });
}

function main() {
  const argv = process.argv.slice(2);
  log_it('inspect-chat-messages-on-cards.js', argv.join(' '));
  const { command, flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }

  switch (command) {
    case 'get-messages':
      handleGetMessages(flags);
      return;
    default:
      printUsage(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}