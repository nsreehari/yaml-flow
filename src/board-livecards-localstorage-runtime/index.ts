/**
 * board-livecards-localstorage CDN bundle entry point.
 *
 * Prewires board-live-cards-public (platform-free API) with the browser
 * localStorage adapter, so a CDN consumer only needs:
 *
 *   <script src="board-livecards-localstorage.js"></script>
 *   <script>
 *     const board = BoardLiveCardsLocalStorage.create('my-board');
 *     board.init({});
 *     const st = board.status({});
 *   </script>
 *
 * Global: window.BoardLiveCardsLocalStorage
 */

import { createBoardLiveCardsPublic } from '../cli/common/board-live-cards-public.js';
import type { BoardLiveCardsPublic, CommandInput, CommandResult } from '../cli/common/board-live-cards-public.js';
import { createBrowserBoardPlatformAdapter } from '../cli/browser-api/board-live-cards-browser-adapter.js';
import { parseRef } from '../cli/common/storage-interface.js';

export type { BoardLiveCardsPublic, CommandInput, CommandResult };

export interface CreateOptions {
  /** Optional HTTP base URL for callback dispatch (e.g. 'https://my-api.example.com/board'). */
  callbackBaseUrl?: string;
  /** Optional warning handler. */
  onWarn?: (msg: string) => void;
}

/**
 * Create a fully-wired BoardLiveCardsPublic instance backed by localStorage.
 *
 * @param namespace — logical board name (e.g. 'my-board'). Used as localStorage key prefix.
 * @param opts — optional callback URL and warning handler.
 */
export function create(
  namespace: string,
  opts?: CreateOptions,
): BoardLiveCardsPublic {
  const adapter = createBrowserBoardPlatformAdapter(namespace, {
    callbackBaseUrl: opts?.callbackBaseUrl,
    onWarn: opts?.onWarn,
  });

  const baseRef = parseRef(`::localstorage::${namespace}`);

  return createBoardLiveCardsPublic(baseRef, adapter);
}
