#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'board-live-cards-cli.js', label: 'board-live-cards-cli' });