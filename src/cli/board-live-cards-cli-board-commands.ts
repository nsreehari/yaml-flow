import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { GraphEvent } from '../event-graph/types.js';
import type { BoardConfigStore, CardStore } from './board-live-cards-all-stores.js';
import type { CommandResponse } from './board-live-cards-lib-types.js';
import { Resp } from './board-live-cards-lib-types.js';

interface ValidateResultLike {
  errors: string[];
}

interface BoardCommandDeps {
  initBoard: (dir: string) => 'created' | 'exists';
  configureRuntimeOutDir: (dir: string, runtimeOut?: string) => string;
  loadBoard: (dir: string) => LiveGraph;
  writeJsonAtomic: (filePath: string, data: unknown) => void;
  resolveStatusSnapshotPath: (dir: string) => string;
  buildBoardStatusObject: (dir: string, live: LiveGraph) => any;
  getConfigStore: (boardDir: string) => BoardConfigStore;
  getCardStore: (boardDir: string) => CardStore;
  makeTempFilePath: (boardDir: string, label: string, ext?: string) => string;
  validateLiveCardDefinition: (card: Record<string, unknown>) => ValidateResultLike;
  execCommandSync: (command: string, args: string[], options?: Record<string, unknown>) => string;
  readStdin: () => string;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface BoardCommandHandlers {
  cmdInit: (args: string[]) => void;
  cmdStatus: (args: string[]) => void;
  cmdValidateCard: (args: string[]) => void;
  /** Direct validate — used by compat layer to avoid stdin coupling. */
  validateCards: (cards: Record<string, unknown>[], boardDir: string | undefined) => CommandResponse<{ cardId: string; errors: string[] }>[];
  cmdRemoveCard: (args: string[]) => void;
  cmdRetrigger: (args: string[]) => void;
}

export function createBoardCommandHandlers(deps: BoardCommandDeps): BoardCommandHandlers {
  function cmdInit(args: string[]): void {
    const dir = args[0];
    if (!dir) {
      throw new Error('Usage: board-live-cards init <dir> [--task-executor <script>] [--chat-handler <script>] [--inference-adapter <script>] [--runtime-out <dir>]');
    }

    const teIdx = args.indexOf('--task-executor');
    const taskExecutor = teIdx !== -1 ? args[teIdx + 1] : undefined;
    const chIdx = args.indexOf('--chat-handler');
    const chatHandler = chIdx !== -1 ? args[chIdx + 1] : undefined;
    const iaIdx = args.indexOf('--inference-adapter');
    const inferenceAdapter = iaIdx !== -1 ? args[iaIdx + 1] : undefined;
    const roIdx = args.indexOf('--runtime-out');
    const runtimeOut = roIdx !== -1 ? args[roIdx + 1] : undefined;
    if (roIdx !== -1 && !runtimeOut) {
      throw new Error('Usage: board-live-cards init <dir> [--task-executor <script>] [--chat-handler <script>] [--inference-adapter <script>] [--runtime-out <dir>]');
    }

    const result = deps.initBoard(dir);

    const config = deps.getConfigStore(dir);
    if (taskExecutor) {
      const teExtraIdx = args.indexOf('--task-executor-extra');
      let teExtra: Record<string, unknown> | undefined;
      if (teExtraIdx !== -1 && args[teExtraIdx + 1]) {
        try { teExtra = JSON.parse(args[teExtraIdx + 1]); } catch { /* ignore bad JSON */ }
      }
      config.writeTaskExecutorConfig({ command: taskExecutor, ...(teExtra ? { extra: teExtra } : {}) });
    }
    if (chatHandler) {
      config.writeChatHandler(chatHandler);
    }
    if (inferenceAdapter) {
      config.writeInferenceAdapter(inferenceAdapter);
    }

    const runtimeOutDir = deps.configureRuntimeOutDir(dir, runtimeOut);
    const live = deps.loadBoard(dir);
    deps.writeJsonAtomic(deps.resolveStatusSnapshotPath(dir), deps.buildBoardStatusObject(dir, live));

    if (result === 'exists') {
      console.log(`Board already initialized at ${path.resolve(dir)}${taskExecutor ? ` (task-executor updated: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
    } else {
      console.log(`Board initialized at ${path.resolve(dir)}${taskExecutor ? ` (task-executor: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
    }
  }

  function cmdStatus(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const asJson = args.includes('--json');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    if (!dir) {
      console.error('Usage: board-live-cards status --rg <dir>');
      process.exit(1);
    }

    const statusOutPath = deps.resolveStatusSnapshotPath(dir);
    let statusObject: any;
    if (fs.existsSync(statusOutPath)) {
      statusObject = JSON.parse(fs.readFileSync(statusOutPath, 'utf-8'));
    } else {
      statusObject = deps.buildBoardStatusObject(dir, deps.loadBoard(dir));
      deps.writeJsonAtomic(statusOutPath, statusObject);
    }

    if (asJson) {
      console.log(JSON.stringify(statusObject, null, 2));
      return;
    }

    console.log(`Board: ${statusObject.meta.board.path}`);
    console.log(`Tasks: ${statusObject.summary.card_count}`);
    console.log('');

    for (const card of statusObject.cards) {
      const dataKeys = card.provides_runtime.join(', ');
      console.log(`  ${card.status.padEnd(12)} ${card.name}${dataKeys ? ` — [${dataKeys}]` : ''}`);
    }

    console.log('');
    console.log(`Schedule: ${statusObject.summary.eligible} eligible, ${statusObject.summary.pending} pending, ${statusObject.summary.blocked} blocked, ${statusObject.summary.unresolved} unresolved`);
  }

  function validateCardObjects(
    cards: Record<string, unknown>[],
    boardDir: string | undefined,
  ): CommandResponse<{ cardId: string; errors: string[] }>[] {
    const teConfig = boardDir ? deps.getConfigStore(boardDir).readTaskExecutorConfig() : undefined;

    return cards.map((card) => {
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const schemaErrors = deps.validateLiveCardDefinition(card).errors;
      const sourceErrors: string[] = [];

      if (teConfig && Array.isArray(card.source_defs)) {
        for (const src of card.source_defs as Array<Record<string, unknown>>) {
          const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
          const tmpFile = deps.makeTempFilePath(boardDir!, `validate-src-${bindTo}`);
          try {
            fs.writeFileSync(tmpFile, JSON.stringify(src), 'utf-8');
            let stdout: string;
            try {
              stdout = deps.execCommandSync(
                teConfig.command,
                [...(teConfig.args ?? []), 'validate-source-def', '--in', tmpFile],
                { timeout: 10_000 },
              );
            } catch (execErr: any) {
              stdout = typeof execErr?.stdout === 'string' ? execErr.stdout
                : Buffer.isBuffer(execErr?.stdout) ? execErr.stdout.toString('utf-8')
                : '';
              if (!stdout.trim()) {
                sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${execErr instanceof Error ? execErr.message : String(execErr)}`);
                continue;
              }
            }
            const parsed = JSON.parse(stdout.trim());
            if (!parsed.ok && Array.isArray(parsed.errors)) {
              for (const error of parsed.errors) {
                sourceErrors.push(`source "${bindTo}": ${error}`);
              }
            }
          } catch (err) {
            sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }
      }

      const allErrors = [...schemaErrors, ...sourceErrors];
      if (allErrors.length === 0) {
        return Resp.success({ cardId, errors: [] as string[] });
      }
      return Resp.error(allErrors.join('; '), { cardId, errors: allErrors }) as CommandResponse<{ cardId: string; errors: string[] }>;
    });
  }

  function cmdValidateCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdIdx = args.indexOf('--card-id');
    const stdioMode = args.includes('--cards-stdio');
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;

    if (stdioMode) {
      // --cards-stdio: read JSON array of card objects from stdin, write results to stdout
      let cards: Record<string, unknown>[];
      try {
        const raw = deps.readStdin();
        cards = JSON.parse(raw) as Record<string, unknown>[];
        if (!Array.isArray(cards)) throw new Error('stdin must be a JSON array');
      } catch (err) {
        const resp = Resp.error(`Failed to parse stdin: ${err instanceof Error ? err.message : String(err)}`);
        console.log(JSON.stringify([resp]));
        return;
      }
      const results = validateCardObjects(cards, boardDir);
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (cardIdIdx !== -1) {
      // --card-id: read from CardStore
      const cardId = args[cardIdIdx + 1];
      if (!cardId || !boardDir) {
        throw new Error('Usage: board-live-cards validate-card --rg <boardDir> --card-id <id>');
      }
      const card = deps.getCardStore(boardDir).readCard(cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found in board at ${boardDir}`);
      }
      const [result] = validateCardObjects([card as Record<string, unknown>], boardDir);
      if (result.status === 'error') {
        for (const err of result.data.errors) console.error(`  ${err}`);
        throw new Error(`Card "${cardId}" failed validation.`);
      }
      console.log(`OK    ${cardId}`);
      return;
    }

    throw new Error('Usage: board-live-cards validate-card (--card-id <id> --rg <boardDir>) | (--cards-stdio [--rg <boardDir>])');
  }

  function cmdRemoveCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const idIdx = args.indexOf('--id');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const cardId = idIdx !== -1 ? args[idIdx + 1] : undefined;
    if (!dir || !cardId) {
      console.error('Usage: board-live-cards remove-card --rg <dir> --id <card-id>');
      process.exit(1);
    }

    deps.appendEventToJournal(dir, {
      type: 'task-removal',
      taskName: cardId,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsInfinitePass(dir);
    console.log(`Card "${cardId}" removed.`);
  }

  function cmdRetrigger(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const taskIdx = args.indexOf('--task');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const taskName = taskIdx !== -1 ? args[taskIdx + 1] : undefined;
    if (!dir || !taskName) {
      console.error('Usage: board-live-cards retrigger --rg <dir> --task <task-name>');
      process.exit(1);
    }

    deps.appendEventToJournal(dir, {
      type: 'task-restart',
      taskName,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsInfinitePass(dir);
    console.log(`Task "${taskName}" retriggered.`);
  }

  return {
    cmdInit,
    cmdStatus,
    cmdValidateCard,
    validateCards: validateCardObjects,
    cmdRemoveCard,
    cmdRetrigger,
  };
}
