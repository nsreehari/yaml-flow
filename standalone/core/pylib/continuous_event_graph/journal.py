"""
Continuous Event Graph — Journal

Append-only event log for the reactive layer.
Handlers append events here; drain() reads and clears atomically.

Port of src/continuous-event-graph/journal.ts
"""
from __future__ import annotations

from typing import Any


class MemoryJournal:
    """In-process journal backed by a plain list. Zero dependencies."""

    def __init__(self) -> None:
        self._buffer: list[dict] = []

    def append(self, event: dict) -> None:
        """Append an event to the journal."""
        self._buffer.append(event)

    def drain(self) -> list[dict]:
        """Read all pending events and clear the journal atomically."""
        events = self._buffer
        self._buffer = []
        return events

    @property
    def size(self) -> int:
        """Number of pending events."""
        return len(self._buffer)
