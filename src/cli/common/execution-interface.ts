/**
 * execution-interface.ts
 *
 * Pure module — no Node/platform imports.  Safe for any runtime.
 *
 * Defines the portable descriptor types for invoking any executable target,
 * regardless of transport (local process, HTTP endpoint, cloud function, etc.).
 *
 * Parallel to storage-interface.ts (which describes WHERE data lives), this
 * module describes HOW to invoke a piece of logic.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CORE CONCEPTS
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  ExecutionRef — self-contained, serializable JSON descriptor for one invocation target.
 *    • howToRun    — transport / runtime kind (discriminator)
 *    • whatToRun   — address of the artifact (KindValueRef wire form: ::kind::value)
 *    • argsMassaging — optional JSONata expressions that map logical args → physical call shape
 *    • meta        — optional human-readable label (e.g. 'task-executor', 'chat-handler')
 *
 *  ExecutionResult — standardized envelope returned by any invocation.
 *    • status: 'success' | 'fail' | 'error'
 *    • data   — KindValueRef wire form pointing to output blob (on success)
 *    • error  — human-readable message (on fail/error)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * howToRun VALUES
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  'local-node'      node <whatToRun> [argv...]
 *  'local-python'    python <whatToRun> [argv...]
 *  'local-process'   execute <whatToRun> directly (shebang / pre-resolved binary)
 *  'http:post'       HTTP POST to <whatToRun>
 *  'http:get'        HTTP GET to <whatToRun>
 *  'built-in'        resolved by the adapter to a well-known internal implementation
 *
 * ────────────────────────────────────────────────────────────────────────────
 * argsMassaging
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  Each field is a JSONata expression evaluated against the caller's logical args object.
 *  If argsMassaging is omitted, the adapter uses its default mapping for the howToRun kind.
 *
 *  cmdTemplate  — array of JSONata exprs, each producing one argv string (local transports)
 *  urlTemplate  — JSONata expr producing the final URL string (http transports)
 *  bodyTemplate — JSONata expr producing the request body object (http transports)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SERIALIZATION
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  ExecutionRef is a plain JSON object — store it as-is on disk, in Cosmos, or any DB.
 *  No special encoding needed.  parseExecutionRef / serializeExecutionRef are thin
 *  JSON wrappers provided for symmetry with storage-interface.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * USAGE EXAMPLES
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  // Built-in source-cli task executor (resolved by adapter from cliDir):
 *  const builtIn: ExecutionRef = {
 *    meta: 'task-executor',
 *    howToRun: 'built-in',
 *    whatToRun: '::built-in::source-cli-task-executor',
 *  };
 *
 *  // External local-node task executor with default protocol args:
 *  const local: ExecutionRef = {
 *    meta: 'task-executor',
 *    howToRun: 'local-node',
 *    whatToRun: '::fs-path::/path/to/my-executor.js',
 *  };
 *
 *  // Azure Function task executor with custom arg mapping:
 *  const azureFn: ExecutionRef = {
 *    meta: 'task-executor',
 *    howToRun: 'http:post',
 *    whatToRun: '::http-url::https://myfn.azurewebsites.net/api/task-executor',
 *    argsMassaging: {
 *      urlTemplate: "whatToRun & '?op=' & subcommand",
 *      bodyTemplate: "{ 'inRef': inRef, 'outRef': outRef, 'token': token }",
 *    },
 *  };
 *
 *  // Chat handler over HTTP with a different logical args shape:
 *  const chatHandler: ExecutionRef = {
 *    meta: 'chat-handler',
 *    howToRun: 'http:post',
 *    whatToRun: '::http-url::https://myfn.azurewebsites.net/api/chat',
 *    argsMassaging: {
 *      bodyTemplate: "{ 'message': message, 'context': context, 'sessionId': sessionId }",
 *    },
 *  };
 */

// ============================================================================
// ArgsMassaging
// ============================================================================

/**
 * Optional JSONata-based mapping from logical args → physical invocation shape.
 *
 * Each field is a JSONata expression string evaluated against the caller's
 * logical args object (e.g. `{ inRef, outRef, errRef }` for a task-executor).
 *
 * If argsMassaging is omitted entirely, the execution adapter uses its default
 * mapping for the given howToRun kind.
 */
export interface ArgsMassaging {
  /**
   * For local transports ('local-node', 'local-python', 'local-process').
   * Array of JSONata expressions — each evaluates to one argv string.
   * The resolved strings are appended after the base command.
   *
   * @example
   * // Standard task-executor protocol:
   * cmdTemplate: [
   *   "'run-source-fetch'",
   *   "'--in-ref'",  "inRef",
   *   "'--out-ref'", "outRef",
   *   "'--err-ref'", "errRef",
   * ]
   */
  cmdTemplate?: string[];

  /**
   * For http transports ('http:post', 'http:get').
   * JSONata expression that produces the final URL string.
   * The input context includes 'whatToRun' (the base URL from the ref)
   * plus all logical args.
   *
   * @example
   * urlTemplate: "whatToRun & '?op=' & subcommand"
   */
  urlTemplate?: string;

  /**
   * For http transports.
   * JSONata expression that produces the request body object.
   * Evaluated against the logical args object.
   *
   * @example
   * bodyTemplate: "{ 'inRef': inRef, 'outRef': outRef, 'token': token }"
   */
  bodyTemplate?: string;
}

// ============================================================================
// ExecutionRef
// ============================================================================

/**
 * Self-contained, serializable descriptor for invoking a target.
 *
 * Stores everything needed to make the physical call — transport kind,
 * artifact address, and optional arg-mapping expressions.
 * Serialize as plain JSON; no special wire encoding required.
 */
export interface ExecutionRef {
  /**
   * Optional human-readable label identifying the role of this invocation.
   * Not used for dispatch — purely for logging and diagnostics.
   * @example 'task-executor', 'chat-handler', 'board-live-cards'
   */
  meta?: string;

  /**
   * Transport and runtime kind — determines how whatToRun is invoked.
   * @see module JSDoc for the full list of supported values.
   */
  howToRun: 'local-node' | 'local-python' | 'local-process' | 'http:post' | 'http:get' | 'built-in';

  /**
   * Address of the artifact to run, in KindValueRef wire form (::kind::value).
   * @example '::fs-path::/dist/cli/source-cli-task-executor.js'
   * @example '::http-url::https://fn.example.com/api/executor'
   * @example '::built-in::source-cli-task-executor'
   */
  whatToRun: string;

  /**
   * Optional JSONata-based mapping from logical args → physical call shape.
   * When omitted, the adapter applies its default protocol for the howToRun kind.
   */
  argsMassaging?: ArgsMassaging;

  /**
   * Opaque executor-specific configuration.
   * For local transports, base64-encoded and passed as --extra <base64-json> in the argv.
   * For HTTP transports, available in argsMassaging.bodyTemplate as the `extra` binding.
   * Stored with the ref so it travels as a single unit with the invocation descriptor.
   */
  extra?: Record<string, unknown>;
}

// ============================================================================
// ExecutionResult
// ============================================================================

/**
 * Standardized result envelope returned by any execution.
 *
 * Replaces the implicit "file-exists = success, absent = failure" protocol
 * with an explicit status field.  The data ref points to the output blob.
 */
export interface ExecutionResult {
  /** Outcome of the execution. */
  status: 'success' | 'fail' | 'error';

  /**
   * KindValueRef wire form pointing to the output blob.
   * Present only when status === 'success'.
   */
  data?: string;

  /**
   * Human-readable error or failure message.
   * Present when status === 'fail' or 'error'.
   */
  error?: string;
}

// ============================================================================
// ExecutionRef factory helpers
// ============================================================================

/**
 * Create an ExecutionRef from a script path string (e.g. from a --task-executor CLI arg).
 * File extension determines howToRun:
 *   .js / .mjs → 'local-node'
 *   .py        → 'local-python'
 *   other      → 'local-process'
 *
 * @param scriptPath  Absolute or relative path to the script / binary.
 * @param extra       Optional opaque executor config stored on the ref.
 */
export function executionRefFromScriptPath(
  scriptPath: string,
  extra?: Record<string, unknown>,
): ExecutionRef {
  let howToRun: ExecutionRef['howToRun'];
  if (/\.m?js$/i.test(scriptPath)) howToRun = 'local-node';
  else if (/\.py$/i.test(scriptPath)) howToRun = 'local-python';
  else howToRun = 'local-process';
  return {
    meta: 'task-executor',
    howToRun,
    whatToRun: `::fs-path::${scriptPath}`,
    ...(extra ? { extra } : {}),
  };
}

// ============================================================================
// Serialization helpers
// ============================================================================

/**
 * Serialize an ExecutionRef to a JSON string for storage.
 * Plain JSON.stringify — no special encoding.
 */
export function serializeExecutionRef(ref: ExecutionRef): string {
  return JSON.stringify(ref);
}

/**
 * Parse a JSON string back into an ExecutionRef.
 * Throws if the string is not valid JSON or is missing required fields.
 */
export function parseExecutionRef(s: string): ExecutionRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(`parseExecutionRef: invalid JSON — ${s}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).howToRun !== 'string' ||
    typeof (parsed as Record<string, unknown>).whatToRun !== 'string'
  ) {
    throw new Error(`parseExecutionRef: missing required fields howToRun/whatToRun — ${s}`);
  }
  return parsed as ExecutionRef;
}
