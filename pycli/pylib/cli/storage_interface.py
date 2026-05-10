"""
Storage Interface

Three minimal storage primitives that together cover all persistence needs
of the board-live-cards system.

Port of src/cli/common/storage-interface.ts
"""
from __future__ import annotations

import base64
import json
from typing import Any


# ============================================================================
# KindValueRef — backend-neutral typed reference
#
# Serialized on the CLI wire as: b64:<base64url(json)>
# ============================================================================

def serialize_ref(ref: dict) -> str:
    """
    Serialize a KindValueRef dict to the wire format: b64:<base64url(json)>

    ref = {"kind": str, "value": str}
    """
    payload = json.dumps({"kind": ref["kind"], "value": ref["value"]}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"b64:{encoded}"


def parse_ref(s: str) -> dict:
    """
    Parse a wire-format ref string (b64:<base64url(json)>) into a KindValueRef dict.

    Returns {"kind": str, "value": str}
    """
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
    return {"kind": kind, "value": value}


# ============================================================================
# Storage protocol docstrings (no ABCs needed — duck typing)
# ============================================================================

# BlobStorage protocol:
#   read(key: str) -> str | None
#   write(key: str, content: str) -> None
#   exists(key: str) -> bool
#   remove(key: str) -> None
#   read_bytes(key: str) -> bytes | None  (optional)
#   write_bytes(key: str, content: bytes) -> None  (optional)
#   list_keys(prefix: str = "") -> list[str]  (optional)

# JournalStorage protocol:
#   append(payload) -> {"id": str, "payload": Any}
#   read_all() -> list[{"id": str, "payload": Any}]
#   read_after(cursor: str | None) -> {"entries": list, "newCursor": str | None}

# KVStorage protocol:
#   read(key: str) -> Any | None
#   write(key: str, value: Any) -> None
#   delete(key: str) -> None
#   list_keys(prefix: str = "") -> list[str]
