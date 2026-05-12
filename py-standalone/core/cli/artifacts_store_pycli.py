#!/usr/bin/env python3
"""Python standalone artifacts-store CLI (Node-free).

Parity target: src/cli/node/artifacts-store-cli.ts
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

_CURRENT = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_CURRENT, ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from sub.board_live_cards_adapters import parse_ref

_INDEX_KEY = ".artifacts-index.json"


def _utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def _ensure_root(store_ref: str) -> Path:
    kind, value = parse_ref(store_ref)
    if kind != "fs-path":
        raise ValueError(f"Unsupported store ref kind for artifacts-store CLI: {kind}")
    root = Path(value)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_path(root: Path, key: str) -> Path:
    rel = Path(key)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("Invalid artifact key")
    out = root / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def _load_index(root: Path) -> Dict[str, Dict[str, Any]]:
    idx = root / _INDEX_KEY
    if not idx.exists():
        return {}
    try:
        parsed = json.loads(idx.read_text(encoding="utf-8"))
        entries = parsed.get("entries") if isinstance(parsed, dict) else None
        return entries if isinstance(entries, dict) else {}
    except Exception:
        return {}


def _save_index(root: Path, entries: Dict[str, Dict[str, Any]]) -> None:
    idx = root / _INDEX_KEY
    payload = {"entries": entries}
    idx.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _head(root: Path, key: str) -> Dict[str, Any] | None:
    path = _safe_path(root, key)
    if path.exists():
        st = path.stat()
        info: Dict[str, Any] = {
            "key": key,
            "size": int(st.st_size),
            "updatedAt": _utc_iso(st.st_mtime),
        }
        return info

    idx = _load_index(root)
    entry = idx.get(key)
    if isinstance(entry, dict):
        info = {"key": key}
        for k in ("size", "updatedAt", "contentType"):
            if k in entry:
                info[k] = entry[k]
        return info
    return None


def _list(root: Path, prefix: str = "") -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}

    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if rel == _INDEX_KEY:
            continue
        if prefix and not rel.startswith(prefix):
            continue
        info = _head(root, rel)
        if info is not None:
            by_key[rel] = info

    idx = _load_index(root)
    for key, entry in idx.items():
        if key == _INDEX_KEY:
            continue
        if prefix and not key.startswith(prefix):
            continue
        if key in by_key:
            continue
        if isinstance(entry, dict):
            info = {"key": key}
            for k in ("size", "updatedAt", "contentType"):
                if k in entry:
                    info[k] = entry[k]
            by_key[key] = info

    return [by_key[k] for k in sorted(by_key.keys())]


def _put_bytes(root: Path, key: str, data: bytes, content_type: str | None) -> Dict[str, Any]:
    path = _safe_path(root, key)
    path.write_bytes(data)

    info = _head(root, key) or {"key": key, "size": len(data), "updatedAt": _utc_iso(path.stat().st_mtime)}
    if content_type:
        info["contentType"] = content_type

    idx = _load_index(root)
    idx[key] = {
        "key": key,
        "size": info.get("size"),
        "updatedAt": info.get("updatedAt"),
        "contentType": info.get("contentType"),
    }
    _save_index(root, idx)
    return info


def _put_text(root: Path, key: str, text: str, content_type: str | None) -> Dict[str, Any]:
    ct = content_type or "text/plain; charset=utf-8"
    return _put_bytes(root, key, text.encode("utf-8"), ct)


def _get_bytes(root: Path, key: str) -> bytes | None:
    path = _safe_path(root, key)
    if not path.exists():
        return None
    return path.read_bytes()


def _get_text(root: Path, key: str) -> str | None:
    data = _get_bytes(root, key)
    if data is None:
        return None
    return data.decode("utf-8")


def _remove(root: Path, key: str) -> None:
    path = _safe_path(root, key)
    if path.exists():
        path.unlink()

    idx = _load_index(root)
    if key in idx:
        del idx[key]
        _save_index(root, idx)


def _json_print(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def cmd_put(args: argparse.Namespace) -> int:
    root = _ensure_root(args.store_ref)
    key = args.key

    if args.file_path:
        body_bytes = Path(args.file_path).read_bytes()
        info = _put_bytes(root, key, body_bytes, args.content_type)
    elif args.text is not None:
        info = _put_text(root, key, args.text, args.content_type)
    elif not sys.stdin.isatty():
        body_bytes = sys.stdin.buffer.read()
        info = _put_bytes(root, key, body_bytes, args.content_type or "application/octet-stream")
    else:
        raise ValueError("put requires --file, --text, or stdin bytes")

    _json_print({"artifact": info})
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    root = _ensure_root(args.store_ref)
    key = args.key
    as_mode = (args.as_mode or "bytes").lower()

    info = _head(root, key)
    if info is None:
        raise ValueError(f'artifact "{key}" not found')

    if as_mode == "text":
        text = _get_text(root, key)
        if text is None:
            raise ValueError(f'artifact "{key}" not found')
        if args.out_path:
            Path(args.out_path).write_text(text, encoding="utf-8")
        else:
            sys.stdout.write(text)
        return 0

    data = _get_bytes(root, key)
    if data is None:
        raise ValueError(f'artifact "{key}" not found')
    if args.out_path:
        out = Path(args.out_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        return 0

    out_payload = {
        "key": key,
        "size": info.get("size"),
        "byteLength": len(data),
    }
    if info.get("contentType") is not None:
        out_payload["contentType"] = info.get("contentType")
    _json_print(out_payload)
    return 0


def cmd_head(args: argparse.Namespace) -> int:
    root = _ensure_root(args.store_ref)
    info = _head(root, args.key)
    _json_print({"artifact": info})
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    root = _ensure_root(args.store_ref)
    artifacts = _list(root, args.prefix or "")
    _json_print({"artifacts": artifacts})
    return 0


def cmd_del(args: argparse.Namespace) -> int:
    root = _ensure_root(args.store_ref)
    _remove(root, args.key)
    _json_print({"ok": True})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Python standalone artifacts-store CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    put_cmd = sub.add_parser("put", help="Put artifact")
    put_cmd.add_argument("--store-ref", required=True)
    put_cmd.add_argument("--key", required=True)
    put_cmd.add_argument("--file", dest="file_path", required=False)
    put_cmd.add_argument("--text", required=False)
    put_cmd.add_argument("--content-type", required=False)
    put_cmd.set_defaults(handler=cmd_put)

    get_cmd = sub.add_parser("get", help="Get artifact")
    get_cmd.add_argument("--store-ref", required=True)
    get_cmd.add_argument("--key", required=True)
    get_cmd.add_argument("--out", dest="out_path", required=False)
    get_cmd.add_argument("--as", dest="as_mode", required=False)
    get_cmd.set_defaults(handler=cmd_get)

    head_cmd = sub.add_parser("head", help="Head artifact")
    head_cmd.add_argument("--store-ref", required=True)
    head_cmd.add_argument("--key", required=True)
    head_cmd.set_defaults(handler=cmd_head)

    list_cmd = sub.add_parser("list", help="List artifacts")
    list_cmd.add_argument("--store-ref", required=True)
    list_cmd.add_argument("--prefix", required=False)
    list_cmd.set_defaults(handler=cmd_list)

    del_cmd = sub.add_parser("del", help="Delete artifact")
    del_cmd.add_argument("--store-ref", required=True)
    del_cmd.add_argument("--key", required=True)
    del_cmd.set_defaults(handler=cmd_del)

    delete_cmd = sub.add_parser("delete", help="Alias for del")
    delete_cmd.add_argument("--store-ref", required=True)
    delete_cmd.add_argument("--key", required=True)
    delete_cmd.set_defaults(handler=cmd_del)

    rm_cmd = sub.add_parser("rm", help="Alias for del")
    rm_cmd.add_argument("--store-ref", required=True)
    rm_cmd.add_argument("--key", required=True)
    rm_cmd.set_defaults(handler=cmd_del)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
