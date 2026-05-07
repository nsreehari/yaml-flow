"""
Storage Interface

Three minimal storage primitives that together cover all persistence needs
of the board-live-cards system.

Port of src/cli/common/storage-interface.ts
"""
from __future__ import annotations

from typing import Any


# ============================================================================
# KindValueRef — backend-neutral typed reference
#
# Serialized on the CLI wire as: ::kind::value
# ============================================================================

def serialize_ref(ref: dict) -> str:
    """
    Serialize a KindValueRef dict to the wire format: ::kind::value

    ref = {"kind": str, "value": str}
    """
    return f"::{ref['kind']}::{ref['value']}"


def parse_ref(s: str) -> dict:
    """
    Parse a wire-format ref string (::kind::value) into a KindValueRef dict.

    Returns {"kind": str, "value": str}
    """
    if not s.startswith("::"):
        raise ValueError(f"Invalid ref format (expected ::kind::value): {s}")
    inner = s[2:]
    idx = inner.find("::")
    if idx == -1:
        raise ValueError(f"Invalid ref format (expected ::kind::value): {s}")
    return {"kind": inner[:idx], "value": inner[idx + 2:]}


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
