#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'artifacts-store-cli.js', label: 'artifacts-store-cli' });
