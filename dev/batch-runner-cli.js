#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'batch-runner-cli.js', label: 'batch-runner-cli' });
