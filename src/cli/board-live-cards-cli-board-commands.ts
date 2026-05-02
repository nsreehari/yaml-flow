import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { GraphEvent } from '../event-graph/types.js';
import type { BoardConfigStore, PublishedOutputsStore } from './board-live-cards-all-stores.js';
import { parseRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';
import { executionRefFromScriptPath } from './execution-interface.js';

interface BoardCommandDeps {
  initBoard: (baseRef: KindValueRef) => 'created' | 'exists';
  configureRuntimeOutDir: (dir: string, runtimeOut?: string) => string;
  loadBoard: (dir: string) => LiveGraph;
  getOutputStore: (boardDir: string) => PublishedOutputsStore;
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
    const brIdx = args.indexOf('--base-ref');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const baseRef = baseRefRaw ? parseRef(baseRefRaw) : undefined;
    const dir = baseRef?.value;
    if (!dir) {
      console.error('Usage: board-live-cards init --base-ref <::kind::value> [--task-executor <script>] [--chat-handler <script>] [--runtime-out <dir>]');
      process.exit(1);
    }

    const teIdx = args.indexOf('--task-executor');
    const taskExecutor = teIdx !== -1 ? args[teIdx + 1] : undefined;
    const chIdx = args.indexOf('--chat-handler');
    const chatHandler = chIdx !== -1 ? args[chIdx + 1] : undefined;
    const roIdx = args.indexOf('--runtime-out');
    const runtimeOut = roIdx !== -1 ? args[roIdx + 1] : undefined;
    if (roIdx !== -1 && !runtimeOut) {
      console.error('Usage: board-live-cards init --base-ref <::kind::value> [--task-executor <script>] [--chat-handler <script>] [--runtime-out <dir>]');
      process.exit(1);
    }

    const result = deps.initBoard(baseRef);

    const config = deps.getConfigStore(dir);
    if (taskExecutor) {
      const teExtraIdx = args.indexOf('--task-executor-extra');
      let teExtra: Record<string, unknown> | undefined;
      if (teExtraIdx !== -1 && args[teExtraIdx + 1]) {
        try { teExtra = JSON.parse(args[teExtraIdx + 1]); } catch { /* ignore bad JSON */ }
      }
      config.writeTaskExecutorRef(executionRefFromScriptPath(taskExecutor, teExtra));
    }
    if (chatHandler) {
      config.writeChatHandler(chatHandler);
    }

    const runtimeOutDir = deps.configureRuntimeOutDir(dir, runtimeOut);
    const live = deps.loadBoard(dir);
    deps.getOutputStore(dir).writeStatusSnapshot(deps.buildBoardStatusObject(dir, live));

    if (result === 'exists') {
      console.log(`Board already initialized at ${dir}${taskExecutor ? ` (task-executor updated: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
    } else {
      console.log(`Board initialized at ${dir}${taskExecutor ? ` (task-executor: ${taskExecutor})` : ''} (runtime-out: ${runtimeOutDir})`);
    }
  }

  function cmdStatus(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const asJson = args.includes('--json');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const dir = baseRefRaw ? parseRef(baseRefRaw).value : undefined;
    if (!dir) {
      console.error('Usage: board-live-cards status --base-ref <::kind::value>');
      process.exit(1);
    }

    let statusObject: any = deps.getOutputStore(dir).readStatusSnapshot();
    if (!statusObject) {
      statusObject = deps.buildBoardStatusObject(dir, deps.loadBoard(dir));
      deps.getOutputStore(dir).writeStatusSnapshot(statusObject);
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
    const brIdx = args.indexOf('--base-ref');
    const idIdx = args.indexOf('--id');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const dir = baseRefRaw ? parseRef(baseRefRaw).value : undefined;
    const cardId = idIdx !== -1 ? args[idIdx + 1] : undefined;
    if (!dir || !cardId) {
      console.error('Usage: board-live-cards remove-card --base-ref <::kind::value> --id <card-id>');
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
    const brIdx = args.indexOf('--base-ref');
    const taskIdx = args.indexOf('--task');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const dir = baseRefRaw ? parseRef(baseRefRaw).value : undefined;
    const taskName = taskIdx !== -1 ? args[taskIdx + 1] : undefined;
    if (!dir || !taskName) {
      console.error('Usage: board-live-cards retrigger --base-ref <::kind::value> --task <task-name>');
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
