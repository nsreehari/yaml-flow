/**
 * Inference — Built-in Adapter Factories
 *
 * Ready-made adapter constructors for common LLM interfaces.
 * Each returns an InferenceAdapter.
 *
 * CLI adapters spawn a child process and capture stdout.
 * HTTP adapters POST to an endpoint and read the response.
 */

import { execFile } from 'node:child_process';
import type { InferenceAdapter } from './types.js';

// ============================================================================
// CLI Adapter — execute any local command
// ============================================================================

export interface CliAdapterOptions {
  /** The command to execute (e.g., 'gh', 'ollama', 'llm') */
  command: string;
  /**
   * Arguments builder: receives the prompt and returns the args array.
   * The prompt is passed as an argument — NOT via stdin — unless you override.
   *
   * @example gh copilot:  (prompt) => ['copilot', 'suggest', '-t', 'shell', prompt]
   * @example ollama:      (prompt) => ['run', 'llama3', prompt]
   * @example llm cli:     (prompt) => ['--model', 'gpt-4o', prompt]
   */
  args: (prompt: string) => string[];
  /** Max execution time in ms (default: 60000) */
  timeout?: number;
  /** Working directory for the child process */
  cwd?: string;
  /** Environment variables to pass to the child process */
  env?: Record<string, string>;
  /**
   * If true, pass the prompt via stdin instead of as a CLI argument.
   * Useful for long prompts that exceed shell argument limits.
   * Default: false
   */
  stdin?: boolean;
}

/**
 * Create an InferenceAdapter that executes a local CLI command.
 * The prompt is passed as a CLI argument (or via stdin if opts.stdin=true).
 * stdout is captured as the LLM response.
 *
 * @example
 * // GitHub Copilot CLI
 * const adapter = createCliAdapter({
 *   command: 'gh',
 *   args: (prompt) => ['copilot', 'suggest', '-t', 'shell', prompt],
 * });
 *
 * @example
 * // Ollama (local LLM)
 * const adapter = createCliAdapter({
 *   command: 'ollama',
 *   args: (prompt) => ['run', 'llama3', prompt],
 * });
 *
 * @example
 * // Simon Willison's llm CLI
 * const adapter = createCliAdapter({
 *   command: 'llm',
 *   args: (prompt) => ['--model', 'gpt-4o', prompt],
 * });
 *
 * @example
 * // Any script (stdin mode for long prompts)
 * const adapter = createCliAdapter({
 *   command: 'python',
 *   args: () => ['my_llm_script.py'],
 *   stdin: true,
 * });
 */
export function createCliAdapter(opts: CliAdapterOptions): InferenceAdapter {
  const timeout = opts.timeout ?? 60_000;

  return {
    analyze: (prompt: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        const args = opts.args(prompt);

        const child = execFile(
          opts.command,
          opts.stdin ? opts.args('') : args,
          {
            timeout,
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
            maxBuffer: 10 * 1024 * 1024, // 10MB
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(
                `CLI adapter failed: ${opts.command} exited with ${error.code ?? 'error'}` +
                (stderr ? `\nstderr: ${stderr.slice(0, 500)}` : '') +
                `\n${error.message}`,
              ));
            } else {
              resolve(stdout);
            }
          },
        );

        // If stdin mode, write the prompt to the child's stdin
        if (opts.stdin && child.stdin) {
          child.stdin.write(prompt);
          child.stdin.end();
        }
      });
    },
  };
}

// ============================================================================
// HTTP Adapter — POST to any endpoint
// ============================================================================

export interface HttpAdapterOptions {
  /** The endpoint URL to POST to */
  url: string;
  /** Additional headers (Authorization, etc.) */
  headers?: Record<string, string>;
  /**
   * Build the request body from the prompt.
   * Default: `{ prompt }`
   */
  buildBody?: (prompt: string) => unknown;
  /**
   * Extract the response text from the parsed JSON response.
   * Default: `(json) => json.response ?? json.text ?? json.content ?? JSON.stringify(json)`
   */
  extractResponse?: (json: Record<string, unknown>) => string;
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
}

/**
 * Create an InferenceAdapter that POSTs to an HTTP endpoint.
 *
 * @example
 * // Ollama HTTP API
 * const adapter = createHttpAdapter({
 *   url: 'http://localhost:11434/api/generate',
 *   buildBody: (prompt) => ({ model: 'llama3', prompt, stream: false }),
 *   extractResponse: (json) => json.response as string,
 * });
 *
 * @example
 * // Custom API with auth
 * const adapter = createHttpAdapter({
 *   url: 'https://my-llm.example.com/analyze',
 *   headers: { Authorization: `Bearer ${process.env.API_KEY}` },
 * });
 */
export function createHttpAdapter(opts: HttpAdapterOptions): InferenceAdapter {
  const timeout = opts.timeout ?? 60_000;

  return {
    analyze: async (prompt: string): Promise<string> => {
      const body = opts.buildBody ? opts.buildBody(prompt) : { prompt };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        }

        const json = await response.json() as Record<string, unknown>;

        if (opts.extractResponse) {
          return opts.extractResponse(json);
        }

        // Default extraction: try common response fields
        if (typeof json.response === 'string') return json.response;
        if (typeof json.text === 'string') return json.text;
        if (typeof json.content === 'string') return json.content;
        return JSON.stringify(json);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
