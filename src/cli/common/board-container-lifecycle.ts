export type BoardContainerArchiveResult = {
  archiveId: string;
  archiveRecordPath: string;
  archiveWorkspaceDir: string;
  [key: string]: unknown;
};

export type BoardContainerProvisionOptions<TLayout> = {
  layout?: TLayout | null;
};

export interface BoardContainerStorage<TRecord, TLayout = unknown> {
  kind?: string;
  list(): Promise<Array<{ id: string; record: TRecord }>>;
  get(id: string): Promise<TRecord | null>;
  has(id: string): Promise<boolean>;
  put(id: string, record: TRecord): Promise<void>;
  set(id: string, record: TRecord): Promise<void>;
  getLayout?(id: string): Promise<TLayout | null>;
  setLayout?(id: string, layout: TLayout): Promise<void>;
  removeLayout?(id: string): Promise<void>;
  provision?(id: string, record: TRecord, options?: BoardContainerProvisionOptions<TLayout>): Promise<void>;
  archive?(id: string, options?: { workspaceDir?: string }): Promise<BoardContainerArchiveResult | null>;
  deprecate?(id: string, options?: { workspaceDir?: string }): Promise<BoardContainerArchiveResult | null>;
}

export type CreateBoardContainerLifecycleOptions<TRecord, THydrated, TLayout = unknown> = {
  storage: BoardContainerStorage<TRecord, TLayout>;
  hydrate: (boardId: string, record: TRecord) => THydrated;
  resolveWorkspaceDir?: (board: THydrated, record: TRecord) => string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const metadata = asRecord(record?.metadata);
  return metadata ?? {};
}

function mergeMetadata(currentRecord: unknown, patchRecord: unknown) {
  const currentMetadata = getMetadataRecord(currentRecord);
  const patchMetadata = asRecord(asRecord(patchRecord)?.metadata);
  return patchMetadata ? { ...currentMetadata, ...patchMetadata } : currentMetadata;
}

export function createBoardContainerLifecycle<TRecord, THydrated, TLayout = unknown>(
  options: CreateBoardContainerLifecycleOptions<TRecord, THydrated, TLayout>
) {
  const storage = options.storage;
  const hydrate = options.hydrate;
  const resolveWorkspaceDir = typeof options.resolveWorkspaceDir === 'function'
    ? options.resolveWorkspaceDir
    : () => '';

  async function list() {
    const entries = await storage.list();
    return entries.map(({ id, record }) => hydrate(id, record));
  }

  async function get(boardId: string) {
    const record = await storage.get(boardId);
    return record ? hydrate(boardId, record) : null;
  }

  async function has(boardId: string) {
    return storage.has(boardId);
  }

  async function provision(boardId: string, record: TRecord, provisionOptions: BoardContainerProvisionOptions<TLayout> = {}) {
    if (await storage.has(boardId)) {
      const err = new Error(`board '${boardId}' already exists`) as Error & { code?: string };
      err.code = 'EEXIST';
      throw err;
    }

    const board = hydrate(boardId, record);
    if (typeof storage.provision === 'function') {
      await storage.provision(boardId, record, provisionOptions);
    } else {
      await storage.put(boardId, record);
      if (provisionOptions.layout == null) {
        if (typeof storage.removeLayout === 'function') {
          await storage.removeLayout(boardId);
        }
      } else if (typeof storage.setLayout === 'function') {
        await storage.setLayout(boardId, provisionOptions.layout);
      }
    }

    return board;
  }

  async function add(boardId: string, record: TRecord) {
    return provision(boardId, record);
  }

  async function saveMeta(boardId: string, metadata: Record<string, unknown>) {
    const record = await storage.get(boardId);
    if (!record) return null;
    const recordObject = asRecord(record);
    const nextRecord = {
      ...(recordObject ?? {}),
      metadata: {
        ...getMetadataRecord(record),
        ...(asRecord(metadata) ?? {}),
      },
    } as TRecord;
    const board = hydrate(boardId, nextRecord);
    await storage.set(boardId, nextRecord);
    return board;
  }

  async function saveRecord(boardId: string, patch: TRecord) {
    const record = await storage.get(boardId);
    if (!record) return null;
    const recordObject = asRecord(record);
    const patchObject = asRecord(patch);
    const nextRecord = {
      ...(recordObject ?? {}),
      ...(patchObject ?? {}),
      metadata: mergeMetadata(record, patch),
    } as TRecord;
    const board = hydrate(boardId, nextRecord);
    await storage.set(boardId, nextRecord);
    return board;
  }

  async function getLayout(boardId: string) {
    if (typeof storage.getLayout !== 'function') {
      return null;
    }
    return storage.getLayout(boardId);
  }

  async function saveLayout(boardId: string, layout: TLayout) {
    if (typeof storage.setLayout !== 'function') {
      throw new Error(`board-container storage kind '${storage.kind ?? ''}' does not support layout writes`);
    }
    await storage.setLayout(boardId, layout);
    return layout;
  }

  async function removeLayout(boardId: string) {
    if (typeof storage.removeLayout !== 'function') {
      return;
    }
    await storage.removeLayout(boardId);
  }

  async function deprecate(boardId: string) {
    const record = await storage.get(boardId);
    if (!record) return null;

    const archive = typeof storage.archive === 'function'
      ? storage.archive.bind(storage)
      : (typeof storage.deprecate === 'function' ? storage.deprecate.bind(storage) : null);
    if (!archive) {
      throw new Error(`board-container storage kind '${storage.kind ?? ''}' does not support archive`);
    }

    const board = hydrate(boardId, record);
    const workspaceDir = resolveWorkspaceDir(board, record);
    const archived = await archive(boardId, { workspaceDir });
    return archived ? { board, ...archived } : null;
  }

  return {
    kind: storage.kind ?? 'board-container',
    storage,
    list,
    get,
    has,
    provision,
    add,
    saveMeta,
    saveRecord,
    getLayout,
    saveLayout,
    removeLayout,
    deprecate,
  };
}