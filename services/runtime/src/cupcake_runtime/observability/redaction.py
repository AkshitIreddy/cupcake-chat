"""Recursive redaction for developer-visible runtime diagnostics."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping
from typing import Any, cast

SECRET_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "cookie",
        "credential",
        "password",
        "refresh_token",
        "secret",
        "token",
    }
)
PRIVATE_REASONING_KEYS = frozenset(
    {"chain_of_thought", "hidden_reasoning", "reasoning_content", "scratchpad"}
)
SECRET_VALUE = re.compile(
    r"(?i)(bearer\s+[a-z0-9._~+/=-]{8,}|\b(?:sk|nvapi)-[a-z0-9_-]{8,}|"
    r"(?:api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+)"
)
ABSOLUTE_PATH = re.compile(r"(?P<path>(?:[A-Za-z]:\\|/(?:home|Users|mnt|tmp|var/tmp)/)[^\s\"'<>]+)")


def _redacted_path(match: re.Match[str]) -> str:
    raw = match.group("path")
    digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
    return f"[PATH:{digest}]"


class TraceRedactor:
    def redact(self, value: object, *, key: str | None = None) -> Any:
        normalized_key = key.lower().replace("-", "_") if key else None
        if normalized_key in PRIVATE_REASONING_KEYS:
            return "[PRIVATE_REASONING_OMITTED]"
        if normalized_key in SECRET_KEYS or (
            normalized_key
            and any(part in normalized_key for part in ("secret", "password", "token"))
        ):
            return "[REDACTED]"
        if isinstance(value, Mapping):
            mapping = cast(Mapping[object, object], value)
            return {
                str(item_key): self.redact(item, key=str(item_key))
                for item_key, item in mapping.items()
            }
        if isinstance(value, (list, tuple, set, frozenset)):
            return [self.redact(item) for item in cast(Iterable[object], value)]
        if isinstance(value, bytes):
            return f"[BYTES:{len(value)}]"
        if isinstance(value, str):
            redacted = SECRET_VALUE.sub("[REDACTED]", value)
            return ABSOLUTE_PATH.sub(_redacted_path, redacted)
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return f"[{type(value).__name__}]"
