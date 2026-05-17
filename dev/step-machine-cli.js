#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'step-machine-cli.js', label: 'step-machine-cli' });

