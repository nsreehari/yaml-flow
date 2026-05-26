import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFilePath = path.join(__dirname, 'log.jsonl');
const knownConstantsPath = path.join(__dirname, 'known_constants.json');
const initialProcessCwd = process.cwd();
const expectedWorkspaceRoot = path.resolve(__dirname, '..', '..');

function normalizeDirPath(dirPath) {
  return path.resolve(dirPath).replace(/[\\/]+$/, '').toLowerCase();
}

export function getExpectedWorkspaceRoot() {
  return expectedWorkspaceRoot;
}

export function ensureWorkspaceRootCwd() {
  const currentCwd = process.cwd();
  if (normalizeDirPath(currentCwd) !== normalizeDirPath(expectedWorkspaceRoot)) {
    process.chdir(expectedWorkspaceRoot);
  }

  return {
    invokedFromCwd: currentCwd,
    workspaceRoot: expectedWorkspaceRoot,
    cwdChanged: normalizeDirPath(currentCwd) !== normalizeDirPath(expectedWorkspaceRoot),
  };
}

ensureWorkspaceRootCwd();

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
    //   invokedFromCwd: initialProcessCwd,
    //   cwd: process.cwd(),
      workspaceRoot: expectedWorkspaceRoot,
    };

    const outputPath = resolveLogOutputPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Invocation logging must never block the wrapper.
  }
}

export function loadKnownConstants() {
  let rawText;
  try {
    rawText = fs.readFileSync(knownConstantsPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Missing staged constants file at ${knownConstantsPath}. Recreate the Copilot workspace so board-server can copy scripts and emit known constants.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`known_constants.json is not valid JSON: ${knownConstantsPath}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`known_constants.json must contain a JSON object: ${knownConstantsPath}`);
  }

  return parsed;
}

export function readKnownBaseRef() {
  const knownConstants = loadKnownConstants();
  const baseRef = knownConstants.base_ref;
  if (typeof baseRef !== 'string' || !baseRef.trim()) {
    throw new Error(`known_constants.json must contain a non-empty string base_ref: ${knownConstantsPath}`);
  }

  return baseRef.trim();
}

export function readKnownScratchDir() {
  const knownConstants = loadKnownConstants();
  const scratchDir = knownConstants.scratch_dir;
  if (typeof scratchDir !== 'string' || !scratchDir.trim()) {
    throw new Error(`known_constants.json must contain a non-empty string scratch_dir: ${knownConstantsPath}`);
  }

  return scratchDir.trim();
}

export function readKnownFinalResponseRootDir() {
  const knownConstants = loadKnownConstants();
  const finalResponseRootDir = knownConstants.final_response_root_dir;
  if (typeof finalResponseRootDir !== 'string' || !finalResponseRootDir.trim()) {
    throw new Error(`known_constants.json must contain a non-empty string final_response_root_dir: ${knownConstantsPath}`);
  }

  return finalResponseRootDir.trim();
}

export function readKnownYamlFlowCliBundledDir() {
  const knownConstants = loadKnownConstants();
  const bundledDir = knownConstants.yaml_flow_cli_bundled_dir;
  if (typeof bundledDir !== 'string' || !bundledDir.trim()) {
    throw new Error(`known_constants.json must contain a non-empty string yaml_flow_cli_bundled_dir: ${knownConstantsPath}`);
  }

  return bundledDir.trim();
}

export function resolveKnownYamlFlowCliPath(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('resolveKnownYamlFlowCliPath requires a non-empty file name');
  }

  return path.join(readKnownYamlFlowCliBundledDir(), fileName.trim());
}

export function buildStoredFileIndex(storedCard) {
  const files = Array.isArray(storedCard?.card_data?.files) ? storedCard.card_data.files : [];
  return files.filter((fileEntry) => fileEntry && typeof fileEntry === 'object');
}

export function parseSystemMessageFileIndex(messageText) {
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

export function extractFileRef(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
    return null;
  }

  const candidateKeys = ['path', 'stored_name', 'key', 'file_ref', 'fileRef', 'ref'];
  for (const key of candidateKeys) {
    const value = fileEntry[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function serializeFsPathRef(filePath) {
  return `b64:${Buffer.from(JSON.stringify({ kind: 'fs-path', value: filePath }), 'utf8').toString('base64url')}`;
}

export function toPublicFileRef(fileEntry) {
  const candidate = extractFileRef(fileEntry);
  if (typeof candidate !== 'string' || !candidate) {
    return null;
  }

  if (path.isAbsolute(candidate)) {
    return serializeFsPathRef(candidate);
  }

  return candidate;
}

export function enhanceChatMessageWithFileRefs(message, storedFiles = []) {
  const enhanced = {
    ...message,
  };

  const files = Array.isArray(message?.files)
    ? message.files
    : Array.isArray(message?.payload?.files)
      ? message.payload.files
      : null;

  if (Array.isArray(files)) {
    const fileRefs = files
      .map((fileEntry) => toPublicFileRef(fileEntry))
      .filter((fileRef) => typeof fileRef === 'string' && fileRef.length > 0);

    enhanced.file_refs = fileRefs;
    if (message?.payload && !Array.isArray(message?.files)) {
      enhanced.payload = {
        ...message.payload,
        file_refs: fileRefs,
      };
    }
  }

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
    if (fileIndex !== null) {
      const fileEntry = storedFiles[fileIndex];
      const fileRef = fileEntry ? toPublicFileRef(fileEntry) : null;
      if (fileRef) {
        enhanced.file_ref = fileRef;
        if (message?.payload && typeof message?.role !== 'string') {
          enhanced.payload = {
            ...message.payload,
            file_ref: fileRef,
          };
        }
      }
    }
  }

  return enhanced;
}