export type BoardWorkerCallbackOutcome = 'success' | 'failure';

export interface InProcessBoardWorkerCallbackPayload {
  token: string;
  outcome: BoardWorkerCallbackOutcome;
  ref?: string;
  reason?: string;
}

export type InProcessBoardWorkerCallbackResult = void | { status?: 'success' | 'fail' | 'error'; error?: string };

export type InProcessBoardWorkerCallbackHandler = (
  payload: InProcessBoardWorkerCallbackPayload,
) => InProcessBoardWorkerCallbackResult | Promise<InProcessBoardWorkerCallbackResult>;

const inProcessBoardWorkerCallbackRegistry = new Map<string, InProcessBoardWorkerCallbackHandler>();

export function registerInProcessBoardWorkerCallback(
  key: string,
  handler: InProcessBoardWorkerCallbackHandler,
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('registerInProcessBoardWorkerCallback: key is required');
  }
  inProcessBoardWorkerCallbackRegistry.set(normalizedKey, handler);
}

export function unregisterInProcessBoardWorkerCallback(key: string): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  inProcessBoardWorkerCallbackRegistry.delete(normalizedKey);
}

export async function reportBoardWorkerCallbackInProcess(payload: InProcessBoardWorkerCallbackPayload, handlerKey: string): Promise<void> {
  const normalizedKey = String(handlerKey || '').trim();
  if (!normalizedKey) {
    throw new Error('in-process-loop callback requires a non-empty handler key');
  }
  const handler = inProcessBoardWorkerCallbackRegistry.get(normalizedKey);
  if (!handler) {
    throw new Error(`in-process-loop callback handler not registered: ${normalizedKey}`);
  }
  const result = await handler(payload);
  if (result && result.status && result.status !== 'success') {
    throw new Error(result.error || `in-process-loop callback failed with status: ${result.status}`);
  }
}