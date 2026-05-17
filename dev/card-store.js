#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'card-store-cli.js', label: 'card-store' });
