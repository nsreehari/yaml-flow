/**
 * server-runtime/mcp-tool-registries.ts
 *
 * Builds the two MCP tool dispatch tables: the per-board tool registry
 * (wraps facade entry-points) and the controlplane registry (wraps the
 * cross-board control handlers + admin facade calls). Pure-mechanical
 * dispatch — argument parsing lives in ./mcp-args.ts, transport in
 * ./mcp-invoker.ts.
 */

import {
  getMcpArgString,
  getMcpArgNumber,
  getMcpArgRecord,
  getRequiredMcpArgRecord,
  getRequiredMcpArgNumber,
  parseMcpUploadBytes,
} from './mcp-args.js';
import type { BoardLiveCardsMcp } from '../cli/common/board-live-cards-mcp.js';

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type ToolRegistry = Record<string, ToolHandler>;

/** Subset of the per-board MCP facade consumed by the tool registry. */
export type McpFacadeForRegistry = BoardLiveCardsMcp;

export function createMcpToolRegistry(mcp: McpFacadeForRegistry): ToolRegistry {
  return {
    'discover.source-kinds': () => mcp.discoverSourceKinds(),
    'inspect.board-runtime-status': () => mcp.inspectBoardRuntimeStatus(),
    'inspect.card-definition-and-runtime': (args) => mcp.inspectCardDefinitionAndRuntime({ cardId: getMcpArgString(args, 'card_id') }),
    'inspect.chat-messages-on-cards': (args) => {
      const lastUserTurns = getMcpArgNumber(args, 'tail_turns');
      const tail = getMcpArgNumber(args, 'tail');
      const turnId = getMcpArgString(args, 'turn_id');
      const allTurns = args['all_turns'] === true;
      const tailTurnsBeforeId = getMcpArgString(args, 'tail_turns_before_id');
      return mcp.inspectChatMessagesOnCards({
        cardId: getMcpArgString(args, 'card_id'),
        ...(lastUserTurns !== undefined ? { lastUserTurns } : {}),
        ...(tail !== undefined ? { tail } : {}),
        ...(turnId ? { turnId } : {}),
        ...(allTurns ? { allTurns: true } : {}),
        ...(tailTurnsBeforeId ? { tailTurnsBeforeId } : {}),
      });
    },
    'inspect.file-contents': (args) => mcp.inspectFileContents({
      cardId: getMcpArgString(args, 'card_id'),
      fileIdx: Number(getMcpArgNumber(args, 'file_idx')),
    }),
    'preflight.validate-candidate-card-definition': (args) => mcp.preflightValidateCandidateCardDefinition({
      candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
    }),
    'preflight.materialize-candidate-card': (args) => mcp.preflightMaterializeCandidateCard({
      candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
      mockRequires: getRequiredMcpArgRecord(args, 'mock_requires', 'mock_requires'),
      mockFetchedSources: getRequiredMcpArgRecord(args, 'mock_fetched_sources', 'mock_fetched_sources'),
    }),
    'preflight.probe-single-source-in-candidate-card': (args) => mcp.preflightProbeSingleSourceInCandidateCard({
      candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
      mockProjections: getMcpArgRecord(args, 'mock_projections'),
      sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
    }),
    'preflight.run-single-source-in-candidate-card': (args) => mcp.preflightRunSingleSourceInCandidateCard({
      candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
      mockProjections: getMcpArgRecord(args, 'mock_projections'),
      sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
    }),
    'preflight.run-single-source-in-live-card': (args) => mcp.preflightRunSingleSourceInLiveCard({
      cardId: getMcpArgString(args, 'card_id'),
      sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
      mockRequires: getRequiredMcpArgRecord(args, 'mock_requires', 'mock_requires'),
    }),
    'preflight.run-one-cycle-with-candidate-card': (args) => mcp.preflightRunOneCycleWithCandidateCard({
      candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
      mockRequires: getMcpArgRecord(args, 'mock_requires'),
    }),
    'manage.read-card': (args) => mcp.manageReadCard({ cardId: getMcpArgString(args, 'card_id') }),
    'stage-ai-response-and-any-attachments': (args) => {
      const turnId = getMcpArgString(args, 'turn_id');
      if (!turnId) {
        throw Object.assign(
          new Error('stage-ai-response-and-any-attachments requires a non-empty turn_id'),
          { statusCode: 400 },
        );
      }
      return mcp.manageAddChatEntryAndAnyAttachments({
        cardId: getMcpArgString(args, 'card_id'),
        role: 'assistant',
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        ...(turnId ? { turn: turnId } : {}),
        ...(Array.isArray(args.files) ? { files: args.files as unknown[] } : {}),
      });
    },
    'manage.upsert-card': (args) => mcp.manageUpsertCard({
      cardId: getMcpArgString(args, 'card_id'),
      candidateCardContent: getMcpArgRecord(args, 'candidate_card_content'),
    }),
    'manage.remove-card': (args) => mcp.manageRemoveCard({ cardId: getMcpArgString(args, 'card_id') }),
  };
}

/** Per-board upload entry point as exposed by createCardFileOps. */
type UploadCardFile = (
  cardId: string,
  fileName: string,
  contentType: string,
  bytes: Uint8Array,
  opts?: { inChat?: boolean },
) => unknown | Promise<unknown>;

export interface McpControlplaneRegistryDeps {
  boardId: string;
  uploadCardFile: UploadCardFile;
  /** Resolves the (lazy) per-board MCP facade for admin tool dispatch. */
  getMcpFacade: () => Pick<McpFacadeForRegistry, 'adminReadCard' | 'adminUpsertCard'>;
  controlplane: {
    getChatProcessing: (args: Record<string, unknown>) => unknown;
    setChatProcessing: (args: Record<string, unknown>, active: boolean) => unknown;
    getCardMeta: (args: Record<string, unknown>) => unknown;
    setCardMeta: (args: Record<string, unknown>) => unknown;
    requireCardArgs: (args: Record<string, unknown>) => { cardId: string };
  };
}

export function createMcpControlplaneToolRegistry(deps: McpControlplaneRegistryDeps): ToolRegistry {
  const { boardId, uploadCardFile, getMcpFacade, controlplane } = deps;
  return {
    'getstate.is-chat-processing': (args) => controlplane.getChatProcessing(args),
    'setstate.chat-processing-started': (args) => controlplane.setChatProcessing(args, true),
    'setstate.chat-processing-done': (args) => controlplane.setChatProcessing(args, false),
    'getstate.card-meta': (args) => controlplane.getCardMeta(args),
    'setstate.card-meta': (args) => controlplane.setCardMeta(args),
    'manage.upload-card-file': (args) => {
      const requestBoardId = getMcpArgString(args, 'board_id');
      const cardId = getMcpArgString(args, 'card_id');
      const fileName = getMcpArgString(args, 'file_name');
      const contentType = getMcpArgString(args, 'content_type') || 'application/octet-stream';
      const bytes = parseMcpUploadBytes(args);

      if (!requestBoardId) throw Object.assign(new Error('manage.upload-card-file requires board_id'), { statusCode: 400 });
      if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
      if (!cardId) throw Object.assign(new Error('manage.upload-card-file requires card_id'), { statusCode: 400 });
      if (!fileName) throw Object.assign(new Error('manage.upload-card-file requires file_name'), { statusCode: 400 });
      if (!bytes) throw Object.assign(new Error('manage.upload-card-file requires args.bytes, args.text, or args.base64'), { statusCode: 400 });

      return uploadCardFile(cardId, fileName, contentType, bytes, { inChat: false });
    },
    'manage.admin-read-card': async (args) => {
      const { cardId } = controlplane.requireCardArgs(args);
      const cards = await getMcpFacade().adminReadCard({ cardId });
      return { status: 'success', data: { cards } };
    },
    'manage.admin-upsert-card': (args) => {
      const requestBoardId = getMcpArgString(args, 'board_id');
      const cardId = getMcpArgString(args, 'card_id');
      if (!requestBoardId) throw Object.assign(new Error('manage.admin-upsert-card requires board_id'), { statusCode: 400 });
      if (!cardId) throw Object.assign(new Error('manage.admin-upsert-card requires card_id'), { statusCode: 400 });
      if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
      return getMcpFacade().adminUpsertCard({
        cardId,
        candidateCardContent: getMcpArgRecord(args, 'candidate_card_content'),
      });
    },
  };
}
