import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { GraphEvent } from '../event-graph/types.js';

interface TaskExecutorConfigLike {
  command: string;
  extra?: Record<string, unknown>;
}

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
  readTaskExecutorConfig: (boardDir: string) => TaskExecutorConfigLike | undefined;
  resolveCardGlobMatches: (cardGlob: string) => string[];
  validateLiveCardDefinition: (card: Record<string, unknown>) => ValidateResultLike;
  execCommandSync: (command: string, args: string[], options?: Record<string, unknown>) => string;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface BoardCommandHandlers {
  cmdInit: (args: string[]) => void;
  cmdStatus: (args: string[]) => void;
  cmdValidateCard: (args: string[]) => void;
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

    if (taskExecutor) {
      const teExtraIdx = args.indexOf('--task-executor-extra');
      let teExtra: Record<string, unknown> | undefined;
      if (teExtraIdx !== -1 && args[teExtraIdx + 1]) {
        try { teExtra = JSON.parse(args[teExtraIdx + 1]); } catch { /* ignore bad JSON */ }
      }
      const teConfig: TaskExecutorConfigLike = { command: taskExecutor, ...(teExtra ? { extra: teExtra } : {}) };
      fs.writeFileSync(path.join(dir, '.task-executor'), JSON.stringify(teConfig, null, 2), 'utf-8');
    }
    if (chatHandler) {
      fs.writeFileSync(path.join(dir, '.chat-handler'), chatHandler, 'utf-8');
    }
    if (inferenceAdapter) {
      fs.writeFileSync(path.join(dir, '.inference-adapter'), inferenceAdapter, 'utf-8');
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

  function cmdValidateCard(args: string[]): void {
    const cardIdx = args.indexOf('--card');
    const globIdx = args.indexOf('--card-glob');
    const rgIdx = args.indexOf('--rg');
    const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const cardGlob = globIdx !== -1 ? args[globIdx + 1] : undefined;
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;

    if ((!cardFile && !cardGlob) || (cardFile && cardGlob)) {
      throw new Error('Usage: board-live-cards validate-card (--card <card.json> | --card-glob <glob>) [--rg <boardDir>]');
    }

    let teConfig: TaskExecutorConfigLike | undefined;
    if (boardDir) {
      teConfig = deps.readTaskExecutorConfig(boardDir);
      if (!teConfig) {
        throw new Error(`--rg specified but no .task-executor found in ${boardDir}`);
      }
    }

    const files = cardFile ? [path.resolve(cardFile)] : deps.resolveCardGlobMatches(cardGlob!);
    if (files.length === 0) {
      throw new Error(`No card files matched glob: ${cardGlob}`);
    }

    let failures = 0;
    for (const f of files) {
      const label = path.relative(process.cwd(), f) || f;
      if (!fs.existsSync(f)) {
        console.error(`FAIL  ${label}: file not found`);
        failures++;
        continue;
      }
      let card: Record<string, unknown>;
      try {
        card = JSON.parse(fs.readFileSync(f, 'utf-8'));
      } catch (err) {
        console.error(`FAIL  ${label}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
        failures++;
        continue;
      }
      const result = deps.validateLiveCardDefinition(card);

      const sourceErrors: string[] = [];
      if (teConfig && Array.isArray(card.source_defs)) {
        for (const src of card.source_defs as Array<Record<string, unknown>>) {
          const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
          const tmpFile = path.join(os.tmpdir(), `validate-src-${bindTo}-${Date.now()}.json`);
          try {
            fs.writeFileSync(tmpFile, JSON.stringify(src), 'utf-8');
            let stdout: string;
            try {
              stdout = deps.execCommandSync(teConfig.command, ['validate-source-def', '--in', tmpFile], { shell: true, timeout: 10_000 });
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

      const allErrors = [...result.errors, ...sourceErrors];
      if (allErrors.length === 0) {
        console.log(`OK    ${label}`);
      } else {
        console.error(`FAIL  ${label}:`);
        for (const error of allErrors) {
          console.error(`        ${error}`);
        }
        failures++;
      }
    }

    if (failures > 0) {
      throw new Error(`${failures} of ${files.length} card(s) failed validation.`);
    }
    console.log(`\n${files.length} card(s) passed validation.`);
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
    cmdRemoveCard,
    cmdRetrigger,
  };
}
