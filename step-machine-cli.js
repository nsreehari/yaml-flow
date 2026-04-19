#!/usr/bin/env node

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import jsonata from 'jsonata';

const { loadStepFlow, createEngine } = await import('./dist/index.js');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const flowArg = args[0];
  const handlersArg = getFlagValue(args, '--handlers');
  const dataArg = getFlagValue(args, '--data');

  if (!flowArg) {
    printUsage();
    process.exit(1);
  }

  const flowPath = resolveInputPath(flowArg);
  const flowDir = path.dirname(flowPath);
  const handlersPath = handlersArg ? resolveInputPath(handlersArg) : undefined;
  const initialData = parseInitialData(dataArg);

  const flow = await loadStepFlow(flowPath);
  const inlineHandlers = handlersPath ? await loadHandlers(handlersPath) : {};
  const handlers = buildStepHandlers(flow, inlineHandlers, flowDir, flow.handler_vars);

  const machine = createEngine(flow, handlers);
  const result = await machine.run(initialData);

  if (result.status !== 'completed') {
    const reason = result.error?.message ?? result.intent ?? result.status;
    console.error(`[step-machine-cli] Run failed: ${reason}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    runId: result.runId,
    status: result.status,
    intent: result.intent,
    finalStep: result.finalStep,
    stepHistory: result.stepHistory,
    data: result.data,
  }, null, 2));
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function resolveInputPath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(process.cwd(), inputPath);
}

function parseInitialData(dataArg) {
  if (!dataArg) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(dataArg);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Initial data must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`[step-machine-cli] Invalid --data value: ${msg}`);
  }
}

async function loadHandlers(handlersPath) {
  const mod = await import(pathToFileURL(handlersPath).href);
  const candidate = mod.default ?? mod.handlers ?? mod;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('[step-machine-cli] Handlers module must export an object map of stepName -> function.');
  }

  for (const [stepName, handler] of Object.entries(candidate)) {
    if (typeof handler !== 'function') {
      throw new Error(`[step-machine-cli] Handler for step "${stepName}" is not a function.`);
    }
  }

  return candidate;
}

function buildStepHandlers(flow, inlineHandlers, flowDir, handlerVars) {
  const handlers = {};

  for (const [stepName, stepConfig] of Object.entries(flow.steps ?? {})) {
    handlers[stepName] = resolveStepHandler(stepName, stepConfig, inlineHandlers, flowDir, handlerVars);
  }

  return handlers;
}

function resolveStepHandler(stepName, stepConfig, inlineHandlers, flowDir, handlerVars) {
  const produces = Array.isArray(stepConfig?.produces_data) ? stepConfig.produces_data : undefined;
  const spec = stepConfig?.handler;

  if (isCliSpec(spec)) {
    const base = createCliStepHandler(spec, flowDir, stepName, handlerVars);
    return wrapWithOutputFiltering(base, produces);
  }

  if (isInlineSpec(spec)) {
    const inlineName = spec.inline;
    const handler = inlineHandlers[inlineName];
    if (typeof handler !== 'function') {
      throw new Error(`[step-machine-cli] Inline handler "${inlineName}" for step "${stepName}" was not found in --handlers module.`);
    }
    return wrapWithOutputFiltering(handler, produces);
  }

  // Default behavior is explicit and predictable: no configured handler means passthrough.
  return wrapWithOutputFiltering(createPassthroughHandler(), produces);
}

function isCliSpec(spec) {
  return !!spec && typeof spec === 'object' && typeof spec.cli === 'string' && spec.cli.trim().length > 0;
}

function isInlineSpec(spec) {
  return !!spec && typeof spec === 'object' && typeof spec.inline === 'string' && spec.inline.trim().length > 0;
}

function createCliStepHandler(spec, flowDir, stepName, handlerVars) {
  return async (input) => {
    const stepInput = input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {};

    const resolvedHandlerVars = await evaluateTransforms(
      handlerVars,
      stepInput,
      stepName,
      'handler_vars',
    );

    const inputTransforms = await evaluateTransforms(
      spec['input-transforms'],
      { ...stepInput, ...resolvedHandlerVars },
      stepName,
      'input-transforms',
    );

    const effectiveInput = { ...stepInput, ...resolvedHandlerVars, ...inputTransforms };
    const command = applyCommandTemplate(spec.cli, effectiveInput, stepName);

    const payload = JSON.stringify(effectiveInput);
    const result = spawnSync(command, {
      cwd: flowDir,
      shell: true,
      input: payload,
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (result.error) {
      return {
        result: 'failure',
        data: { error: `[step-machine-cli] step "${stepName}" failed to start: ${result.error.message}` },
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = (result.stderr ?? '').trim();
    const resultMode = String(spec['result-mode'] ?? 'json').toLowerCase();

    if (result.status !== 0) {
      return {
        result: 'failure',
        data: {
          error: `[step-machine-cli] step "${stepName}" exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
        },
      };
    }

    if (resultMode === 'exit-code') {
      const outputTransforms = await evaluateTransforms(
        spec['output-transforms'],
        {
          ...effectiveInput,
          result: 'success',
          stdout,
          stderr,
        },
        stepName,
        'output-transforms',
      );

      return {
        result: 'success',
        data: outputTransforms,
      };
    }

    try {
      const parsed = parseJsonOutput(stdout);
      const normalized = normalizeHandlerResult(parsed, stepName);
      const outputTransforms = await evaluateTransforms(
        spec['output-transforms'],
        {
          ...effectiveInput,
          result: normalized.result,
          data: normalized.data,
        },
        stepName,
        'output-transforms',
      );

      if (Object.keys(outputTransforms).length === 0) {
        return normalized;
      }

      return {
        result: normalized.result,
        data: outputTransforms,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        result: 'failure',
        data: {
          error: `[step-machine-cli] step "${stepName}" returned invalid JSON on stdout: ${msg}`,
        },
      };
    }
  };
}

async function evaluateTransforms(transformSpec, source, stepName, label) {
  if (transformSpec === undefined || transformSpec === null) {
    return {};
  }

  if (!transformSpec || typeof transformSpec !== 'object' || Array.isArray(transformSpec)) {
    throw new Error(`[step-machine-cli] Step "${stepName}" ${label} must be an object map of key -> JSONata expression.`);
  }

  const result = {};
  for (const [key, expression] of Object.entries(transformSpec)) {
    if (typeof expression !== 'string') {
      // Non-string values are treated as literals for convenience.
      result[key] = expression;
      continue;
    }

    if (expression.trim().length === 0) {
      throw new Error(`[step-machine-cli] Step "${stepName}" ${label}.${key} must be a non-empty string expression.`);
    }

    // handler_vars defaults to literal strings for ergonomics; use "=..." for JSONata expressions.
    if (label === 'handler_vars' && !expression.startsWith('=')) {
      result[key] = expression;
      continue;
    }

    const jsonataExpression = label === 'handler_vars' && expression.startsWith('=')
      ? expression.slice(1)
      : expression;

    // Convenience: direct key aliasing supports non-identifier keys like BOARD-DIR-NAME.
    if (Object.prototype.hasOwnProperty.call(source, jsonataExpression)) {
      result[key] = source[jsonataExpression];
      continue;
    }

    try {
      const compiled = jsonata(jsonataExpression);
      result[key] = await compiled.evaluate(source);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`[step-machine-cli] Step "${stepName}" ${label}.${key} failed: ${msg}`);
    }
  }

  return result;
}

function applyCommandTemplate(command, source, stepName) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(`[step-machine-cli] Step "${stepName}" handler.cli must be a non-empty command string.`);
  }

  return command.replace(/%%([A-Za-z0-9_-]+)%%/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      throw new Error(`[step-machine-cli] Step "${stepName}" command placeholder ${full} has no matching input or input-transform value.`);
    }

    const value = source[key];
    if (value === undefined || value === null) {
      throw new Error(`[step-machine-cli] Step "${stepName}" command placeholder ${full} resolved to empty value.`);
    }

    return String(value);
  });
}

function createPassthroughHandler() {
  return async (input) => {
    const data = input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {};

    return {
      result: 'success',
      data,
    };
  };
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('empty stdout');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  }
}

function wrapWithOutputFiltering(handler, produces) {
  return async (input, context) => {
    const raw = await handler(input, context);
    const normalized = normalizeHandlerResult(raw, context?.stepName ?? 'unknown');
    const filteredData = filterProducedData(normalized.data, produces);
    return {
      result: normalized.result,
      data: filteredData,
    };
  };
}

function normalizeHandlerResult(raw, stepName) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[step-machine-cli] Step "${stepName}" returned a non-object result.`);
  }

  const result = raw.result ?? raw.status;
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`[step-machine-cli] Step "${stepName}" result must include a non-empty "result" (or "status") string.`);
  }

  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data
    : {};

  const error = typeof raw.error === 'string' ? raw.error : undefined;
  if (error && !('error' in data)) {
    data.error = error;
  }

  return { result, data };
}

function filterProducedData(data, produces) {
  if (!produces || produces.length === 0) {
    return data;
  }

  const filtered = {};
  for (const key of produces) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      filtered[key] = data[key];
    }
  }
  return filtered;
}

function printUsage() {
  console.error('Usage: step-machine-cli <step-flow.yaml> [--handlers <step-handlers.js>] [--data <json>]');
  console.error('');
  console.error('Example:');
  console.error('  step-machine-cli examples/step-machine-demo/two-step-mixed.flow.yaml --handlers examples/step-machine-demo/two-step-mixed-handlers.js --data "{\"a\":3,\"b\":4}"');
}

main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(msg);
  process.exit(1);
});
