"""
public_storage_adapter.py

Standalone file — copy this to your task-executor project.
Zero dependencies on the rest of yaml-flow internals.

Provides:
    - KindValueRef        wire format: b64:<base64url(json)>
    - parse_ref()         parse a b64:<base64url(json)> string
    - serialize_ref()     produce a b64:<base64url(json)> string
  - BlobStorage         read/write interface (protocol class)
  - blob_storage_for_ref()  resolve a ref to its BlobStorage backend
  - TaskCallback        how to report task completion back to the board
  - report_complete()   call from executor on success
  - report_failed()     call from executor on failure

Supported storage kinds:
  fs-path   — ref.value is an absolute file path; reads/writes via os/pathlib

Supported callback transports (via ExecutionRef.howToRun):
  local-node     — invoke board CLI as a child Node process
  local-python   — invoke board pycli as a child Python process
  http:post      — HTTP POST to a board endpoint

Usage:
  from pycli.sub.public_storage_adapter import (
      parse_ref, serialize_ref, blob_storage_for_ref,
      report_complete, report_failed,
  )

  in_ref = parse_ref(in_ref_str)
  storage = blob_storage_for_ref(in_ref)
  envelope = json.loads(storage.read(in_ref.value))
  callback = envelope.get("callback")
  # ... do work, write to out_ref ...
  report_complete(callback, out_ref)
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol
from urllib.request import Request, urlopen


# ============================================================================
# KindValueRef
# ============================================================================

@dataclass(frozen=True)
class KindValueRef:
    kind: str
    value: str


def parse_ref(s: str) -> KindValueRef:
    """Parse a wire-format ref string (b64:<base64url(json)>) into a KindValueRef."""
    if not s.startswith("b64:"):
        raise ValueError(f"Invalid ref format (expected b64:<base64url(json)>): {s}")
    payload = s[4:]
    padded = payload + ("=" * ((4 - len(payload) % 4) % 4))
    try:
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid ref format (malformed base64url/json): {s}") from exc
    kind = decoded.get("kind") if isinstance(decoded, dict) else None
    value = decoded.get("value") if isinstance(decoded, dict) else None
    if not isinstance(kind, str) or not isinstance(value, str):
        raise ValueError(f"Invalid ref format (payload must contain string kind/value): {s}")
    return KindValueRef(kind=kind, value=value)


def serialize_ref(ref: KindValueRef) -> str:
    """Serialize a KindValueRef to the wire format: b64:<base64url(json)>"""
    payload = json.dumps({"kind": ref.kind, "value": ref.value}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"b64:{encoded}"


# ============================================================================
# BlobStorage
# ============================================================================

class BlobStorage(Protocol):
    def read(self, key: str) -> Optional[str]: ...
    def write(self, key: str, content: str) -> None: ...


class _FsPathBlobStorage:
    """fs-path backend — key IS the absolute file path."""

    def read(self, key: str) -> Optional[str]:
        if not os.path.exists(key):
            return None
        return Path(key).read_text(encoding="utf-8")

    def write(self, key: str, content: str) -> None:
        os.makedirs(os.path.dirname(key), exist_ok=True)
        Path(key).write_text(content, encoding="utf-8")


def blob_storage_for_ref(ref: KindValueRef) -> _FsPathBlobStorage:
    """Resolve a KindValueRef to its BlobStorage backend."""
    if ref.kind == "fs-path":
        return _FsPathBlobStorage()
    raise ValueError(f'Unsupported storage kind: "{ref.kind}". Supported kinds: fs-path')


# ============================================================================
# TaskCallback — how a task-executor reports results back to the board
# ============================================================================

@dataclass
class ExecutionRef:
    """Portable invocation descriptor (mirrors execution-interface.ts)."""
    howToRun: str
    whatToRun: str
    meta: Optional[str] = None
    extra: Optional[dict[str, Any]] = None


@dataclass
class TaskCallback:
    """Describes how the board wants to receive task completion callbacks."""
    token: str
    via: ExecutionRef


def _parse_task_callback(raw: dict[str, Any]) -> TaskCallback:
    """Parse a raw dict (from JSON envelope) into a TaskCallback."""
    via_raw = raw.get("via") or {}
    return TaskCallback(
        token=str(raw.get("token", "")),
        via=ExecutionRef(
            howToRun=str(via_raw.get("howToRun", "")),
            whatToRun=str(via_raw.get("whatToRun", "")),
            meta=via_raw.get("meta"),
            extra=via_raw.get("extra"),
        ),
    )


def _parse_what_to_run(what_to_run: str) -> str:
    """Extract the path/url value from a whatToRun b64:<base64url(json)> wire string."""
    try:
        return parse_ref(what_to_run).value
    except Exception:
        return what_to_run


def _notify_channel_from_via(via: ExecutionRef) -> Optional[str]:
    if via.extra and isinstance(via.extra.get("notifyChannel"), str):
        ch = via.extra["notifyChannel"]
        return ch if ch else None
    return None


def _run_subprocess_hidden(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    """Run a subprocess without popping a cmd window on Windows."""
    kwargs: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "shell": False,
    }
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        kwargs["startupinfo"] = startupinfo
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return subprocess.run(cmd, **kwargs)


def report_complete(callback: Any, out_ref: KindValueRef) -> None:
    """
    Report successful task completion back to the board.
    Call this from a task-executor after writing the result to out_ref.

    Accepts either a TaskCallback or a raw dict (from JSON envelope).
    """
    cb = callback if isinstance(callback, TaskCallback) else _parse_task_callback(callback)
    token = cb.token
    via = cb.via

    if via.howToRun in ("local-node", "local-process"):
        script_path = _parse_what_to_run(via.whatToRun)
        notify_channel = _notify_channel_from_via(via)
        cmd = ["node", script_path, "source-data-fetched",
               "--ref", serialize_ref(out_ref),
               "--token", token]
        if notify_channel:
            cmd.extend(["--notify-channel", notify_channel])
        result = _run_subprocess_hidden(cmd)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_complete: board CLI exited {result.returncode}: {msg}")
        return

    if via.howToRun == "local-python":
        script_path = _parse_what_to_run(via.whatToRun)
        notify_channel = _notify_channel_from_via(via)
        # Use unprefixed command — board pycli decodes base_ref from token automatically.
        cmd = [sys.executable, script_path, "source-data-fetched",
               "--ref", serialize_ref(out_ref),
               "--token", token]
        if notify_channel:
            cmd.extend(["--notify-channel", notify_channel])
        result = _run_subprocess_hidden(cmd)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_complete: board pycli exited {result.returncode}: {msg}")
        return

    if via.howToRun == "http:post":
        url = _parse_what_to_run(via.whatToRun)
        body = json.dumps({"status": "complete", "ref": serialize_ref(out_ref), "token": token}).encode("utf-8")
        req = Request(url, method="POST", data=body, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=30):
            return

    raise ValueError(f'report_complete: unsupported via.howToRun "{via.howToRun}"')


def report_failed(callback: Any, reason: str) -> None:
    """
    Report task failure back to the board.
    Call this from a task-executor instead of writing to out_ref.

    Accepts either a TaskCallback or a raw dict (from JSON envelope).
    """
    cb = callback if isinstance(callback, TaskCallback) else _parse_task_callback(callback)
    token = cb.token
    via = cb.via

    if via.howToRun in ("local-node", "local-process"):
        script_path = _parse_what_to_run(via.whatToRun)
        notify_channel = _notify_channel_from_via(via)
        cmd = ["node", script_path, "source-data-fetch-failure",
               "--token", token,
               "--reason", reason]
        if notify_channel:
            cmd.extend(["--notify-channel", notify_channel])
        result = _run_subprocess_hidden(cmd)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_failed: board CLI exited {result.returncode}: {msg}")
        return

    if via.howToRun == "local-python":
        script_path = _parse_what_to_run(via.whatToRun)
        notify_channel = _notify_channel_from_via(via)
        # Use unprefixed command — board pycli decodes base_ref from token automatically.
        cmd = [sys.executable, script_path, "source-data-fetch-failure",
               "--token", token,
               "--reason", reason]
        if notify_channel:
            cmd.extend(["--notify-channel", notify_channel])
        result = _run_subprocess_hidden(cmd)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_failed: board pycli exited {result.returncode}: {msg}")
        return

    if via.howToRun == "http:post":
        url = _parse_what_to_run(via.whatToRun)
        body = json.dumps({"status": "failed", "reason": reason, "token": token}).encode("utf-8")
        req = Request(url, method="POST", data=body, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=30):
            return

    raise ValueError(f'report_failed: unsupported via.howToRun "{via.howToRun}"')
