import fs from 'node:fs';
import path from 'node:path';
import type {
  BoardContainerArchiveResult,
  BoardContainerProvisionOptions,
  BoardContainerStorage,
} from '../common/board-container-lifecycle.js';

type KindValueRef = { kind?: string; value?: string };

type FsBoardContainerRegistry = {
  boardsIndexRef?: KindValueRef;
  boardsLayoutRef?: KindValueRef;
  deprecatedContainerRef?: KindValueRef;
};

function requireFsDir(ref: KindValueRef | undefined, label: string) {
  if (ref?.kind !== 'fs-path' || typeof ref.value !== 'string' || !ref.value.trim()) {
    throw new Error(`${label} must be an fs-path ref`);
  }
  return path.normalize(ref.value);
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function formatArchiveStamp(date = new Date()) {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function tryReadJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function createFsBoardContainerStorage<TRecord, TLayout = unknown>(
  options: { registry?: FsBoardContainerRegistry }
): BoardContainerStorage<TRecord, TLayout> {
  const registry = options.registry ?? {};
  const boardsDir = requireFsDir(registry.boardsIndexRef, 'registry.boardsIndexRef');
  const layoutsDir = requireFsDir(registry.boardsLayoutRef, 'registry.boardsLayoutRef');
  const deprecatedDir = registry.deprecatedContainerRef?.kind === 'fs-path' && typeof registry.deprecatedContainerRef.value === 'string' && registry.deprecatedContainerRef.value.trim()
    ? path.normalize(registry.deprecatedContainerRef.value)
    : '';

  function recordPath(id: string) {
    return path.join(boardsDir, `${id}.json`);
  }

  function layoutPath(id: string) {
    return path.join(layoutsDir, `${id}.json`);
  }

  function reserveArchiveBase(id: string) {
    ensureDir(deprecatedDir);
    const stamp = formatArchiveStamp();
    let suffix = '';
    let attempt = 1;
    while (true) {
      const archiveBase = `${id}-${stamp}${suffix}`;
      const archiveRecordPath = path.join(deprecatedDir, `${archiveBase}.json`);
      const archiveLayoutPath = path.join(deprecatedDir, `${archiveBase}.layout.json`);
      const archiveWorkspaceDir = path.join(deprecatedDir, archiveBase);
      if (!fs.existsSync(archiveRecordPath) && !fs.existsSync(archiveLayoutPath) && !fs.existsSync(archiveWorkspaceDir)) {
        return { archiveBase, archiveRecordPath, archiveLayoutPath, archiveWorkspaceDir };
      }
      attempt += 1;
      suffix = `-${attempt}`;
    }
  }

  function tryMoveWorkspace(sourceWorkspaceDir: string, targetDir: string) {
    if (!sourceWorkspaceDir || !fs.existsSync(sourceWorkspaceDir)) return '';
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        fs.renameSync(sourceWorkspaceDir, targetDir);
        return targetDir;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY';
        if (!transient || attempt === maxAttempts) {
          return '';
        }
        const waitUntil = Date.now() + 100 * attempt;
        while (Date.now() < waitUntil) {
          // Brief synchronous backoff to let the OS release the handle.
        }
      }
    }
    return '';
  }

  async function list() {
    if (!fs.existsSync(boardsDir)) return [];
    const out: Array<{ id: string; record: TRecord }> = [];
    for (const name of fs.readdirSync(boardsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const record = JSON.parse(fs.readFileSync(path.join(boardsDir, name), 'utf8')) as TRecord;
      out.push({ id, record });
    }
    return out;
  }

  async function get(id: string) {
    return tryReadJsonFile<TRecord>(recordPath(id));
  }

  async function has(id: string) {
    return fs.existsSync(recordPath(id));
  }

  async function put(id: string, record: TRecord) {
    ensureDir(boardsDir);
    fs.writeFileSync(recordPath(id), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
  }

  async function set(id: string, record: TRecord) {
    ensureDir(boardsDir);
    fs.writeFileSync(recordPath(id), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'w' });
  }

  async function getLayout(id: string) {
    return tryReadJsonFile<TLayout>(layoutPath(id));
  }

  async function setLayout(id: string, layout: TLayout) {
    ensureDir(layoutsDir);
    fs.writeFileSync(layoutPath(id), JSON.stringify(layout, null, 2), { encoding: 'utf8', flag: 'w' });
  }

  async function removeLayout(id: string) {
    const filePath = layoutPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async function provision(id: string, record: TRecord, provisionOptions: BoardContainerProvisionOptions<TLayout> = {}) {
    await put(id, record);
    if (provisionOptions.layout == null) {
      await removeLayout(id);
      return;
    }
    await setLayout(id, provisionOptions.layout);
  }

  async function archive(id: string, options: { workspaceDir?: string } = {}): Promise<BoardContainerArchiveResult | null> {
    const sourceRecordPath = recordPath(id);
    const sourceLayoutPath = layoutPath(id);
    if (!fs.existsSync(sourceRecordPath)) {
      return null;
    }

    const workspaceDir = typeof options.workspaceDir === 'string' && options.workspaceDir.trim()
      ? path.normalize(options.workspaceDir)
      : '';

    if (!deprecatedDir) {
      fs.rmSync(sourceRecordPath, { force: true });
      if (fs.existsSync(sourceLayoutPath)) {
        fs.rmSync(sourceLayoutPath, { force: true });
      }
      if (workspaceDir && fs.existsSync(workspaceDir)) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          // Best-effort workspace removal.
        }
      }
      return {
        archiveId: '',
        archiveRecordPath: '',
        archiveWorkspaceDir: '',
        archiveLayoutPath: '',
      };
    }

    const { archiveBase, archiveRecordPath, archiveLayoutPath, archiveWorkspaceDir } = reserveArchiveBase(id);
    fs.renameSync(sourceRecordPath, archiveRecordPath);
    if (fs.existsSync(sourceLayoutPath)) {
      fs.renameSync(sourceLayoutPath, archiveLayoutPath);
    }
    const movedWorkspaceDir = tryMoveWorkspace(workspaceDir, archiveWorkspaceDir);

    return {
      archiveId: archiveBase,
      archiveRecordPath,
      archiveWorkspaceDir: movedWorkspaceDir,
      archiveLayoutPath: fs.existsSync(archiveLayoutPath) ? archiveLayoutPath : '',
    };
  }

  return {
    kind: 'fs-board-container',
    list,
    get,
    has,
    put,
    set,
    getLayout,
    setLayout,
    removeLayout,
    provision,
    archive,
  };
}