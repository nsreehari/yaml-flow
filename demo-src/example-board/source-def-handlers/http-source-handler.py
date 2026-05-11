#!/usr/bin/env python3
"""
http-source-handler.py — Python port of http-source-handler.js.

Handles 'url' and 'url-list' source kinds for the demo board.
Called by demo-task-executor.py via the step machine (demo-local-module).

Interface:
  execute(context) -> {"result": "success"|"failure", "data": {...}}

  context keys:
    kind      : "url" | "url-list"
    sourceDef : dict — source definition from the card
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.request
from typing import Any, Dict

CACHE_DIR = os.path.join(tempfile.gettempdir(), "demo-executor-cache")
DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000


def _interpolate(template: str, args: Dict[str, Any]) -> str:
    out = str(template)
    for key, value in args.items():
        needle = "{{" + str(key) + "}}"
        if needle in out:
            out = out.replace(needle, value if isinstance(value, str) else json.dumps(value, ensure_ascii=True))
    return out


def _cache_key(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def _read_cache(key: str, ttl_ms: int) -> Any:
    path = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        st = os.stat(path)
        age_ms = int(time.time() * 1000) - int(st.st_mtime * 1000)
        if age_ms > ttl_ms:
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache(key: str, value: Any) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(os.path.join(CACHE_DIR, f"{key}.json"), "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True)


def _fetch_json(url: str, method: str, headers: Dict[str, str]) -> Any:
    req = urllib.request.Request(url=url, method=method.upper())
    for k, v in headers.items():
        req.add_header(str(k), str(v))
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


def _do_fetch_api(url: str, method: str, headers: Dict[str, str], ttl_ms: int) -> Any:
    key = _cache_key(f"url:{method}:{url}")
    cached = _read_cache(key, ttl_ms)
    if cached is not None:
        print(f"[http-source-handler] cache hit for {url}", file=sys.stderr)
        return cached
    data = _fetch_json(url, method, headers)
    _write_cache(key, data)
    return data


def _resolve_tickers_arg(source_def: Dict[str, Any], fetch_args: Dict[str, Any]) -> None:
    tickers_from = source_def.get("tickersFrom")
    if not isinstance(tickers_from, str) or "." not in tickers_from:
        return
    ref_key, field_name = tickers_from.split(".", 1)
    arr = (source_def.get("_projections") or {}).get(ref_key)
    if not isinstance(arr, list):
        return
    vals = [row.get(field_name) for row in arr if isinstance(row, dict) and row.get(field_name)]
    if vals:
        fetch_args["tickers"] = ",".join(str(v) for v in vals)


def _execute_url(source_def: Dict[str, Any]) -> Any:
    cfg = source_def.get("url")
    if not isinstance(cfg, dict):
        raise ValueError("url source requires object config")
    method = str(cfg.get("method") or "GET").upper()
    headers = dict(cfg.get("headers") or {})
    cache_timeout = cfg.get("cacheTimeout")
    ttl_ms = int(cache_timeout * 1000) if isinstance(cache_timeout, (int, float)) else DEFAULT_CACHE_TTL_MS
    fetch_args = dict(cfg.get("args") or {})

    _resolve_tickers_arg(source_def, fetch_args)
    if source_def.get("tickersFrom") and not fetch_args.get("tickers"):
        raise ValueError("url: tickersFrom resolved to empty list - skipping fetch")

    ctx: Dict[str, Any] = {}
    ctx.update(source_def.get("_projections") or {})
    ctx.update(fetch_args)
    url_tpl = cfg.get("url")
    if not isinstance(url_tpl, str):
        raise ValueError("url source missing url template")
    url = _interpolate(url_tpl, ctx)
    return _do_fetch_api(url, method, headers, ttl_ms)


def _execute_url_list(source_def: Dict[str, Any]) -> Any:
    cfg = source_def.get("url-list")
    if not isinstance(cfg, dict):
        raise ValueError("url-list source requires object config")
    method = str(cfg.get("method") or "GET").upper()
    headers = dict(cfg.get("headers") or {})
    cache_timeout = cfg.get("cacheTimeout")
    ttl_ms = int(cache_timeout * 1000) if isinstance(cache_timeout, (int, float)) else DEFAULT_CACHE_TTL_MS
    url_list = (source_def.get("_projections") or {}).get("url_list")
    if not isinstance(url_list, list) or not url_list:
        raise ValueError("url-list source requires _projections.url_list as non-empty array")
    results = []
    for u in url_list:
        results.append(_do_fetch_api(str(u), method, headers, ttl_ms))
    return results


def execute(context: Dict[str, Any]) -> Dict[str, Any]:
    """Handler entry point — called by demo-task-executor via step machine."""
    kind = context.get("kind")
    source_def = context.get("sourceDef")
    try:
        if kind == "url":
            result_value = _execute_url(source_def)
        elif kind == "url-list":
            result_value = _execute_url_list(source_def)
        else:
            raise ValueError(f"http-source-handler does not support kind: {kind}")
        return {"result": "success", "data": {"resultValue": result_value}}
    except Exception as exc:
        msg = str(exc)
        return {"result": "failure", "data": {"error": msg}, "error": msg}
