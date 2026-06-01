/**
 * server-runtime/routes-agentface.ts
 *
 * Agent-facing MCP routes extracted from createSingleBoardServerRuntime.
 *   POST /mcp      — general MCP tool dispatch (read-only, stateless)
 *   POST /mcp-raw  — raw file-content streaming (inspect.file-contents only)
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { getMcpArgString, getMcpArgNumber } from './mcp-args.js';
import { invokeMcpTool, extractMcpFailureMessage } from './mcp-invoker.js';
import type { ToolRegistry } from './mcp-tool-registries.js';

interface McpFacadeLike {
  inspectFileContents: (args: { cardId: string; fileIdx: number }) => unknown;
}

interface CardFileRecord {
  name?: unknown;
  stored_name?: unknown;
  mime_type?: unknown;
}

export interface RoutesAgentfaceDeps {
  apiBasePath: string;
  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  bootstrapBoard: () => Promise<void>;
  createMcpFacade: () => McpFacadeLike;
  createMcpToolRegistry: (mcp: McpFacadeLike) => ToolRegistry;
  resolveCardFileDownloadPayload: (
    cardId: string,
    idx: number,
    expectedStoredName: string | null,
  ) => Promise<{ fileRecord: CardFileRecord; bytes: Uint8Array }>;
  isLikelyTextMimeType: (mimeType: string) => boolean;
  sliceTextByLines: (text: string, mode: 'head' | 'tail', count: number) => string;
}

export interface RoutesAgentface {
  handleAgentfaceApi: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
}

export function createRoutesAgentface(deps: RoutesAgentfaceDeps): RoutesAgentface {
  const {
    apiBasePath,
    json,
    readJsonBody,
    bootstrapBoard,
    createMcpFacade,
    createMcpToolRegistry,
    resolveCardFileDownloadPayload,
    isLikelyTextMimeType,
    sliceTextByLines,
  } = deps;

  async function handleAgentfaceApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const url = parsedUrl;
    const p = url.pathname;

    try {
      if (method === 'POST' && p === `${apiBasePath}/mcp`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool === 'inspect.file-contents') {
          json(res, 400, { error: 'inspect.file-contents is only available on /mcp-raw' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpToolRegistry(createMcpFacade()));
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp-raw`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool !== 'inspect.file-contents') {
          json(res, 400, { error: `Tool does not support raw response: ${tool}` });
          return true;
        }
        const cardId = getMcpArgString(args, 'card_id', 'cardId');
        const fileIdx = getMcpArgNumber(args, 'file_idx', 'fileIdx');
        const headLines = getMcpArgNumber(args, 'head-lines', 'headLines');
        const tailLines = getMcpArgNumber(args, 'tail-lines', 'tailLines');
        const headBytes = getMcpArgNumber(args, 'head-bytes', 'headBytes');
        const tailBytes = getMcpArgNumber(args, 'tail-bytes', 'tailBytes');
        if (!cardId) {
          json(res, 400, { error: 'inspect.file-contents requires card_id' });
          return true;
        }
        if (fileIdx === undefined || !Number.isInteger(fileIdx) || fileIdx < 0) {
          json(res, 400, { error: 'inspect.file-contents requires file_idx to be a non-negative integer' });
          return true;
        }
        const rawModes = [headLines, tailLines, headBytes, tailBytes].filter((value) => value !== undefined);
        if (rawModes.length > 1) {
          json(res, 400, { error: 'inspect.file-contents accepts at most one of head-lines, tail-lines, head-bytes, tail-bytes' });
          return true;
        }
        for (const [name, value] of [['head-lines', headLines], ['tail-lines', tailLines], ['head-bytes', headBytes], ['tail-bytes', tailBytes]] as const) {
          if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            json(res, 400, { error: `inspect.file-contents requires ${name} to be a non-negative integer` });
            return true;
          }
        }
        const descriptor = await createMcpFacade().inspectFileContents({ cardId, fileIdx }) as { stored_name?: unknown; mime_type?: unknown; name?: unknown };
        const expectedStoredName = typeof descriptor?.stored_name === 'string' ? descriptor.stored_name : null;
        const { fileRecord, bytes } = await resolveCardFileDownloadPayload(cardId, fileIdx, expectedStoredName);
        const filename = String(fileRecord.name || fileRecord.stored_name || 'download.bin');
        const mimeType = String(fileRecord.mime_type || 'application/octet-stream');
        const respMode = (url.searchParams.get('resp') || '').trim().toLowerCase();
        if (respMode && respMode !== 'json-b64') {
          json(res, 400, { error: `unsupported resp mode: ${respMode}` });
          return true;
        }
        const wantBase64 = respMode === 'json-b64';
        let outBytes: Uint8Array;
        if (headLines !== undefined || tailLines !== undefined) {
          if (!isLikelyTextMimeType(mimeType)) {
            json(res, 400, { error: 'head-lines/tail-lines are only supported for text-like files; use head-bytes/tail-bytes for binary content' });
            return true;
          }
          const text = new TextDecoder().decode(bytes);
          const slicedText = headLines !== undefined
            ? sliceTextByLines(text, 'head', headLines)
            : sliceTextByLines(text, 'tail', tailLines as number);
          outBytes = typeof Buffer !== 'undefined' ? Buffer.from(slicedText, 'utf8') : new TextEncoder().encode(slicedText);
        } else if (headBytes !== undefined || tailBytes !== undefined) {
          const count = (headBytes ?? tailBytes) as number;
          outBytes = headBytes !== undefined ? bytes.slice(0, count) : bytes.slice(Math.max(0, bytes.length - count));
        } else {
          outBytes = bytes;
        }
        if (wantBase64) {
          const bodyBase64 = typeof Buffer !== 'undefined'
            ? Buffer.from(outBytes).toString('base64')
            : btoa(String.fromCharCode(...outBytes));
          json(res, 200, { bodyBase64, mimeType, filename, byteLength: outBytes.length });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': outBytes.length,
        });
        res.end(outBytes as unknown as Buffer);
        return true;
      }

      return false;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode || 500;
      json(res, statusCode, { error: String((err as Error)?.message || err) });
      return true;
    }
  }

  return { handleAgentfaceApi };
}
