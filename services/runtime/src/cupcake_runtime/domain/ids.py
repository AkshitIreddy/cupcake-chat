"""Monotonic UUIDv7 generation without a pre-release stdlib dependency."""

from __future__ import annotations

import secrets
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = -1
_sequence = 0


def uuid7(*, timestamp_ms: int | None = None) -> uuid.UUID:
    """Return an RFC 9562 UUIDv7.

    IDs generated in one process are monotonic within a millisecond. The 12-bit
    sequence is randomized on a new millisecond and rolls into the next logical
    millisecond if more than 4096 IDs are requested before the clock advances.
    """

    global _last_ms, _sequence
    now_ms = int(time.time_ns() // 1_000_000) if timestamp_ms is None else timestamp_ms
    if now_ms < 0 or now_ms >= 1 << 48:
        raise ValueError("timestamp_ms must fit in 48 unsigned bits")

    with _lock:
        logical_ms = max(now_ms, _last_ms)
        if logical_ms == _last_ms:
            _sequence += 1
            if _sequence >= 1 << 12:
                logical_ms += 1
                _sequence = secrets.randbits(12)
        else:
            _sequence = secrets.randbits(12)
        _last_ms = logical_ms
        sequence = _sequence

    random_b = secrets.randbits(62)
    value = logical_ms << 80
    value |= 0x7 << 76
    value |= sequence << 64
    value |= 0b10 << 62
    value |= random_b
    return uuid.UUID(int=value)


def new_id() -> str:
    return str(uuid7())
