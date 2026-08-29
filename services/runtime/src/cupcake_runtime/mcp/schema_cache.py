from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class MCPToolSchema:
    name: str
    description: str
    input_schema: Mapping[str, Any]
    output_schema: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if not self.name or self.input_schema.get("type") != "object":
            raise ValueError("MCP tools require a name and object input schema")

    @property
    def digest(self) -> str:
        return _digest(
            {
                "name": self.name,
                "description": self.description,
                "input": self.input_schema,
                "output": self.output_schema,
            }
        )


@dataclass(frozen=True, slots=True)
class SchemaChange:
    connection_id: str
    previous_catalog_digest: str | None
    catalog_digest: str
    added: frozenset[str]
    removed: frozenset[str]
    changed: frozenset[str]
    invalidated_approvals: bool


class SchemaCatalog:
    """Pins tool schemas and signals when prior approvals must be discarded."""

    def __init__(self) -> None:
        self._catalogs: dict[str, dict[str, MCPToolSchema]] = {}
        self._digests: dict[str, str] = {}

    def update(self, connection_id: str, tools: Iterable[MCPToolSchema]) -> SchemaChange:
        catalog: dict[str, MCPToolSchema] = {}
        for tool in tools:
            if tool.name in catalog:
                raise ValueError(f"duplicate MCP tool schema: {tool.name}")
            catalog[tool.name] = tool
        digest = _digest({name: tool.digest for name, tool in sorted(catalog.items())})
        previous = self._catalogs.get(connection_id, {})
        previous_digest = self._digests.get(connection_id)
        added = frozenset(catalog.keys() - previous.keys())
        removed = frozenset(previous.keys() - catalog.keys())
        changed = frozenset(
            name
            for name in catalog.keys() & previous.keys()
            if catalog[name].digest != previous[name].digest
        )
        self._catalogs[connection_id] = catalog
        self._digests[connection_id] = digest
        return SchemaChange(
            connection_id,
            previous_digest,
            digest,
            added,
            removed,
            changed,
            previous_digest is not None and previous_digest != digest,
        )

    def get(
        self, connection_id: str, tool_name: str, *, expected_catalog_digest: str
    ) -> MCPToolSchema:
        actual = self._digests.get(connection_id)
        if not actual or actual != expected_catalog_digest:
            raise ValueError("MCP tool catalog changed; refresh and approve again")
        try:
            return self._catalogs[connection_id][tool_name]
        except KeyError as exc:
            raise KeyError(f"unknown MCP tool {tool_name!r}") from exc


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(raw).hexdigest()
