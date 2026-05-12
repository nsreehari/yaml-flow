#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile
from typing import Any, Dict, List


def _decode_extra(raw: str) -> Dict[str, Any]:
    try:
        return json.loads(base64.b64decode(raw).decode("utf-8"))
    except Exception:
        return {}


def _read_history(chat_dir: str) -> List[str]:
    try:
        names = sorted(
            n for n in os.listdir(chat_dir)
            if n.lower().endswith(".txt") and ("_user" in n.lower() or "-user" in n.lower() or "_assistant" in n.lower() or "-assistant" in n.lower())
        )
    except Exception:
        return []
    out: List[str] = []
    for name in names:
        role = "User" if "user" in name.lower() else "Assistant"
        try:
            with open(os.path.join(chat_dir, name), "r", encoding="utf-8") as f:
                text = f.read().strip()
        except Exception:
            text = ""
        out.append(f"{role}: {text}")
    return out


def _cleanup_marker(cards_dir_abs: str, chat_dir_abs: str, marker_key: str | None) -> None:
    if marker_key:
        try:
            os.remove(os.path.join(cards_dir_abs, marker_key))
            return
        except OSError:
            pass
    try:
        os.remove(os.path.join(chat_dir_abs, ".processing"))
    except OSError:
        pass


def _run_wrapper(prompt: str, board_setup_root: str, card_id: str) -> str:
    wrapper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "copilot_wrapper.bat")
    if os.name != "nt" or not os.path.isfile(wrapper):
        return ""

    out_file = os.path.join(tempfile.gettempdir(), f"dch-out-{card_id}-{os.getpid()}.txt")
    prompt_file = os.path.join(tempfile.gettempdir(), f"dch-prompt-{card_id}-{os.getpid()}.txt")
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(prompt_file, "w", encoding="utf-8") as f:
        f.write(prompt)

    try:
        subprocess.run(
            [
                "cmd.exe", "/d", "/c", wrapper,
                out_file,
                os.path.join(tempfile.gettempdir(), "demo-chat-handler-sessions", card_id),
                board_setup_root,
                "@" + prompt_file,
                "raw",
                "demo-chat",
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if os.path.isfile(out_file):
            with open(out_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        return ""
    finally:
        for p in (prompt_file, out_file):
            try:
                os.remove(p)
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Python demo chat handler")
    parser.add_argument("--boardId", default="")
    parser.add_argument("--cardId", default="")
    parser.add_argument("--extraEncJson", default="")
    args = parser.parse_args()

    extra = _decode_extra(args.extraEncJson)
    board_setup_root = str(extra.get("boardSetupRoot") or "")
    cards_dir = str(extra.get("cardsDir") or os.path.join("surface", "tmp-cards"))
    chat_dir = str(extra.get("chatDir") or "")
    marker_key = extra.get("chatProcessingMarkerKey") if isinstance(extra.get("chatProcessingMarkerKey"), str) else None
    last_chat_file = str(extra.get("lastChatFile") or "")

    if not board_setup_root or not chat_dir or not last_chat_file:
        return 0

    cards_dir_abs = os.path.join(board_setup_root, cards_dir)
    chat_dir_abs = chat_dir

    serial = 1
    try:
        stem = os.path.splitext(last_chat_file)[0]
        serial = int(stem.split("-")[0].split("_")[0]) + 1
    except Exception:
        serial = 1

    response_name = f"{serial:03d}-assistant.txt"
    response_path = os.path.join(chat_dir_abs, response_name)
    history = _read_history(chat_dir_abs)

    prompt = "\n".join(history + ["Assistant:"])
    response = _run_wrapper(prompt, board_setup_root, args.cardId)
    if not response:
        response = "Acknowledged. Python chat handler is active in standalone mode."

    try:
        with open(response_path, "w", encoding="utf-8") as f:
            f.write(response.strip() + "\n")
    except Exception:
        pass
    finally:
        _cleanup_marker(cards_dir_abs, chat_dir_abs, marker_key)

    print(f"[demo-chat-handler.py] cardId=\"{args.cardId}\" wrote {response_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
