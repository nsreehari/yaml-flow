#!/usr/bin/env node

import { log_it } from './shared_helpers.js';
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
  '  cat payload.json | node preflight-materialize-candidate-card.js',
  '',
  'Required payload shape:',
  '  { "candidate_card_content": <card>, "mock_requires": {...}, "mock_fetched_sources": {...} }',
];

function main() {
  const argv = process.argv.slice(2);
  log_it('preflight-materialize-candidate-card.js', argv.join(' '));
  const args = parseArgs(argv);
  if (isHelpRequested(args)) {
    printUsage(usageLines, 0);
  }

  const payload = readCandidateCardPayload(usageLines, ['mock_requires', 'mock_fetched_sources']);
  const result = runBoardLiveCardsCli('eval-card-compute', [], payload);
  printJson(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
