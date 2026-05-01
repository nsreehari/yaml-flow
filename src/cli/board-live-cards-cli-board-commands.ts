import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { GraphEvent } from '../event-graph/types.js';
import type { BoardConfigStore } from './board-live-cards-all-stores.js';
import type { OutputStore } from './board-live-cards-lib-types.js';

interface BoardCommandDeps {
  initBoard: (dir: string) => 'created' | 'exists';
  configureRuntimeOutDir: (dir: string, runtimeOut?: string) => string;
  loadBoard: (dir: string) => LiveGraph;
  outputStore: OutputStore;
  buildBoardStatusObject: (dir: string, live: LiveGraph) => any;
  getConfigStore: (boardDir: string) => BoardConfigStore;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface BoardCommandHandlers {
  cmdInit: (args: string[]) => void;
  cmdStatus: (args: string[]) => void;
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
    deps.outputStore.writeStatusSnapshot(dir, deps.buildBoardStatusObject(dir, live));

    if (result === 'exists') {
      console.log(`Board already initialized at ${dir}${taskExecutor ? ` (task-executor updated: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
    } else {
      console.log(`Board initialized at ${dir}${taskExecutor ? ` (task-executor: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
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

    let statusObject: any = deps.outputStore.readStatusSnapshot(dir);
    if (!statusObject) {
      statusObject = deps.buildBoardStatusObject(dir, deps.loadBoard(dir));
      deps.outputStore.writeStatusSnapshot(dir, statusObject);
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
    cmdRemoveCard,
    cmdRetrigger,
  };
}
