#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CACHE_DIR = path.join(os.tmpdir(), 'demo-executor-cache');
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function cacheKey(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex');
}

function readCache(key, ttlMs) {
  const p = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(p);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
}

async function fetchJson(url, method, headers) {
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
  if (!response.ok) {
    const msg = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return parsed;
}

async function doFetchApi(url, method, headers, ttlMs) {
  const key = cacheKey(`url:${method}:${url}`);
  const cached = readCache(key, ttlMs);
  if (cached !== null) {
    console.error(`[http-source-handler] cache hit for ${url}`);
    return cached;
  }
  const data = await fetchJson(url, method, headers);
  writeCache(key, data);
  return data;
}

function resolveTickersArg(sourceDef, fetchArgs) {
  const tickersFrom = sourceDef?.tickersFrom;
  if (typeof tickersFrom !== 'string' || !tickersFrom.includes('.')) return;
  const [refKey, fieldName] = tickersFrom.split('.', 2);
  const arr = sourceDef?._projections?.[refKey];
  if (!Array.isArray(arr)) return;
  const vals = arr
    .filter((row) => row && typeof row === 'object' && row[fieldName])
    .map((row) => String(row[fieldName]));
  if (vals.length > 0) fetchArgs.tickers = vals.join(',');
}

async function executeUrl(sourceDef) {
  const cfg = sourceDef?.urls;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('urls source requires object config');
  }
  const method = String(cfg.method || 'GET').toUpperCase();
  const headers = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
  const ttlMs = typeof cfg.cacheTimeout === 'number' ? cfg.cacheTimeout * 1000 : DEFAULT_CACHE_TTL_MS;
  const fetchArgs = cfg.args && typeof cfg.args === 'object' ? { ...cfg.args } : {};

  resolveTickersArg(sourceDef, fetchArgs);
  if (sourceDef?.tickersFrom && !fetchArgs.tickers) {
    throw new Error('urls: tickersFrom resolved to empty list - skipping fetch');
  }

  const ctx = {
    ...(sourceDef?._projections || {}),
    ...fetchArgs,
  };

  if (typeof cfg.url !== 'string' || !cfg.url) {
    throw new Error('urls source missing url template');
  }
  const url = interpolate(cfg.url, ctx);
  return doFetchApi(url, method, headers, ttlMs);
}

async function executeProjectedUrl(sourceDef, selectedUrl) {
  const cfg = sourceDef?.urls;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('urls source requires object config');
  }
  const method = String(cfg.method || 'GET').toUpperCase();
  const headers = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
  const ttlMs = typeof cfg.cacheTimeout === 'number' ? cfg.cacheTimeout * 1000 : DEFAULT_CACHE_TTL_MS;
  const fetchArgs = cfg.args && typeof cfg.args === 'object' ? { ...cfg.args } : {};

  resolveTickersArg(sourceDef, fetchArgs);

  const ctx = {
    ...(sourceDef?._projections || {}),
    ...fetchArgs,
  };

  if (typeof selectedUrl !== 'string' || !selectedUrl) {
    throw new Error('urls projected execution requires a concrete URL string');
  }

  const url = interpolate(selectedUrl, ctx);
  return doFetchApi(url, method, headers, ttlMs);
}

export async function execute(context) {
  const kind = context?.kind || context?.expects_data?.kind;
  const sourceDef = context?.sourceDef || context?.expects_data?.sourceDef || {};
  try {
    let resultValue;
    if (kind === 'urls' || sourceDef?.urls) {
      const projectedUrl =
        typeof context?.url === 'string' ? context.url :
        typeof context?.item === 'string' ? context.item :
        typeof context?.expects_data?.url === 'string' ? context.expects_data.url :
        typeof context?.expects_data?.item === 'string' ? context.expects_data.item :
        undefined;
      resultValue = projectedUrl ? await executeProjectedUrl(sourceDef, projectedUrl) : await executeUrl(sourceDef);
    } else {
      throw new Error(`http-source-handler does not support kind: ${kind}`);
    }
    return { result: 'success', data: { resultValue } };
  } catch (err) {
    const msg = String(err?.message || err);
    return { result: 'failure', data: { error: msg }, error: msg };
  }
}
