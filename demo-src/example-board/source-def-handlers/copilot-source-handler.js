import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

function resolveCopilotPrompt(sourceDef, promptContext) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};

  const interpolationContext = {
    ...(promptContext || {}),
    ...sourceDef._projections,
    ...args,
  };

  if (!template || typeof template !== 'string') return null;
  return interpolate(template, interpolationContext);
}

function runCopilotViaWrapper(prompt, sourceDef, wrapperOutFile, sessionDir, cwd, scriptsDir) {
  const wrapperPath = path.join(scriptsDir, 'copilot_wrapper.bat');
  const promptFile = wrapperOutFile + '.prompt.txt';
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  let shapeFile = '';
  const shape = sourceDef?.copilot?.result_shape ?? sourceDef?.result_shape;
  if (shape && typeof shape === 'object') {
    shapeFile = wrapperOutFile + '.shape.json';
    fs.writeFileSync(shapeFile, JSON.stringify(shape), 'utf-8');
  }

  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    execFileSync('cmd.exe', [
      '/d', '/c',
      wrapperPath,
      wrapperOutFile,
      sessionDir,
      cwd || process.cwd(),
      '@' + promptFile,
      'json',
      sourceDef.bindTo || 'executor',
      '',
      shapeFile,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    if (shapeFile) {
      try { fs.unlinkSync(shapeFile); } catch {}
    }
  }

  return JSON.parse(fs.readFileSync(wrapperOutFile, 'utf-8').replace(/^\uFEFF/, ''));
}

export async function execute(context) {
  const sourceDef = context.sourceDef;
  const extra = context.extra || {};

  const prompt = resolveCopilotPrompt(sourceDef, context.promptContext || {});
  if (!prompt) {
    return {
      result: 'failure',
      data: { error: 'Source definition missing copilot.prompt_template (or prompt_template)' },
      error: 'missing prompt_template',
    };
  }

  const copilotCwd = extra.boardSetupRoot || undefined;
  const scriptsDir = path.join(context.executorDir, 'scripts');
  const wrapperPath = path.join(scriptsDir, 'copilot_wrapper.bat');
  const useWrapper = process.platform === 'win32' && fs.existsSync(wrapperPath);

  try {
    if (useWrapper) {
      const sessionDir = path.join(
        extra.boardSetupRoot || os.tmpdir(),
        'copilot-sessions',
        String(sourceDef.bindTo || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      const wrapperOutFile = context.outRef.value + '.wrapper-out.json';
      try {
        const resultValue = runCopilotViaWrapper(prompt, sourceDef, wrapperOutFile, sessionDir, copilotCwd, scriptsDir);
        return { result: 'success', data: { resultValue } };
      } finally {
        try { fs.unlinkSync(wrapperOutFile); } catch {}
      }
    }

    const rawOutput = execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
      input: String(prompt),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      ...(copilotCwd ? { cwd: copilotCwd } : {}),
    });

    const firstBrace = rawOutput.indexOf('{');
    const firstBracket = rawOutput.indexOf('[');
    const jsonStart = (firstBrace === -1)
      ? firstBracket
      : (firstBracket === -1)
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(rawOutput.slice(jsonStart));
        return {
          result: 'success',
          data: { resultValue: (parsed && typeof parsed === 'object') ? parsed : rawOutput },
        };
      } catch {
        return { result: 'success', data: { resultValue: rawOutput } };
      }
    }

    return { result: 'success', data: { resultValue: rawOutput } };
  } catch (err) {
    const message = String(err && err.message || err);
    return { result: 'failure', data: { error: `copilot invocation failed: ${message}` }, error: message };
  }
}
