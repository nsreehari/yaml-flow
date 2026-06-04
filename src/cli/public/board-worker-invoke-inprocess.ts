export interface InProcessBoardWorkerInvokeRequest {
  subcommand?: string;
  inRef?: string;
  outRef?: string;
  errRef?: string;
  input?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export type InProcessBoardWorkerInvokeResult = unknown;

export type InProcessBoardWorkerInvokeHandler = (
  request: InProcessBoardWorkerInvokeRequest,
) => InProcessBoardWorkerInvokeResult | Promise<InProcessBoardWorkerInvokeResult>;

const inProcessBoardWorkerInvokeRegistry = new Map<string, InProcessBoardWorkerInvokeHandler>();

export function registerInProcessBoardWorkerInvoke(
  key: string,
  handler: InProcessBoardWorkerInvokeHandler,
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('registerInProcessBoardWorkerInvoke: key is required');
  }
  inProcessBoardWorkerInvokeRegistry.set(normalizedKey, handler);
}

export function unregisterInProcessBoardWorkerInvoke(key: string): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  inProcessBoardWorkerInvokeRegistry.delete(normalizedKey);
}

export async function invokeBoardWorkerInProcess(
  request: InProcessBoardWorkerInvokeRequest,
  handlerKey: string,
): Promise<InProcessBoardWorkerInvokeResult> {
  const normalizedKey = String(handlerKey || '').trim();
  if (!normalizedKey) {
    throw new Error('in-process board-worker invoke requires a non-empty handler key');
  }
  const handler = inProcessBoardWorkerInvokeRegistry.get(normalizedKey);
  if (!handler) {
    throw new Error(`in-process board-worker invoke handler not registered: ${normalizedKey}`);
  }
  return await handler(request);
}