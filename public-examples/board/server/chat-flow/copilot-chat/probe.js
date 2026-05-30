#!/usr/bin/env node

import { readJsonStdin } from './shared.js';

const input = readJsonStdin();
const userText = typeof input.userText === 'string' ? input.userText : '';
process.stdout.write(JSON.stringify({ replyText: `Echo: ${userText}` }));