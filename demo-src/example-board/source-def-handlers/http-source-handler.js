import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CACHE_DIR = path.join(os.tmpdir(), 'demo-executor-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

function cacheKey(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function readCache(key, ttlMs = CACHE_TTL_MS) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}
  return null;
}

function writeCache(key, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch {}
}

function curlFetchJson(url, method, headers) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = ['-s', '-S', '-f', '-L', '--max-time', '10', '-X', method];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  const raw = execFileSync(bin, args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(raw);
}

function doFetchApi(url, method, headers, cacheTimeoutSec) {
  const ttlMs = cacheTimeoutSec != null ? cacheTimeoutSec * 1000 : CACHE_TTL_MS;
  const k = cacheKey(`url:${method}:${url}`);
  const cached = readCache(k, ttlMs);
  if (cached) {
    console.warn(`[demo-task-executor] url: cache hit for ${url}`);
    return cached;
  }
  const data = curlFetchJson(url, method, headers);
  writeCache(k, data);
  return data;
}

function resolveTickersArg(sourceDef, fetchArgs) {
  if (!sourceDef.tickersFrom) return;
  const dotIdx = sourceDef.tickersFrom.indexOf('.');
  if (dotIdx <= 0) return;
  const refKey = sourceDef.tickersFrom.slice(0, dotIdx);
  const fieldName = sourceDef.tickersFrom.slice(dotIdx + 1);
  const arr = sourceDef._projections?.[refKey];
  if (!Array.isArray(arr)) return;
  fetchArgs.tickers = arr.map((row) => row?.[fieldName]).filter(Boolean).join(',');
}

async function executeUrl(sourceDef) {
  const cfg = sourceDef.url;
  const method = (cfg.method || 'GET').toUpperCase();
  const headers = { ...(cfg.headers || {}) };
  const cacheTimeoutSec = cfg.cacheTimeout != null ? Number(cfg.cacheTimeout) : null;
  const fetchArgs = { ...(cfg.args || {}) };

  resolveTickersArg(sourceDef, fetchArgs);
  if (sourceDef.tickersFrom && !fetchArgs.tickers) {
    throw new Error('url: tickersFrom resolved to empty list - skipping fetch');
  }

  const urlContext = { ...(sourceDef._projections || {}), ...fetchArgs };
  const url = interpolate(cfg.url, urlContext);
  return {
    result: 'success',
    data: { resultValue: doFetchApi(url, method, headers, cacheTimeoutSec) },
  };
}

async function executeUrlList(sourceDef) {
  const cfg = sourceDef['url-list'];
  const method = (cfg.method || 'GET').toUpperCase();
  const headers = { ...(cfg.headers || {}) };
  const cacheTimeoutSec = cfg.cacheTimeout != null ? Number(cfg.cacheTimeout) : null;

  const urlList = Array.isArray(sourceDef._projections?.url_list)
    ? sourceDef._projections.url_list
    : null;

  if (!urlList || urlList.length === 0) {
    throw new Error('url-list: _projections.url_list must be a non-empty string array');
  }

  const results = [];
  for (const u of urlList) {
    try {
      results.push(doFetchApi(u, method, headers, cacheTimeoutSec));
    } catch (err) {
      throw new Error(`url-list fetch failed for ${u}: ${err.message}`);
    }
  }
  return {
    result: 'success',
    data: { resultValue: results },
  };
}

export async function execute(context) {
  const kind = context.kind;
  const sourceDef = context.sourceDef;
  if (kind === 'url') return executeUrl(sourceDef);
  if (kind === 'url-list') return executeUrlList(sourceDef);
  throw new Error(`http-source-handler does not support kind: ${kind}`);
}
