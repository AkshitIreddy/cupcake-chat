from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any

from .models import ToolDescriptor


class ToolRegistry:
    """Version-aware registry that invalidates stale schemas explicitly."""

    def __init__(self, descriptors: Iterable[ToolDescriptor] = ()) -> None:
        self._tools: dict[str, dict[str, ToolDescriptor]] = {}
        for descriptor in descriptors:
            self.register(descriptor)

    def register(self, descriptor: ToolDescriptor) -> None:
        versions = self._tools.setdefault(descriptor.name, {})
        existing = versions.get(descriptor.version)
        if existing and existing != descriptor:
            raise ValueError(f"conflicting descriptor for {descriptor.identity}")
        versions[descriptor.version] = descriptor

    def unregister(self, name: str, version: str | None = None) -> None:
        if version is None:
            self._tools.pop(name, None)
            return
        versions = self._tools.get(name)
        if not versions:
            return
        versions.pop(version, None)
        if not versions:
            self._tools.pop(name, None)

    def get(self, name: str, version: str) -> ToolDescriptor:
        try:
            return self._tools[name][version]
        except KeyError as exc:
            raise KeyError(f"unknown tool {name}@{version}") from exc

    def list(self) -> tuple[ToolDescriptor, ...]:
        return tuple(
            descriptor
            for name in sorted(self._tools)
            for _, descriptor in sorted(self._tools[name].items())
        )

    def validate_arguments(self, descriptor: ToolDescriptor, arguments: Mapping[str, Any]) -> None:
        """Validate the safe JSON-schema subset required at the runtime boundary.

        Full validation is repeated by the Rust broker; this rejects malformed
        model output early without adding a Python dependency.
        """
        schema = descriptor.input_schema
        required = schema.get("required", [])
        missing = [key for key in required if key not in arguments]
        if missing:
            raise ValueError(f"missing required tool arguments: {', '.join(missing)}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extras = sorted(set(arguments) - set(properties))
            if extras:
                raise ValueError(f"unknown tool arguments: {', '.join(extras)}")
        for key, value in arguments.items():
            expected = properties.get(key, {}).get("type")
            if expected and not _matches_type(value, expected):
                raise ValueError(f"argument {key!r} must be {expected}")


def _matches_type(value: object, expected: str | list[str]) -> bool:
    allowed = [expected] if isinstance(expected, str) else expected
    checks: dict[str, Callable[[object], bool]] = {
        "null": lambda item: item is None,
        "boolean": lambda item: isinstance(item, bool),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
        "string": lambda item: isinstance(item, str),
        "array": lambda item: isinstance(item, list),
        "object": lambda item: isinstance(item, dict),
    }
    return any(checks.get(kind, lambda _item: False)(value) for kind in allowed)
