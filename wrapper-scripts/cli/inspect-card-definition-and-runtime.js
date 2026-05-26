#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log_it, readKnownBaseRef, resolveKnownYamlFlowCliPath } from './shared_helpers.js';

const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');
const cardStoreCliPath = resolveKnownYamlFlowCliPath('card-store-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-card-definition-and-runtime.js --card-id <card-id>',
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

function runJsonScript(scriptPath, scriptArgs) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
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

function getAtPath(objectValue, ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return undefined;
  }

  let target = objectValue;
  let pathRef = ref;
  if (pathRef.startsWith('fetched_sources.')) {
    target = objectValue.fetched_sources;
    pathRef = pathRef.slice('fetched_sources.'.length);
  }

  for (const segment of pathRef.split('.')) {
    if (target == null) {
      return undefined;
    }
    target = target[segment];
  }

  return target;
}

function materializeView(card, runtimeNode) {
  const view = card?.view;
  const elements = Array.isArray(view?.elements) ? view.elements : [];

  return {
    layout: view?.layout,
    features: view?.features,
    elements: elements.map((element, index) => {
      const visible = typeof element?.visible === 'string'
        ? Boolean(getAtPath(runtimeNode, element.visible))
        : true;
      const bind = typeof element?.data?.bind === 'string' ? element.data.bind : undefined;
      const resolved = bind ? getAtPath(runtimeNode, bind) : undefined;
      const model = {
        id: element?.id || `element-${index}`,
        kind: element?.kind,
        label: element?.label,
        visible,
      };

      if (bind) {
        model.bind = bind;
      }
      if (Array.isArray(element?.data?.columns)) {
        model.columns = element.data.columns;
      }
      if (typeof element?.data?.maxRows === 'number') {
        model.maxRows = element.data.maxRows;
      }
      if (resolved !== undefined) {
        model.resolved = Array.isArray(resolved) && typeof model.maxRows === 'number'
          ? resolved.slice(0, model.maxRows)
          : resolved;
      }

      return model;
    }),
  };
}

function readBoardStatus(baseRef) {
  const result = runJsonScript(boardLiveCardsCliPath, ['status', '--base-ref', baseRef]);
  return unwrapSuccessfulEnvelope(result, 'status');
}

function readCardStoreRef(baseRef) {
  const result = runJsonScript(boardLiveCardsCliPath, ['get-card-store-ref', '--base-ref', baseRef]);
  const data = unwrapSuccessfulEnvelope(result, 'get-card-store-ref');
  const storeRef = data?.storeRef ?? data?.value;
  if (typeof storeRef !== 'string' || !storeRef.trim()) {
    throw new Error('board did not return a card store ref');
  }
  return storeRef.trim();
}

function readStoredCard(storeRef, cardId) {
  const result = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`card "${cardId}" not found in card store`);
  }
  return result[0];
}

function readComputedValues(baseRef, cardId) {
  const result = runJsonScript(boardLiveCardsCliPath, ['get-outputs', '--base-ref', baseRef, '--type', 'computed-values', '--key', cardId]);
  const data = unwrapSuccessfulEnvelope(result, 'get-outputs computed-values');
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function readFetchedSourceFileRefs(baseRef, cardId) {
  const result = runJsonScript(boardLiveCardsCliPath, ['get-outputs', '--base-ref', baseRef, '--type', 'fetched_sources', '--key', cardId]);
  const data = unwrapSuccessfulEnvelope(result, 'get-outputs fetched_sources');
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function readFetchedSourcesData(baseRef, fileRefs, card) {
  const sourceDefs = Array.isArray(card?.source_defs) ? card.source_defs : [];
  const outputFileToBindTo = {};
  for (const src of sourceDefs) {
    if (typeof src?.bindTo === 'string' && typeof src?.outputFile === 'string') {
      outputFileToBindTo[src.outputFile] = src.bindTo;
    }
  }

  const fetched = {};
  for (const [outputFile, ref] of Object.entries(fileRefs)) {
    const bindTo = outputFileToBindTo[outputFile] ?? outputFile;
    try {
      // Ref is a serialized KindValueRef — decode to get the file path
      let filePath;
      if (typeof ref === 'string' && ref.startsWith('b64:')) {
        const decoded = JSON.parse(Buffer.from(ref.slice(4), 'base64url').toString('utf8'));
        filePath = decoded?.value;
      }
      if (filePath && fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        fetched[bindTo] = content ? JSON.parse(content) : null;
      } else {
        fetched[bindTo] = null;
      }
    } catch {
      fetched[bindTo] = null;
    }
  }
  return fetched;
}

function readDataObject(baseRef, outputKey) {
  const result = runJsonScript(boardLiveCardsCliPath, ['get-outputs', '--base-ref', baseRef, '--type', 'data-object', '--key', outputKey]);
  return unwrapSuccessfulEnvelope(result, `get-outputs data-object ${outputKey}`);
}

function readOutputMap(baseRef, keys) {
  const outputMap = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !key) {
      continue;
    }
    outputMap[key] = readDataObject(baseRef, key);
  }
  return outputMap;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  log_it('inspect-card-definition-and-runtime.js', argv.join(' '));
  const { command, flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }
  if (command) {
    printUsage(1);
  }

  const baseRef = readKnownBaseRef();
  const cardId = requireArgText(flags, 'card-id');
  const statusPayload = readBoardStatus(baseRef);
  const cardStatusInBoard = Array.isArray(statusPayload?.cards)
    ? statusPayload.cards.find((card) => card?.name === cardId)
    : undefined;

  if (!cardStatusInBoard) {
    throw new Error(`card "${cardId}" not found in board status`);
  }

  const storeRef = readCardStoreRef(baseRef);
  const storedCard = readStoredCard(storeRef, cardId);
  const requires = readOutputMap(baseRef, Array.isArray(cardStatusInBoard.requires_satisfied) ? cardStatusInBoard.requires_satisfied : []);
  const provides = readOutputMap(baseRef, Array.isArray(cardStatusInBoard.provides_runtime) ? cardStatusInBoard.provides_runtime : []);
  const computedValues = readComputedValues(baseRef, cardId);
  const fetchedSourceFileRefs = readFetchedSourceFileRefs(baseRef, cardId);
  const fetchedSources = readFetchedSourcesData(baseRef, fetchedSourceFileRefs, storedCard);
  const runtimeNode = {
    card_data: storedCard?.card_data ?? {},
    requires,
    fetched_sources: fetchedSources,
    computed_values: computedValues,
  };

  printJson({
    cardId,
    card_status_in_board: cardStatusInBoard,
    card_definition_and_static_data: storedCard,
    refs_for_fetched_sources_files: fetchedSourceFileRefs,
    runtime_data: {
      requires,
      provides,
      computed_values: computedValues,
      view_model: materializeView(storedCard, runtimeNode),
    },
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}