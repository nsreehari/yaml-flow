import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import {
  applyStateSnapshotCommitEnvelope,
  BOARD_GRAPH_KEY,
  BOARD_LAST_JOURNAL_PROCESSED_ID_KEY,
  SNAPSHOT_SCHEMA_VERSION_V1,
  type StateSnapshotCommitEnvelope,
  type StateSnapshotCommitResult,
  type StateSnapshotReadView,
} from './board-live-cards-state-snapshot-types.js';

export interface NodeStateSnapshotBoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

interface NodeStateSnapshotStoreOptions {
  boardFileName: string;
  writeJsonAtomic: (filePath: string, payload: unknown) => void;
  sidecarRootDirName?: string;
}

export interface NodeStateSnapshotStoreSync {
  readSnapshot(scopeDir: string): StateSnapshotReadView;
  commitSnapshot(scopeDir: string, envelope: StateSnapshotCommitEnvelope): StateSnapshotCommitResult;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function valueToVersion(values: Record<string, unknown>): string {
  const hash = createHash('sha256');
  hash.update(stableStringify(values));
  return hash.digest('hex');
}

function keyToSidecarPath(scopeDir: string, sidecarRootDirName: string, key: string): string {
  const normalized = key.split('/').filter(Boolean);
  return path.join(scopeDir, sidecarRootDirName, ...normalized) + '.json';
}

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function ensureBoardKeys(values: Record<string, unknown>): NodeStateSnapshotBoardEnvelope {
  const graph = values[BOARD_GRAPH_KEY] as LiveGraphSnapshot | undefined;
  const lastJournalProcessedId = values[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string | undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`Snapshot commit is missing required key: ${BOARD_GRAPH_KEY}`);
  }
  if (typeof lastJournalProcessedId !== 'string') {
    throw new Error(`Snapshot commit is missing required key: ${BOARD_LAST_JOURNAL_PROCESSED_ID_KEY}`);
  }
  return {
    graph,
    lastDrainedJournalId: lastJournalProcessedId,
  };
}

export function createNodeStateSnapshotStoreSync(options: NodeStateSnapshotStoreOptions): NodeStateSnapshotStoreSync {
  const sidecarRootDirName = options.sidecarRootDirName ?? '.state-snapshot';

  function readSnapshot(scopeDir: string): StateSnapshotReadView {
    const boardPath = path.join(scopeDir, options.boardFileName);
    if (!fs.existsSync(boardPath)) {
      return { version: null, values: {} };
    }

    const boardEnvelope = readJson(boardPath) as NodeStateSnapshotBoardEnvelope;
    const values: Record<string, unknown> = {
      [BOARD_GRAPH_KEY]: boardEnvelope.graph,
      [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: boardEnvelope.lastDrainedJournalId ?? '',
    };

    const sidecarRoot = path.join(scopeDir, sidecarRootDirName);
    if (fs.existsSync(sidecarRoot)) {
      const stack: string[] = [sidecarRoot];
      const files: string[] = [];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const abs = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(abs);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          files.push(abs);
        }
      }
      files.sort((a, b) => a.localeCompare(b));
      for (const abs of files) {
        const rel = path.relative(sidecarRoot, abs).replace(/\\/g, '/');
        const key = rel.replace(/\.json$/, '').replace(/\/+/g, '/');
        values[key] = readJson(abs);
      }
    }

    return {
      version: valueToVersion(values),
      values,
    };
  }

  function commitSnapshot(scopeDir: string, envelope: StateSnapshotCommitEnvelope): StateSnapshotCommitResult {
    if (envelope.schemaVersion !== SNAPSHOT_SCHEMA_VERSION_V1) {
      throw new Error(`Unsupported snapshot schema version: ${envelope.schemaVersion}`);
    }

    const current = readSnapshot(scopeDir);
    if (current.version !== envelope.expectedVersion) {
      return {
        ok: false,
        reason: 'version-mismatch',
        currentVersion: current.version,
      };
    }

    const nextValues = applyStateSnapshotCommitEnvelope(current.values, {
      deleteKeys: envelope.deleteKeys,
      shallowMerge: envelope.shallowMerge,
    });

    const boardEnvelope = ensureBoardKeys(nextValues);
    options.writeJsonAtomic(path.join(scopeDir, options.boardFileName), boardEnvelope);

    // Persist all non-board keys as namespaced sidecar JSON blobs.
    const boardKeys = new Set([BOARD_GRAPH_KEY, BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]);
    for (const key of envelope.deleteKeys) {
      if (boardKeys.has(key)) continue;
      const p = keyToSidecarPath(scopeDir, sidecarRootDirName, key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    for (const [key, value] of Object.entries(envelope.shallowMerge)) {
      if (boardKeys.has(key)) continue;
      const p = keyToSidecarPath(scopeDir, sidecarRootDirName, key);
      options.writeJsonAtomic(p, value);
    }

    return {
      ok: true,
      newVersion: valueToVersion(nextValues),
    };
  }

  return {
    readSnapshot,
    commitSnapshot,
  };
}
