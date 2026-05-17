#!/usr/bin/env node

import { runDevCli } from './run-dev-cli.js';

await runDevCli({ cliFileName: 'chat-store-cli.js', label: 'chat-store' });
