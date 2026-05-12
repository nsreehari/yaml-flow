#!/usr/bin/env python3
"""Python standalone card-store CLI (Node-free).

Command surface mirrors JS card-store-cli.ts:
- get
- set
- del
- delete (alias)
- patch
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

import yaml

_CURRENT = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_CURRENT, ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from sub.board_live_cards_adapters import FsKvStorage, compute_stable_json_hash, parse_ref


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _ensure_fs_store(store_ref: str) -> FsKvStorage:
    kind, value = parse_ref(store_ref)
    if kind != "fs-path":
        raise ValueError(f"Unsupported store ref kind for card-store CLI: {kind}")
    return FsKvStorage(value)


def _read_stdin_text() -> str:
    return sys.stdin.read()


def _parse_json_cards(text: str, source: str) -> List[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
    except Exception as e:
        raise ValueError(f"card-store set: JSON parse error from {source}: {str(e)}") from e

    if isinstance(parsed, list):
        out: List[Dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                raise ValueError(f"card-store set: JSON from {source} must be an object or an array of objects")
            out.append(item)
        return out
    if isinstance(parsed, dict):
        return [parsed]
    raise ValueError(f"card-store set: JSON from {source} must be an object or an array of objects")


def _parse_yaml_docs(text: str, source: str) -> List[Dict[str, Any]]:
    try:
        docs = list(yaml.safe_load_all(text))
    except Exception as e:
        raise ValueError(f"card-store set: YAML parse error from {source}: {str(e)}") from e

    out: List[Dict[str, Any]] = []
    for i, doc in enumerate(docs, start=1):
        if not isinstance(doc, dict):
            raise ValueError(f"card-store set: YAML document {i} from {source} must be an object")
        out.append(doc)
    return out


def _read_index(storage: FsKvStorage) -> Dict[str, Dict[str, Any]]:
    raw = storage.read("_index")
    if isinstance(raw, dict):
        return raw
    return {}


def _write_index(storage: FsKvStorage, index: Dict[str, Dict[str, Any]]) -> None:
    storage.write("_index", index)


def _read_card(storage: FsKvStorage, card_id: str) -> Dict[str, Any] | None:
    index = _read_index(storage)
    entry = index.get(card_id)
    if not isinstance(entry, dict):
        return None
    key = entry.get("key")
    if not isinstance(key, str) or not key:
        return None
    card = storage.read(key)
    return card if isinstance(card, dict) else None


def _read_all_cards(storage: FsKvStorage) -> List[Dict[str, Any]]:
    index = _read_index(storage)
    cards: List[Dict[str, Any]] = []
    for card_id, entry in index.items():
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not isinstance(key, str) or not key:
            continue
        card = storage.read(key)
        if isinstance(card, dict):
            cards.append(card)
        else:
            print(f'[card-store] could not read card "{card_id}" at key "{key}"', file=sys.stderr)
    return cards


def _write_card(storage: FsKvStorage, card_id: str, card: Dict[str, Any]) -> None:
    index = _read_index(storage)
    key = index.get(card_id, {}).get("key") if isinstance(index.get(card_id), dict) else None
    if not isinstance(key, str) or not key:
        key = card_id

    storage.write(key, card)
    index[card_id] = {
        "key": key,
        "checksum": compute_stable_json_hash(card),
        "updatedAt": _utc_iso(),
    }
    _write_index(storage, index)


def _patch_card(storage: FsKvStorage, card_id: str, json_path: str, value: Any) -> None:
    index = _read_index(storage)
    entry = index.get(card_id)
    if not isinstance(entry, dict):
        raise ValueError(f'card "{card_id}" not found')

    key = entry.get("key")
    if not isinstance(key, str) or not key:
        raise ValueError(f'card "{card_id}" not found')

    current = storage.read(key)
    if not isinstance(current, dict):
        raise ValueError(f'card "{card_id}" is not patchable')

    segments = [seg for seg in str(json_path).split(".") if seg]
    if len(segments) == 0:
        if isinstance(value, dict):
            next_card = value
        else:
            next_card = {"value": value}
    else:
        next_card = dict(current)
        target: Dict[str, Any] = next_card
        for seg in segments[:-1]:
            cur = target.get(seg)
            if isinstance(cur, dict):
                nxt = dict(cur)
            else:
                nxt = {}
            target[seg] = nxt
            target = nxt
        target[segments[-1]] = value

    storage.write(key, next_card)
    index[card_id] = {
        "key": key,
        "checksum": compute_stable_json_hash(next_card),
        "updatedAt": _utc_iso(),
    }
    _write_index(storage, index)


def cmd_get(args: argparse.Namespace) -> int:
    storage = _ensure_fs_store(args.store_ref)
    cards = [_read_card(storage, args.id)] if args.id else _read_all_cards(storage)
    cards = [c for c in cards if isinstance(c, dict)]

    if len(cards) == 0:
        return 0

    if args.yaml:
        out = "".join(f"---\n{yaml.safe_dump(card, sort_keys=False, allow_unicode=False)}" for card in cards)
        sys.stdout.write(out)
    else:
        sys.stdout.write(json.dumps(cards, indent=2, ensure_ascii=False) + "\n")
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    storage = _ensure_fs_store(args.store_ref)

    ref_json = args.ref
    ref_yaml = args.ref_yaml

    if ref_yaml:
        with open(ref_yaml, "r", encoding="utf-8") as f:
            cards = _parse_yaml_docs(f.read(), ref_yaml)
    elif ref_json:
        with open(ref_json, "r", encoding="utf-8") as f:
            cards = _parse_json_cards(f.read(), ref_json)
    else:
        text = _read_stdin_text()
        if not text.strip():
            raise ValueError("card-store set: no input (provide --ref, --ref-yaml, or pipe to stdin)")
        if args.yaml:
            cards = _parse_yaml_docs(text, "stdin")
        else:
            cards = _parse_json_cards(text, "stdin")

    for card in cards:
        card_id = card.get("id")
        if not isinstance(card_id, str):
            raise ValueError("card-store set: each card must have a string `id` field")
        _write_card(storage, card_id, card)

    print(f"card-store set: wrote {len(cards)} card(s)", file=sys.stderr)
    return 0


def cmd_del(args: argparse.Namespace) -> int:
    storage = _ensure_fs_store(args.store_ref)
    ids = args.id or []
    if len(ids) == 0:
        raise ValueError("card-store del: del requires body.ids (string[]) or params.id")

    index = _read_index(storage)
    for card_id in ids:
        if card_id in index:
            del index[card_id]
    _write_index(storage, index)

    print(f"card-store del: removed {len(ids)} card(s)", file=sys.stderr)
    return 0


def cmd_patch(args: argparse.Namespace) -> int:
    storage = _ensure_fs_store(args.store_ref)

    if args.value_json is not None:
        try:
            value = json.loads(args.value_json)
        except Exception as e:
            raise ValueError(f"card-store patch: JSON parse error: {str(e)}") from e
    else:
        text = _read_stdin_text()
        if not text.strip():
            raise ValueError("card-store patch: provide --value-json or JSON value via stdin")
        try:
            value = json.loads(text)
        except Exception as e:
            raise ValueError(f"card-store patch: JSON parse error: {str(e)}") from e

    _patch_card(storage, args.id, args.path, value)
    print("card-store patch: ok", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Python standalone card-store CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    get_cmd = sub.add_parser("get", help="Get one card (--id) or all cards")
    get_cmd.add_argument("--store-ref", required=True)
    get_cmd.add_argument("--id", required=False)
    get_cmd.add_argument("--yaml", action="store_true", help="Output YAML multi-doc")
    get_cmd.set_defaults(handler=cmd_get)

    set_cmd = sub.add_parser("set", help="Write cards into the store")
    set_cmd.add_argument("--store-ref", required=True)
    set_cmd.add_argument("--ref", required=False)
    set_cmd.add_argument("--ref-yaml", required=False)
    set_cmd.add_argument("--yaml", action="store_true", help="Treat stdin as YAML")
    set_cmd.set_defaults(handler=cmd_set)

    del_cmd = sub.add_parser("del", help="Delete one or more cards by id")
    del_cmd.add_argument("--store-ref", required=True)
    del_cmd.add_argument("--id", action="append", required=False)
    del_cmd.set_defaults(handler=cmd_del)

    delete_cmd = sub.add_parser("delete", help="Alias for del")
    delete_cmd.add_argument("--store-ref", required=True)
    delete_cmd.add_argument("--id", action="append", required=False)
    delete_cmd.set_defaults(handler=cmd_del)

    patch_cmd = sub.add_parser("patch", help="Patch one card field by dot path")
    patch_cmd.add_argument("--store-ref", required=True)
    patch_cmd.add_argument("--id", required=True)
    patch_cmd.add_argument("--path", required=True)
    patch_cmd.add_argument("--value-json", required=False)
    patch_cmd.set_defaults(handler=cmd_patch)

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
