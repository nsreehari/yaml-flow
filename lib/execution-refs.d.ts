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
 *    • whatToRun   — address of the artifact (KindValueRef wire form: b64:<base64url(json)>)
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
 *    whatToRun: 'b64:<base64url({"kind":"built-in","value":"source-cli-task-executor"})>',
 *  };
 *
 *  // External local-node task executor with default protocol args:
 *  const local: ExecutionRef = {
 *    meta: 'task-executor',
 *    howToRun: 'local-node',
 *    whatToRun: 'b64:<base64url({"kind":"fs-path","value":"/path/to/my-executor.js"})>',
 *  };
 *
 *  // Azure Function task executor with custom arg mapping:
 *  const azureFn: ExecutionRef = {
 *    meta: 'task-executor',
 *    howToRun: 'http:post',
 *    whatToRun: 'b64:<base64url({"kind":"http-url","value":"https://myfn.azurewebsites.net/api/task-executor"})>',
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
 *    whatToRun: 'b64:<base64url({"kind":"http-url","value":"https://myfn.azurewebsites.net/api/chat"})>',
 *    argsMassaging: {
 *      bodyTemplate: "{ 'message': message, 'context': context, 'sessionId': sessionId }",
 *    },
 *  };
 */
/**
 * Optional JSONata-based transforms applied to the raw invoke result.
 * Context for all expressions: `{ output: { result, data, error? } }`.
 * All fields are optional.
 */
interface OutputTransforms {
    /**
     * JSONata expression that produces the transition name string.
     * @example "output.code = 200 ? 'success' : 'failure'"
     */
    resultExpr?: string;
    /**
     * JSONata expression that produces the data object.
     * @example "{ 'value': output.body.value }"
     */
    dataTemplate?: string;
    /**
     * JSONata expression that produces the error string, or $undefined() to clear it.
     * @example "output.code != 200 ? output.error_message : $undefined()"
     */
    errorExpr?: string;
}
/**
 * Optional JSONata-based mapping from logical args → physical invocation shape.
 *
 * Each field is a JSONata expression string evaluated against the caller's
 * logical args object (e.g. `{ inRef, outRef, errRef }` for a task-executor).
 *
 * If argsMassaging is omitted entirely, the execution adapter uses its default
 * mapping for the given howToRun kind.
 */
interface ArgsMassaging {
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
/**
 * Self-contained, serializable descriptor for invoking a target.
 *
 * Stores everything needed to make the physical call — transport kind,
 * artifact address, and optional arg-mapping expressions.
 * Serialize as plain JSON; no special wire encoding required.
 */
interface ExecutionRef {
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
    howToRun: 'local-node' | 'local-python' | 'local-process' | 'http:post' | 'http:get' | 'built-in' | 'in-browser';
    /**
      * Address of the artifact to run. Two valid forms:
      *   - string:  must be KindValueRef wire form `b64:<base64url(json)>` (programmatically generated via serializeRef)
      *   - object:  `{ kind: string; value: string }` plain object (human-authored flow files — normalized by the handler factory)
      * @example 'b64:<base64url({"kind":"fs-path","value":"/dist/cli/source-cli-task-executor.js"})>'
      * @example { kind: 'http-url', value: '/api/workiq/ask' }
      * @example { kind: 'fs-path', value: './my-handler.js' }
     */
    whatToRun: string | {
        kind: string;
        value: string;
    };
    /**
     * Optional JSONata-based mapping from logical args → physical call shape.
     * When omitted, the adapter applies its default protocol for the howToRun kind.
     */
    argsMassaging?: ArgsMassaging;
    /**
     * Optional JSONata-based transforms applied to the raw invoke result
     * before it reaches the step-machine engine.
     *
     * Context for all expressions: `{ output: { result, data, error? } }`
     * where `output` is the raw { result, data, error? } returned by invokeRefSync.
     *
     * All fields are optional — only defined ones override the raw value.
     *
     * @example
     * outputTransforms:
     *   resultExpr:   "output.code = 200 ? 'success' : 'failure'"
     *   dataTemplate: "{ 'value': output.body.value }"
     *   errorExpr:    "output.code != 200 ? output.error_message : $undefined()"
     */
    outputTransforms?: OutputTransforms;
    /**
     * Opaque executor-specific configuration.
     * For local transports, base64-encoded and passed as --extra <base64-json> in the argv.
     * For HTTP transports, available in argsMassaging.bodyTemplate as the `extra` binding.
     * Stored with the ref so it travels as a single unit with the invocation descriptor.
     */
    extra?: Record<string, unknown>;
}
/**
 * Standardized result envelope returned by any execution.
 *
 * Replaces the implicit "file-exists = success, absent = failure" protocol
 * with an explicit status field.  The data ref points to the output blob.
 */
interface ExecutionResult {
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
declare function executionRefFromScriptPath(scriptPath: string, extra?: Record<string, unknown>): ExecutionRef;
/**
 * Serialize an ExecutionRef to a JSON string for storage.
 * Plain JSON.stringify — no special encoding.
 */
declare function serializeExecutionRef(ref: ExecutionRef): string;
/**
 * Parse a JSON string back into an ExecutionRef.
 * Throws if the string is not valid JSON or is missing required fields.
 */
declare function parseExecutionRef(s: string): ExecutionRef;

export { type ArgsMassaging, type ExecutionRef, type ExecutionResult, type OutputTransforms, executionRefFromScriptPath, parseExecutionRef, serializeExecutionRef };
