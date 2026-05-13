#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

const DEFAULT_PROMPT_CONTEXT = {
  view_kind_guidance: [
    'VIEW KIND GUIDANCE (for dynamic ref rendering):',
    '- Return a _view object whenever your output data is meant for a ref element.',
    '- Allowed _view.kind values only: table, editable-table, chart, metric, list, badge, text, narrative, markdown, form, filter, todo, alert.',
    '- If uncertain, use "table".',
    '- For array rows that users should edit, prefer "editable-table" and set _view.data.writeTo to a card_data path.',
    '- For chart, set _view.data.chartType and _view.data.columns with [labelField, valueField].',
    '- Keep _view.data minimal and valid JSON (no comments, no trailing text).',
  ].join('\n'),
  card_layout_guidance: [
    'CARD LAYOUT GUIDANCE:',
    '- Prefer compact outputs that fit a card: one primary structure plus concise rationale text.',
    '- Avoid repeating values already present in upstream inputs.',
    '- If you produce both machine-readable and human-readable content, keep machine-readable fields top-level and concise prose in a separate field.',
  ].join('\n'),
};

function resolvePrompt(sourceDef, promptContext) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  if (!template || typeof template !== 'string') return null;
  const args = {
    ...(promptContext || DEFAULT_PROMPT_CONTEXT),
    ...(sourceDef?._projections || {}),
    ...(cfg.args || sourceDef.args || {}),
  };
  return interpolate(template, args);
}

function runCopilot(prompt, sourceDef, executorDir, extra) {
  const wrapperPath = path.join(executorDir, 'scripts', 'copilot_wrapper.bat');
  if (process.platform === 'win32' && fs.existsSync(wrapperPath)) {
    const tmpBase = path.join(process.env.TEMP || process.cwd(), `copilot-handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const outFile = `${tmpBase}.out.json`;
    const promptFile = `${tmpBase}.prompt.txt`;
    const sessionDir = path.join(
      extra?.boardSetupRoot || (process.env.TEMP || process.cwd()),
      'copilot-sessions',
      String(sourceDef?.bindTo || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(promptFile, prompt, 'utf-8');

    let shapeFile = '';
    const shape = sourceDef?.copilot?.result_shape ?? sourceDef?.result_shape;
    if (shape && typeof shape === 'object') {
      shapeFile = `${tmpBase}.shape.json`;
      fs.writeFileSync(shapeFile, JSON.stringify(shape), 'utf-8');
    }

    try {
      execFileSync('cmd.exe', [
        '/d', '/c',
        wrapperPath,
        outFile,
        sessionDir,
        extra?.boardSetupRoot || process.cwd(),
        `@${promptFile}`,
        'json',
        String(sourceDef?.bindTo || 'executor'),
        '',
        shapeFile,
      ], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(fs.readFileSync(outFile, 'utf-8').replace(/^\uFEFF/, ''));
    } finally {
      try { fs.unlinkSync(promptFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      if (shapeFile) { try { fs.unlinkSync(shapeFile); } catch {} }
    }
  }

  const stdout = execFileSync('copilot', ['--allow-all'], {
    input: prompt,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
    cwd: extra?.boardSetupRoot || process.cwd(),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  const firstBrace = stdout.indexOf('{');
  const firstBracket = stdout.indexOf('[');
  let jsonStart = -1;
  if (firstBrace === -1) jsonStart = firstBracket;
  else if (firstBracket === -1) jsonStart = firstBrace;
  else jsonStart = Math.min(firstBrace, firstBracket);

  if (jsonStart !== -1) {
    try {
      return JSON.parse(stdout.slice(jsonStart));
    } catch {
      return stdout;
    }
  }
  return stdout;
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const extra = context?.extra || {};
  const executorDir = context?.executorDir || process.cwd();
  const promptContext = context?.promptContext || DEFAULT_PROMPT_CONTEXT;

  const prompt = resolvePrompt(sourceDef, promptContext);
  if (!prompt) {
    return {
      result: 'failure',
      data: { error: 'Source definition missing copilot.prompt_template (or prompt_template)' },
      error: 'missing prompt_template',
    };
  }

  try {
    const resultValue = runCopilot(prompt, sourceDef, executorDir, extra);
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = String(err?.message || err);
    return { result: 'failure', data: { error: `copilot invocation failed: ${msg}` }, error: msg };
  }
}
