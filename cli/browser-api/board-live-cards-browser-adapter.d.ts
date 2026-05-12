import { B as BoardPlatformAdapter, N as NotificationTransport } from '../types-DTrjfrXe.js';
import { E as ExecutionRef } from '../execution-interface-87BHR8LJ.js';
import '../board-live-cards-lib-tjYsPt5U.js';

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
