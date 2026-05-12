#!/usr/bin/env node
/**
 * board-live-cards-example-cli.ts
 *
 * Thin arg-parse CLI for the board-live-cards public API.
 *
 * This file contains ONLY:
 *   1. Arg parsing helpers
 *   2. A `cli()` function that maps argv → public-API calls
 *   3. A main-invocation guard
 *
 * All logic lives in board-live-cards-public.ts (platform-free) and
 * fs-board-adapter.ts (Node/FS platform adapters).
 *
 * Imports are limited to ./fs-board-adapter.js and ./process-runner.js —
 * no direct imports from ../common/*.
 */
declare function cli(argv: string[]): Promise<void>;

export { cli };
