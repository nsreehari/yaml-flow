import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

export interface LocalNodeExecutionRef {
  whatToRun: string;
  extra?: Record<string, unknown>;
}

export function reportBoardWorkerCallbackLocalNodeSuccess(via: LocalNodeExecutionRef, token: string, ref: string): void {
  runBoardWorkerCallbackLocalNode(via, [
    'source-data-fetched',
    '--ref', ref,
    '--token', token,
  ], 'reportComplete');
}

export function reportBoardWorkerCallbackLocalNodeFailure(via: LocalNodeExecutionRef, token: string, reason: string): void {
  runBoardWorkerCallbackLocalNode(via, [
    'source-data-fetch-failure',
    '--token', token,
    '--reason', reason,
  ], 'reportFailed');
}

function runBoardWorkerCallbackLocalNode(
  via: LocalNodeExecutionRef,
  callbackArgs: string[],
  label: 'reportComplete' | 'reportFailed',
): void {
  const scriptPath = parseWhatToRun(via.whatToRun);
  const { cmd, args } = resolveLocalNodeInvocation(scriptPath);
  const notifyChannel = notifyChannelFromVia(via);
  const result = spawnSync(cmd, [
    ...args,
    ...callbackArgs,
    ...(notifyChannel ? ['--notify-channel', notifyChannel] : []),
  ], { encoding: 'utf-8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label}: board CLI exited ${result.status}: ${result.stderr?.trim()}`);
  }
}

function parseWhatToRun(whatToRun: string): string {
  const parsed = parseRef(whatToRun);
  if (parsed.kind === 'yaml-flow-cli') {
    const trimmed = path.basename(parsed.value.trim());
    if (!trimmed) {
      throw new Error(`Invalid yaml-flow-cli ref: expected non-empty cli file name, got ${JSON.stringify(parsed.value)}`);
    }
    const packageRoot = path.dirname(require.resolve('yaml-flow/package.json'));
    const stem = trimmed.replace(/\.[^.]+$/, '');
    const bundled = path.join(packageRoot, 'cli', 'bundled', `${stem}.mjs`);
    if (fs.existsSync(bundled)) return bundled;
    const legacy = path.join(packageRoot, 'cli', 'node', trimmed);
    if (fs.existsSync(legacy)) return legacy;
    throw new Error(`Invalid yaml-flow-cli ref: could not find ${trimmed} under cli/bundled or cli/node in ${packageRoot}`);
  }
  return parsed.value;
}

function notifyChannelFromVia(via: LocalNodeExecutionRef): string | undefined {
  const candidate = via.extra?.['notifyChannel'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function resolveLocalNodeInvocation(scriptPath: string): { cmd: string; args: string[] } {
  if (!scriptPath.endsWith('.ts')) {
    return { cmd: process.execPath, args: [scriptPath] };
  }
  const dir = path.dirname(scriptPath);
  const candidates: string[] = [];
  for (let up = 1; up <= 5; up++) {
    const base = path.join(dir, ...Array(up).fill('..'), 'node_modules');
    candidates.push(path.join(base, 'tsx', 'dist', 'cli.mjs'));
    candidates.push(path.join(base, '.bin', 'tsx'));
  }
  const tsx = candidates.find(p => fs.existsSync(p));
  if (tsx) return { cmd: process.execPath, args: [tsx, scriptPath] };
  return { cmd: 'npx', args: ['tsx', scriptPath] };
}

function parseRef(s: string): { kind: string; value: string } {
  if (!s.startsWith('b64:')) throw new Error(`Invalid ref format (expected b64:<base64url(json)>): ${s}`);
  const payload = s.slice(4);
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    throw new Error(`Invalid ref format (malformed base64url/json): ${s}`);
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new Error(`Invalid ref format (expected object payload): ${s}`);
  }
  const candidate = decoded as { kind?: unknown; value?: unknown };
  if (typeof candidate.kind !== 'string' || typeof candidate.value !== 'string') {
    throw new Error(`Invalid ref format (payload must contain string kind/value): ${s}`);
  }
  return { kind: candidate.kind, value: candidate.value };
}