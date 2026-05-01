#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseRef, blobStorageForRef } from 'yaml-flow/storage-refs';

function parseArgs(argv) {
  const inIdx  = argv.indexOf('--in-ref');
  const outIdx = argv.indexOf('--out-ref');
  const errIdx = argv.indexOf('--err-ref');
  const inRefStr  = inIdx  !== -1 ? argv[inIdx + 1]  : undefined;
  const outRefStr = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errRefStr = errIdx !== -1 ? argv[errIdx + 1] : undefined;
  if (!inRefStr || !outRefStr || !errRefStr) {
    console.error('Usage: <adapter> run-inference --in-ref <::kind::value> --out-ref <::kind::value> --err-ref <::kind::value>');
    process.exit(1);
  }
  const inRef  = parseRef(inRefStr);
  const outRef = parseRef(outRefStr);
  const errRef = parseRef(errRefStr);
  const inStorage  = blobStorageForRef(inRef);
  const outStorage = blobStorageForRef(outRef);
  const errStorage = blobStorageForRef(errRef);
  return { inRef, outRef, errRef, inStorage, outStorage, errStorage };
}

const envBoardDir = (process.env.BOARD_DIR ?? '').trim();

function resolveSyncTmpFileCandidates(payload) {
  const fileName = payload?.context?.card_data?.llm_task_completion_inference?.sync_tmp_file;
  if (typeof fileName !== 'string' || !fileName.trim()) return [];

  const cleaned = fileName.trim();
  if (path.isAbsolute(cleaned)) {
    return [cleaned];
  }

  return [
    envBoardDir ? path.join(envBoardDir, cleaned) : '',
    path.join(process.cwd(), cleaned),
    path.join(process.cwd(), 'board-runtime', cleaned),
    path.join(process.cwd(), '..', 'board-runtime', cleaned),
  ].filter(Boolean);
}

function getReadableTmpFile(tmpCandidates) {
  for (const tmpFile of tmpCandidates) {
    if (!fs.existsSync(tmpFile)) continue;
    const content = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (content) return { tmpFile, content };
  }
  return undefined;
}

function waitForTmpSyncInput(tmpCandidates, timeoutMs = 120000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for sync tmp input'));
      }

      const ready = getReadableTmpFile(tmpCandidates);
      if (!ready) return;

      clearInterval(interval);
      fs.writeFileSync(ready.tmpFile, '', 'utf-8');
      resolve(ready);
    }, 250);
  });
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildRiskAssessment(table, totalValue) {
  const rows = Array.isArray(table) ? table : [];
  const total = toNumber(totalValue);
  const withWeights = rows.map((row) => {
    const v = toNumber(row?.value);
    return { symbol: String(row?.symbol ?? ''), value: v, weight: total > 0 ? v / total : 0 };
  });
  withWeights.sort((a, b) => b.weight - a.weight);
  const largest = withWeights[0] ?? { symbol: 'N/A', weight: 0, value: 0 };
  const concentrationPct = Math.round(largest.weight * 1000) / 10;
  const concentrationFlag = largest.weight > 0.6;
  const breadthFlag = withWeights.length < 3;

  const statusText = concentrationFlag
    ? `High concentration risk: ${largest.symbol} at ${concentrationPct}% of portfolio value.`
    : `Risk appears moderate: largest position ${largest.symbol} at ${concentrationPct}% of portfolio value.`;

  const evidence = [
    `positions=${withWeights.length}`,
    `largest=${largest.symbol}`,
    `largest_weight=${concentrationPct}%`,
    `total_value=${Math.round(total * 100) / 100}`,
    `breadth_ok=${withWeights.length >= 3}`,
    `concentration_ok=${largest.weight <= 0.6}`,
    `risk_flag=${breadthFlag || concentrationFlag}`,
  ].join('; ');

  return { isTaskCompleted: true, reason: statusText, evidence };
}

function buildRebalancingPlan(table, totalValue, riskAssessment) {
  const rows = Array.isArray(table) ? table : [];
  const total = toNumber(totalValue);
  const targetWeight = rows.length > 0 ? 1 / rows.length : 0;
  const moves = rows
    .map((row) => {
      const symbol = String(row?.symbol ?? 'UNKNOWN');
      const currentValue = toNumber(row?.value);
      const currentWeight = total > 0 ? currentValue / total : 0;
      const deltaWeight = targetWeight - currentWeight;
      return {
        symbol,
        currentWeight,
        deltaWeight,
        action: deltaWeight > 0.03 ? 'BUY' : (deltaWeight < -0.03 ? 'SELL' : 'HOLD'),
      };
    })
    .sort((a, b) => Math.abs(b.deltaWeight) - Math.abs(a.deltaWeight));

  const topMoves = moves
    .filter((m) => m.action !== 'HOLD')
    .slice(0, 3)
    .map((m) => `${m.action} ${m.symbol} (${Math.round(m.deltaWeight * 1000) / 10}pp)`);

  const summary = topMoves.length > 0
    ? `Rebalance toward equal-weight profile: ${topMoves.join(', ')}.`
    : 'Current allocations are close to equal-weight; no major rebalance needed.';

  const evidence = [
    `positions=${rows.length}`,
    `target_weight=${Math.round(targetWeight * 1000) / 10}%`,
    `risk_assessment=${typeof riskAssessment === 'string' ? riskAssessment : 'n/a'}`,
  ].join('; ');

  return { isTaskCompleted: true, reason: summary, evidence };
}

async function main() {
  const command = process.argv[2];
  if (command !== 'run-inference') {
    console.error(`Unknown command: ${command ?? '(none)'}`);
    process.exit(1);
  }

  const { inRef, outRef, errRef, inStorage, outStorage, errStorage } = parseArgs(process.argv.slice(3));

  try {
    const rawIn = inStorage.read(inRef.value);
    if (rawIn === null) throw new Error(`Input not found: ${inRef.value}`);
    const payload = JSON.parse(rawIn);
    const tmpCandidates = resolveSyncTmpFileCandidates(payload);
    if (tmpCandidates.length > 0) {
      await waitForTmpSyncInput(tmpCandidates);
    }

    const taskName = String(payload?.taskName ?? '');
    const context = payload?.context ?? {};
    // Inputs arrive under context.requires (the card's declared dependencies)
    const requires = context?.requires ?? {};
    const table = requires?.table?.rows ?? requires?.table;
    const totalValue = requires?.totalValue;
    const riskAssessment = requires?.riskAssessment;

    let result;
    if (taskName === 'portfolio-risk-assessment') {
      result = buildRiskAssessment(table, totalValue);
    } else if (taskName === 'rebalancing-strategy') {
      result = buildRebalancingPlan(table, totalValue, riskAssessment);
    } else {
      result = {
        isTaskCompleted: true,
        reason: `Inference completed for ${taskName || 'unknown-task'}`,
        evidence: 'deterministic-demo-adapter',
      };
    }

    outStorage.write(outRef.value, JSON.stringify(result));
    errStorage.write(errRef.value, '');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errStorage.write(errRef.value, message);
    outStorage.write(outRef.value, JSON.stringify({ isTaskCompleted: false, reason: message, evidence: '' }));
    process.exit(1);
  }
}

void main();
