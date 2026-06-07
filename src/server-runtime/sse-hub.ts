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
 *
 * Dependencies passed in by the runtime:
 *   - chat-store one-shot builder for subscription hydration
 *   - optional host hooks (onSseClientDisconnected, etc.)
 */

import type { RuntimeResponse } from './types.js';
import type {
  ChatStoreNotification,
  HostedRuntimeNotification,
  RuntimeNotification,
  RuntimeNotificationBatch,
} from '../cli/common/notification-interface.js';
import { withRuntimeNotificationBatchCategories } from '../cli/common/notification-interface.js';
import type { CommandResult } from '../cli/common/board-live-cards-public.js';

export interface SseClientState {
  res: RuntimeResponse;
  subscribedChatCardIds: Set<string>;
  subscribedChannelNames: Set<string>;
  subscribedCardChannels: Map<string, Set<string>>;
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
  register(
    clientId: string,
    res: RuntimeResponse,
    state?: {
      subscribedChatCardIds?: Set<string>;
      subscribedChannelNames?: Set<string>;
      subscribedCardChannels?: Map<string, Set<string>>;
    },
  ): void;
  /** Drop a registered client. If expectedRes is supplied and does not match, no-op. */
  disconnect(clientId: string, expectedRes?: RuntimeResponse): void;
  /** Write an SSE frame to one client; transport errors disconnect that client. */
  writeFrame(clientId: string, payload: unknown): void;
  /** Subscribe a client to a card's chat stream and send one-shot hydration. */
  subscribeChat(clientId: string, cardId: string): Promise<boolean>;
  /** Unsubscribe a client from a card's chat stream. */
  unsubscribeChat(clientId: string, cardId: string): boolean;
  /** Subscribe a client to a named board or card-scoped channel. */
  subscribeChannel(clientId: string, channelName: string, cardId?: string): boolean;
  /** Unsubscribe a client from a named board or card-scoped channel. */
  unsubscribeChannel(clientId: string, channelName: string, cardId?: string): boolean;
  /** Broadcast a notification batch; chat-scoped notes are routed to chat-subscribed clients. */
  broadcastNotificationBatch(notifications: RuntimeNotification[]): void;
}

export interface SseHubDeps {
  buildChatOneShotBatch: (cardId: string, receiving: boolean) => Promise<CommandResult<RuntimeNotificationBatch>>;
  onSseClientDisconnected?: (clientId: string) => void;
}

export function createSseHub(deps: SseHubDeps): SseHub {
  const sseClients = new Map<string, SseClientState>();
  let sseEventId = 0;

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
    try { deps.onSseClientDisconnected?.(clientId); } catch { /* ignore host hook failures */ }
    try { client.res.end(); } catch { /* ignore */ }
  }

  function register(
    clientId: string,
    res: RuntimeResponse,
    state?: {
      subscribedChatCardIds?: Set<string>;
      subscribedChannelNames?: Set<string>;
      subscribedCardChannels?: Map<string, Set<string>>;
    },
  ): void {
    const existing = sseClients.get(clientId);
    if (existing) disconnect(clientId, existing.res);
    sseClients.set(clientId, {
      res,
      subscribedChatCardIds: state?.subscribedChatCardIds ?? new Set<string>(),
      subscribedChannelNames: state?.subscribedChannelNames ?? new Set<string>(),
      subscribedCardChannels: state?.subscribedCardChannels ?? new Map<string, Set<string>>(),
    });
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

  function buildNotificationBatch(notifications: RuntimeNotification[]): RuntimeNotificationBatch {
    return withRuntimeNotificationBatchCategories({ kind: 'notification-batch', notifications });
  }

  async function buildCardChatsBatch(cardId: string, receiving: boolean): Promise<RuntimeNotificationBatch> {
    const result = await deps.buildChatOneShotBatch(cardId, receiving);
    if (result.status === 'success') return result.data;
    return buildNotificationBatch([]);
  }

  async function subscribeChat(clientId: string, cardId: string): Promise<boolean> {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.add(cardId);
    writeFrame(clientId, await buildCardChatsBatch(cardId, true));
    return true;
  }

  function unsubscribeChat(clientId: string, cardId: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.delete(cardId);
    return true;
  }

  function subscribeChannel(clientId: string, channelName: string, cardId?: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    if (cardId) {
      const existing = client.subscribedCardChannels.get(cardId) ?? new Set<string>();
      existing.add(channelName);
      client.subscribedCardChannels.set(cardId, existing);
      return true;
    }
    client.subscribedChannelNames.add(channelName);
    return true;
  }

  function unsubscribeChannel(clientId: string, channelName: string, cardId?: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    if (cardId) {
      const existing = client.subscribedCardChannels.get(cardId);
      if (!existing) return true;
      existing.delete(channelName);
      if (existing.size === 0) {
        client.subscribedCardChannels.delete(cardId);
      }
      return true;
    }
    client.subscribedChannelNames.delete(channelName);
    return true;
  }

  function isChatScopedNotification(notification: RuntimeNotification): notification is ChatStoreNotification | HostedRuntimeNotification {
    return notification.kind === 'card_chats' || notification.kind === 'chat_messages' || notification.kind === 'chat_processing';
  }

  function isWatchpartyNotification(notification: RuntimeNotification): notification is Extract<RuntimeNotification, { kind: 'card_watchparty' }> {
    return notification.kind === 'card_watchparty';
  }

  function isSubscribedToWatchpartyChannel(client: SseClientState, channelName: string, cardId: string): boolean {
    if (client.subscribedChannelNames.has(channelName)) {
      return true;
    }
    const cardChannels = client.subscribedCardChannels.get(cardId);
    return !!cardChannels?.has(channelName);
  }

  function broadcastNotificationBatch(notifications: RuntimeNotification[]): void {
    if (!notifications || notifications.length === 0) return;
    const generalNotifications: RuntimeNotification[] = [];
    const chatNotificationsByCardId = new Map<string, RuntimeNotification[]>();
    const watchpartyNotificationsByCardChannel = new Map<string, RuntimeNotification[]>();
    for (const note of notifications) {
      if (isWatchpartyNotification(note)) {
        const key = `${note.cardId}\u0000${note.channel}`;
        const scoped = watchpartyNotificationsByCardChannel.get(key) ?? [];
        scoped.push(note);
        watchpartyNotificationsByCardChannel.set(key, scoped);
      } else if (isChatScopedNotification(note)) {
        const scoped = chatNotificationsByCardId.get(note.cardId) ?? [];
        scoped.push(note);
        chatNotificationsByCardId.set(note.cardId, scoped);
      } else {
        generalNotifications.push(note);
      }
    }
    if (generalNotifications.length > 0) {
      const payload = buildNotificationBatch(generalNotifications);
      for (const clientId of sseClients.keys()) writeFrame(clientId, payload);
    }
    for (const [cardId, scopedNotifications] of chatNotificationsByCardId.entries()) {
      const payload = buildNotificationBatch(scopedNotifications);
      for (const [clientId, client] of sseClients.entries()) {
        if (!client.subscribedChatCardIds.has(cardId)) continue;
        writeFrame(clientId, payload);
      }
    }
    for (const [key, scopedNotifications] of watchpartyNotificationsByCardChannel.entries()) {
      const separator = key.indexOf('\u0000');
      const cardId = separator >= 0 ? key.slice(0, separator) : '';
      const channelName = separator >= 0 ? key.slice(separator + 1) : key;
      const payload = buildNotificationBatch(scopedNotifications);
      for (const [clientId, client] of sseClients.entries()) {
        if (!cardId || !channelName) continue;
        if (!isSubscribedToWatchpartyChannel(client, channelName, cardId)) continue;
        writeFrame(clientId, payload);
      }
    }
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
    subscribeChannel,
    unsubscribeChannel,
    broadcastNotificationBatch,
  };
}
