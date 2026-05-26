#!/usr/bin/env node

import { log_it } from './shared_helpers.js';
import { readKnownBaseRef } from './shared_helpers.js';
import {
  isHelpRequested,
  parseArgs,
  printJson,
  printUsage,
  readCandidateCardPayload,
  runBoardLiveCardsCli,
} from './preflight-candidate-card-common.js';

const usageLines = [
  'Usage:',
  '  cat payload.json | node preflight-run-one-cycle-with-candidate-card.js',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card>, "mock_requires": {...} }',
];

function main() {
  const argv = process.argv.slice(2);
  log_it('preflight-run-one-cycle-with-candidate-card.js', argv.join(' '));
  const args = parseArgs(argv);
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const baseRef = readKnownBaseRef();
  const payload = readCandidateCardPayload(usageLines, ['mock_requires']);
  const result = runBoardLiveCardsCli('simulate-card-cycle', ['--base-ref', baseRef], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
