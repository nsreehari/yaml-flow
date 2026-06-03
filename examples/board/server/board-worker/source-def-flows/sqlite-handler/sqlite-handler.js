#!/usr/bin/env node

/**
 * sqlite-handler.js — Query a SQLite database via the local query.cjs helper.
 *
 * DB filename is resolved relative to the configured defaultDbDir.
 * Supports SELECT (returns row array) and exec mode for INSERT/UPDATE/DELETE.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_CONFIG_FILE = path.join(HANDLER_DIR, 'sqlite-config.json');
const SQLITE_QUERY_SCRIPT = path.join(HANDLER_DIR, 'query.cjs');

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadSqliteConfig() {
  try {
    return readJson(SQLITE_CONFIG_FILE);
  } catch {
    return {};
  }
}

function resolveDbPath(dbRef, config) {
  if (path.isAbsolute(dbRef) || dbRef.includes(path.sep) || dbRef.includes('/')) {
    return path.resolve(dbRef);
  }
  const defaultDbDir = typeof config.defaultDbDir === 'string'
    ? path.resolve(HANDLER_DIR, config.defaultDbDir)
    : path.resolve(HANDLER_DIR, '.retain');
  return path.join(defaultDbDir, dbRef);
}

export async function execute(context) {
  const sourceDef = context?.sourceDef || {};
  const handlerConfig = loadSqliteConfig();

  const cfg = typeof sourceDef.sqlite === 'object' ? sourceDef.sqlite : {};
  if (!cfg.db || !cfg.query) {
    return { result: 'failure', data: { error: 'sqlite: db and query are required' }, error: 'missing db/query' };
  }

  const dbPath = resolveDbPath(cfg.db, handlerConfig);
  const cliArgs = ['--db', dbPath, '--sql', cfg.query];
  if (cfg.params) {
    const resolvedParams = Array.isArray(cfg.params)
      ? cfg.params.map(p => typeof p === 'string' ? interpolate(p, sourceDef._projections || {}) : p)
      : [];
    cliArgs.push('--params', JSON.stringify(resolvedParams));
  }
  if (cfg.mode === 'exec') {
    cliArgs.push('--mode', 'exec');
  }

  try {
    const raw = execFileSync(process.execPath, [SQLITE_QUERY_SCRIPT, ...cliArgs], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      cwd: process.cwd(),
      windowsHide: true,
    });
    const resultValue = raw.trim() ? JSON.parse(raw) : [];
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
    return { result: 'failure', data: { error: `sqlite query failed: ${msg}` }, error: msg };
  }
}
