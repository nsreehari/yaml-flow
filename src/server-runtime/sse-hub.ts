/**
 * server-runtime/sse-hub.ts
 *
 * Owns the per-runtime SSE client registry, the chat-subscription scanner, and
 * all broadcast helpers. The HTTP route handler for the SSE endpoint still
 * lives in index.ts because it sequences SSE registration with runtime
 * bootstrap; this hub exposes the primitives it needs.
 *
 * State owned here:
 *   - sseClients (clientId -> { res, subscribedChatCardIds })
 *   - sseEventId monotonic counter
 *   - chat-subscription scan timer + per-card cursor/processing snapshots
 *
 * Dependencies passed in by the runtime:
 *   - chatStorage for tailing chat history
 *   - readChatRecords for building chat-scoped notifications
 *   - optional host hooks (onSseClientDisconnected, etc.)
 */

import type { RuntimeResponse } from './types.js';

export interface SseClientState {
  res: RuntimeResponse;
  subscribedChatCardIds: Set<string>;
}

export interface SseHub {
  /** Number of currently-registered SSE clients. */
  size(): number;
  /** Whether a client id is currently registered. */
  has(clientId: string): boolean;
  /** Returns the existing client state if present (used to migrate chat subs on reconnect). */
  get(clientId: string): SseClientState | undefined;
  /** Build a wire-format SSE frame for the given payload. Increments the event id. */
  buildFrame(payload: unknown): string;
  /** Best-effort transport-level flush for the underlying response object. */
  flushTransport(res: RuntimeResponse): void;
  /** Register a fresh client. Any prior registration with the same id is disconnected first. */
  register(clientId: string, res: RuntimeResponse, subscribedChatCardIds?: Set<string>): void;
  /** Drop a registered client. If expectedRes is supplied and does not match, no-op. */
  disconnect(clientId: string, expectedRes?: RuntimeResponse): void;
  /** Write an SSE frame to one client; transport errors disconnect that client. */
  writeFrame(clientId: string, payload: unknown): void;
  /** Subscribe a client to a card's chat stream and prime its cursor. */
  subscribeChat(clientId: string, cardId: string): Promise<boolean>;
  /** Unsubscribe a client from a card's chat stream. */
  unsubscribeChat(clientId: string, cardId: string): boolean;
  /** Broadcast a notification batch; chat-scoped notes are routed to chat-subscribed clients. */
  broadcastNotificationBatch(notifications: unknown[]): void;
  /** Push a fresh card-chats notification to every chat-subscribed client. */
  broadcastCardChats(cardId: string, receiving?: boolean): Promise<void>;
}

export interface SseHubDeps {
  readChatRecords: (cardId: string) => Promise<Array<Record<string, unknown>>>;
  readChatAfter: (cardId: string, cursor: string | null) => Promise<{ records: Array<Record<string, unknown>>; cursor: string | null }>;
  getChatProcessing: (cardId: string) => Promise<boolean>;
  onSseClientDisconnected?: (clientId: string) => void;
}

export function createSseHub(deps: SseHubDeps): SseHub {
  const sseClients = new Map<string, SseClientState>();
  const lastChatCursorByCardId = new Map<string, string | null>();
  const lastChatProcessingByCardId = new Map<string, boolean>();
  let sseEventId = 0;
  let chatSubscriptionScanTimer: ReturnType<typeof setInterval> | null = null;

  function buildFrame(payload: unknown): string {
    const jsonStr = JSON.stringify(payload);
    sseEventId++;
    return `id: ${sseEventId}\ndata: ${jsonStr}\n\n`;
  }

  function flushTransport(res: RuntimeResponse): void {
    const resWithTransport = res as RuntimeResponse & {
      flushHeaders?: () => void;
      flush?: () => void;
      socket?: {
        setNoDelay?: (noDelay?: boolean) => void;
        uncork?: () => void;
      } | null;
    };
    try { resWithTransport.flushHeaders?.(); } catch { /* ignore */ }
    try { resWithTransport.flush?.(); } catch { /* ignore */ }
    try { resWithTransport.socket?.setNoDelay?.(true); } catch { /* ignore */ }
    try { resWithTransport.socket?.uncork?.(); } catch { /* ignore */ }
  }

  function disconnect(clientId: string, expectedRes?: RuntimeResponse): void {
    const client = sseClients.get(clientId);
    if (!client) return;
    if (expectedRes && client.res !== expectedRes) return;
    sseClients.delete(clientId);
    stopChatSubscriptionScanIfIdle();
    try { deps.onSseClientDisconnected?.(clientId); } catch { /* ignore host hook failures */ }
    try { client.res.end(); } catch { /* ignore */ }
  }

  function register(clientId: string, res: RuntimeResponse, subscribedChatCardIds?: Set<string>): void {
    const existing = sseClients.get(clientId);
    if (existing) disconnect(clientId, existing.res);
    sseClients.set(clientId, { res, subscribedChatCardIds: subscribedChatCardIds ?? new Set<string>() });
  }

  function writeFrame(clientId: string, payload: unknown): void {
    const client = sseClients.get(clientId);
    if (!client) return;
    const frame = buildFrame(payload);
    try {
      client.res.write(frame);
      flushTransport(client.res);
    } catch {
      disconnect(clientId, client.res);
    }
  }

  function currentSubscribedChatCardIds(): string[] {
    const ids = new Set<string>();
    for (const client of sseClients.values()) {
      for (const cardId of client.subscribedChatCardIds) ids.add(cardId);
    }
    return Array.from(ids);
  }

  /** Returns true when there are new messages or the processing flag changed since last call. Advances cursor as a side effect. */
  async function hasChatChanges(cardId: string): Promise<boolean> {
    const lastCursor = lastChatCursorByCardId.has(cardId) ? lastChatCursorByCardId.get(cardId)! : null;
    const { cursor: newCursor } = await deps.readChatAfter(cardId, lastCursor);
    const processing = await deps.getChatProcessing(cardId);
    const processingChanged = processing !== (lastChatProcessingByCardId.get(cardId) ?? false);
    const hasNewRecords = newCursor !== lastCursor;
    if (hasNewRecords) lastChatCursorByCardId.set(cardId, newCursor);
    lastChatProcessingByCardId.set(cardId, processing);
    return hasNewRecords || processingChanged;
  }

  async function buildCardChatsNotification(cardId: string, receiving: boolean): Promise<Record<string, unknown>> {
    const records = await deps.readChatRecords(cardId);
    const sentAtMs = Date.now();
    return {
      kind: 'card_chats',
      cardId,
      sentAt: new Date(sentAtMs).toISOString(),
      sentAtMs,
      messages: records.map((r) => ({
        role: String(r.role || 'system'),
        text: String(r.text || ''),
        files: Array.isArray(r.files) ? r.files : [],
      })),
      receiving,
      processing: await deps.getChatProcessing(cardId),
    };
  }

  async function broadcastCardChats(cardId: string, receiving = true): Promise<void> {
    const payload = { kind: 'notification-batch', notifications: [await buildCardChatsNotification(cardId, receiving)] };
    for (const [clientId, client] of sseClients.entries()) {
      if (!client.subscribedChatCardIds.has(cardId)) continue;
      writeFrame(clientId, payload);
    }
  }

  function stopChatSubscriptionScanIfIdle(): void {
    if (currentSubscribedChatCardIds().length > 0) return;
    if (chatSubscriptionScanTimer) {
      clearInterval(chatSubscriptionScanTimer);
      chatSubscriptionScanTimer = null;
    }
    lastChatCursorByCardId.clear();
    lastChatProcessingByCardId.clear();
  }

  function ensureChatSubscriptionScan(): void {
    if (chatSubscriptionScanTimer) return;
    const scan = async () => {
      const activeCardIds = currentSubscribedChatCardIds();
      if (activeCardIds.length === 0) {
        stopChatSubscriptionScanIfIdle();
        return;
      }
      const activeSet = new Set(activeCardIds);
      for (const cardId of Array.from(lastChatCursorByCardId.keys())) {
        if (!activeSet.has(cardId)) lastChatCursorByCardId.delete(cardId);
      }
      for (const cardId of Array.from(lastChatProcessingByCardId.keys())) {
        if (!activeSet.has(cardId)) lastChatProcessingByCardId.delete(cardId);
      }
      for (const cardId of activeCardIds) {
        if (await hasChatChanges(cardId)) await broadcastCardChats(cardId, true);
      }
    };
    void scan();
    chatSubscriptionScanTimer = setInterval(() => { void scan(); }, 1000);
  }

  async function subscribeChat(clientId: string, cardId: string): Promise<boolean> {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.add(cardId);
    // Initialise cursor to latest so we only push deltas from this point forward.
    const { cursor: latestCursor } = await deps.readChatAfter(cardId, null);
    lastChatCursorByCardId.set(cardId, latestCursor);
    lastChatProcessingByCardId.set(cardId, await deps.getChatProcessing(cardId));
    ensureChatSubscriptionScan();
    writeFrame(clientId, { kind: 'notification-batch', notifications: [await buildCardChatsNotification(cardId, true)] });
    return true;
  }

  function unsubscribeChat(clientId: string, cardId: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.delete(cardId);
    if (!currentSubscribedChatCardIds().includes(cardId)) {
      lastChatCursorByCardId.delete(cardId);
      lastChatProcessingByCardId.delete(cardId);
    }
    stopChatSubscriptionScanIfIdle();
    return true;
  }

  function isChatScopedNotification(notification: unknown): notification is Record<string, unknown> {
    if (!notification || typeof notification !== 'object') return false;
    const kind = (notification as Record<string, unknown>).kind;
    return kind === 'card_chats' || kind === 'chat_messages';
  }

  function broadcastNotificationBatch(notifications: unknown[]): void {
    if (!notifications || notifications.length === 0) return;
    const generalNotifications: unknown[] = [];
    const chatCardIds = new Set<string>();
    for (const note of notifications) {
      if (isChatScopedNotification(note) && typeof (note as Record<string, unknown>).cardId === 'string') {
        chatCardIds.add(String((note as Record<string, unknown>).cardId));
      } else {
        generalNotifications.push(note);
      }
    }
    if (generalNotifications.length > 0) {
      const payload = { kind: 'notification-batch', notifications: generalNotifications };
      for (const clientId of sseClients.keys()) writeFrame(clientId, payload);
    }
    for (const cardId of chatCardIds) void broadcastCardChats(cardId, true);
  }

  return {
    size: () => sseClients.size,
    has: (clientId) => sseClients.has(clientId),
    get: (clientId) => sseClients.get(clientId),
    buildFrame,
    flushTransport,
    register,
    disconnect,
    writeFrame,
    subscribeChat,
    unsubscribeChat,
    broadcastNotificationBatch,
    broadcastCardChats,
  };
}
