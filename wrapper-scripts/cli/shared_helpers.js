import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFilePath = path.join(__dirname, 'log.jsonl');
const knownConstantsPath = path.join(__dirname, 'known_constants.json');

function toLogText(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function resolveLogOutputPath() {
  const watchPartyFile = typeof process.env.CHAT_CARD_WATCH_PARTY_FILE === 'string'
    ? process.env.CHAT_CARD_WATCH_PARTY_FILE.trim()
    : '';

  return watchPartyFile || logFilePath;
}

export function log_it(cmd, message = '') {
  try {
    const entry = {
      ts: new Date().toISOString(),
      cmd: toLogText(cmd),
      msg: toLogText(message),
    };

    const outputPath = resolveLogOutputPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Invocation logging must never block the wrapper.
  }
}

function loadKnownConstants() {
  let rawText;
  try {
    rawText = fs.readFileSync(knownConstantsPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Workspace configuration is missing (expected ${knownConstantsPath}). Please recreate the workspace.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Workspace configuration is corrupted (invalid JSON at ${knownConstantsPath}).`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Workspace configuration is corrupted (expected a JSON object at ${knownConstantsPath}).`);
  }

  return parsed;
}

export function readKnownBaseRef() {
  const knownConstants = loadKnownConstants();
  const baseRef = knownConstants.base_ref;
  if (typeof baseRef !== 'string' || !baseRef.trim()) {
    throw new Error('Workspace configuration is incomplete (missing board reference).');
  }

  return baseRef.trim();
}

export function readKnownFinalResponseRootDir() {
  const knownConstants = loadKnownConstants();
  const finalResponseRootDir = knownConstants.final_response_root_dir;
  if (typeof finalResponseRootDir !== 'string' || !finalResponseRootDir.trim()) {
    throw new Error('Workspace configuration is incomplete (missing response directory).');
  }

  return finalResponseRootDir.trim();
}

function readKnownYamlFlowCliBundledDir() {
  const knownConstants = loadKnownConstants();
  const bundledDir = knownConstants.yaml_flow_cli_bundled_dir;
  if (typeof bundledDir !== 'string' || !bundledDir.trim()) {
    throw new Error('Workspace configuration is incomplete (missing CLI path).');
  }

  return bundledDir.trim();
}

export function resolveKnownYamlFlowCliPath(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('resolveKnownYamlFlowCliPath requires a non-empty file name');
  }

  return path.join(readKnownYamlFlowCliBundledDir(), fileName.trim());
}