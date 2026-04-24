#!/usr/bin/env node

/**
 * demo-inference-adapter.js — Demo inference adapter for example-board.
 *
 * Protocol (invoked by board-live-cards-cli):
 *   node demo-inference-adapter.js run-inference --in <input.json> --out <result.json> [--err <error.txt>]
 *
 * Input payload shape:
 *   {
 *     cardId: string,
 *     taskName: string,
 *     completionRule: string,
 *     context: {
 *       requires: object,
 *       sourcesData: object,
 *       computed_values: object,
 *       provides: object,
 *       card_data: object
 *     }
 *   }
 *
 * Output payload shape:
 *   {
 *     isTaskCompleted: boolean,
 *     reason: string,
 *     evidence?: string
 *   }
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function fail(msg, errFile) {
  if (errFile) {
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`[demo-inference-adapter] ${msg}`);
  process.exit(1);
}

function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  if (
    lines.length >= 3 &&
    /^Changes\b/i.test(lines[lines.length - 3]) &&
    /^Requests\b/i.test(lines[lines.length - 2]) &&
    /^Tokens\b/i.test(lines[lines.length - 1])
  ) {
    lines.splice(lines.length - 3, 3);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function resolveCopilotExecutable() {
  const envBin = process.env.COPILOT_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  return 'copilot';
}

function runCopilotPrompt(prompt) {
  const copilotBin = resolveCopilotExecutable();
  const copilotArgs = ['--allow-all'];

  try {
    return execFileSync(copilotBin, copilotArgs, {
      input: String(prompt),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
    });
  } catch (directErr) {
    if (process.platform === 'win32') {
      try {
        return execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
          input: String(prompt),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000,
        });
      } catch (cmdErr) {
        const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
          ? String(directErr.stderr || '')
          : '';
        const stderrCmd = cmdErr && typeof cmdErr === 'object' && 'stderr' in cmdErr
          ? String(cmdErr.stderr || '')
          : '';
        const msg = [stderrDirect.trim(), stderrCmd.trim(), String(cmdErr && cmdErr.message || cmdErr)]
          .filter(Boolean)
          .join(' | ');
        throw new Error(msg || 'copilot invocation failed');
      }
    }

    const stderrDirect = directErr && typeof directErr === 'object' && 'stderr' in directErr
      ? String(directErr.stderr || '')
      : '';
    const msg = [stderrDirect.trim(), String(directErr && directErr.message || directErr)]
      .filter(Boolean)
      .join(' | ');
    throw new Error(msg || 'copilot invocation failed');
  }
}

function extractDecisionFromText(text) {
  const cleaned = stripCopilotFooter(text);
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (parsed && typeof parsed === 'object') {
        // Primary format: isTaskCompleted boolean
        if (typeof parsed.isTaskCompleted === 'boolean') {
          return {
            isTaskCompleted: parsed.isTaskCompleted,
            reason: typeof parsed.reason === 'string' ? parsed.reason : '',
            evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
          };
        }
        // Fallback: status/decision string (backward compat with older prompts)
        const isCompleted = parsed.status === 'task-completed' || parsed.decision === 'task-completed';
        return {
          isTaskCompleted: isCompleted,
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
          evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
        };
      }
    } catch {}
  }

  const lower = cleaned.toLowerCase();
  if (lower.includes('true') || lower.includes('task-completed') || lower.includes('completed')) {
    return { isTaskCompleted: true, reason: 'LLM inferred completion from available evidence.', evidence: '' };
  }
  return { isTaskCompleted: false, reason: 'LLM requested additional evidence before completion.', evidence: '' };
}

function fallbackDecision(payload) {
  const question = String(payload?.completionRule || '').toLowerCase();
  const computed = payload?.context?.computed_values || {};
  const revenue = Number(computed.totalRevenue || 0);
  const deploymentStatus = String(computed.deploymentStatus || payload?.context?.card_data?.deploymentStatus || '').toLowerCase();

  if (question.includes('deployment')) {
    if (deploymentStatus === 'done' || deploymentStatus === 'healthy' || deploymentStatus === 'complete') {
      return { isTaskCompleted: true, reason: 'Deployment signal indicates completion.', evidence: `deploymentStatus=${deploymentStatus}` };
    }
    return { isTaskCompleted: false, reason: 'Deployment completion signal not present yet.', evidence: `deploymentStatus=${deploymentStatus || 'unknown'}` };
  }

  if (question.includes('revenue data is sufficient')) {
    if (revenue >= 60000) {
      return { isTaskCompleted: true, reason: `Revenue evidence is sufficient (${revenue}).`, evidence: `totalRevenue=${revenue}` };
    }
    return { isTaskCompleted: false, reason: `Revenue evidence is below threshold (${revenue}).`, evidence: `totalRevenue=${revenue}` };
  }

  return { isTaskCompleted: false, reason: 'No deterministic rule matched this completion question.', evidence: '' };
}

function buildPrompt(payload) {
  return [
    'You are a strict workflow completion classifier.',
    'Return JSON only with shape: {"isTaskCompleted":true|false,"reason":"..."}.',
    'Set isTaskCompleted to true only when evidence is clearly sufficient.',
    '',
    `Card: ${payload.cardId}`,
    `Task: ${payload.taskName}`,
    `Question: ${payload.completionRule}`,
    '',
    'Context JSON:',
    JSON.stringify(payload.context ?? {}, null, 2),
  ].join('\n');
}

function runInferenceSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const outIdx = argv.indexOf('--out');
  const errIdx = argv.indexOf('--err');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? argv[errIdx + 1] : undefined;

  if (!inFile || !outFile) {
    fail('Usage: run-inference --in <input.json> --out <result.json> [--err <error.txt>]', errFile);
  }

  if (!fs.existsSync(inFile)) {
    fail(`Input file not found: ${inFile}`, errFile);
  }

  let payload;
  try {
    payload = readJson(inFile);
  } catch (err) {
    fail(`Cannot parse input file: ${String(err && err.message || err)}`, errFile);
  }

  let decision = null;
  const prompt = buildPrompt(payload);
  try {
    const llmOutput = runCopilotPrompt(prompt);
    decision = extractDecisionFromText(llmOutput);
  } catch {
    decision = fallbackDecision(payload);
  }

  try {
    fs.writeFileSync(outFile, JSON.stringify(decision, null, 2));
  } catch (err) {
    fail(`Cannot write output file: ${String(err && err.message || err)}`, errFile);
  }

  process.exit(0);
}

function main() {
  const sub = process.argv[2];
  if (sub === 'run-inference') {
    runInferenceSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-inference-adapter] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main();
