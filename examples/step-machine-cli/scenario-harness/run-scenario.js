#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf-8');
  if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
    return YAML.parse(raw);
  }
  return JSON.parse(raw);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch;

  const merged = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      merged[k] = deepMerge(base[k], v);
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function main() {
  const scenarioArg = process.argv[2];
  if (!scenarioArg) {
    console.error('Usage: node run-scenario.js <scenario.json|scenario.yaml>');
    process.exit(1);
  }

  const scenarioPath = path.resolve(process.cwd(), scenarioArg);
  if (!fs.existsSync(scenarioPath)) {
    console.error(`Scenario file not found: ${scenarioPath}`);
    process.exit(1);
  }

  const scenarioDir = path.dirname(scenarioPath);
  const scenario = readConfig(scenarioPath);
  const flowPath = path.resolve(scenarioDir, scenario.flow);
  const inputPath = path.resolve(scenarioDir, scenario.input);

  if (!fs.existsSync(flowPath)) {
    console.error(`Flow file not found: ${flowPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const mergedInput = deepMerge(baseInput, scenario.overrides ?? {});

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const stepMachineCli = path.join(repoRoot, 'step-machine-cli.js');

  console.log(`[scenario-harness] Running scenario: ${scenario.id ?? path.basename(scenarioPath)}`);
  console.log(`[scenario-harness] Flow: ${flowPath}`);

  const result = spawnSync(
    process.execPath,
    [stepMachineCli, flowPath, '--data', JSON.stringify(mergedInput)],
    {
      cwd: path.dirname(flowPath),
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        BOARD_LIVE_CARDS_NO_SPAWN: process.env.BOARD_LIVE_CARDS_NO_SPAWN ?? '1',
      },
    }
  );

  if (result.error) {
    console.error(`[scenario-harness] Failed to run scenario: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

main();
