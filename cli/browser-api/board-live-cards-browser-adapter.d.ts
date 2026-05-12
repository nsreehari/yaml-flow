import { K as KindValueRef, B as BoardPlatformAdapter } from '../board-live-cards-public-Dn1K3i-V.js';
import { E as ExecutionRef } from '../execution-interface-Ba-R-DNg.js';
import '../board-live-cards-lib-tjYsPt5U.js';

/**
 * server-runtime/types.ts
 *
 * Platform-free adapter interfaces for the board server runtime.
 *
 * The runtime (index.ts) imports ONLY this file and board-live-cards-public
 * for its dependencies — no node:fs, node:net, node:child_process, etc.
 *
 * Hosts (demo-server, Azure Function, Firebase Function) provide implementations
 * of these interfaces when constructing the runtime.
 */

interface NotificationTransport {
    /**
     * Start listening for events on a notification endpoint identified by a kind-ref.
     * The ref kind determines the transport mechanism:
     *   ::named-pipe::/tmp/board-x.sock
     *   ::firestore-watch::collections/board-x/notifications
     *   ::signalr::https://x.service.signalr.net/hub/board-x
     * onEvent is called with parsed JSON notification objects.
     * Returns a teardown function.
     */
    subscribe(ref: KindValueRef, onEvent: (event: unknown) => void): Promise<() => void>;
}

interface InMemoryBus {
    publish(event: unknown): void;
    subscribe(onEvent: (event: unknown) => void): () => void;
}
declare function getInMemoryNotificationBus(channel: string): InMemoryBus;
/**
 * In-memory NotificationTransport for the browser.
 * Subscribes to the same in-memory bus that the adapter publishes to.
 * Use with notifyRef: { kind: 'in-memory-bus', value: '<channel>' }
 */
declare function createInMemoryNotificationTransport(): NotificationTransport;

/**
 * Registry of in-browser execution handlers keyed by whatToRun value.
 * Consumers register handlers that will be invoked when the drain cycle
 * dispatches execution with howToRun === 'in-browser'.
 */
type InBrowserHandler = (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{
    dispatched: boolean;
    error?: string;
}>;
declare function createBrowserBoardPlatformAdapter(namespace: string, opts?: {
    callbackBaseUrl?: string;
    notifyChannel?: string;
    onWarn?: (msg: string) => void;
}): BoardPlatformAdapter & {
    registerHandler(name: string, handler: InBrowserHandler): void;
    writeMemoryBlob(key: string, data: string): string;
};

export { type InBrowserHandler, createBrowserBoardPlatformAdapter, createInMemoryNotificationTransport, getInMemoryNotificationBus };
