"""Pydantic tool definitions that can only be fulfilled by the Rust broker."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pydantic_ai import CallDeferred
from pydantic_ai.tools import ObjectJsonSchema, RunContext, ToolDefinition
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.toolsets.abstract import ToolsetTool
from pydantic_core import SchemaValidator, core_schema


class BrokerDeferredToolset(AbstractToolset[object]):
    """Expose schemas to the model without executing privileged Python code."""

    def __init__(self, tools: tuple[Mapping[str, Any], ...]) -> None:
        self._tools = self._build(tools)

    @property
    def id(self) -> str:
        return "cupcake-broker-deferred-v1"

    @staticmethod
    def _build(tools: tuple[Mapping[str, Any], ...]) -> dict[str, ToolsetTool[object]]:
        result: dict[str, ToolsetTool[object]] = {}
        validator = SchemaValidator(core_schema.dict_schema())
        for raw in tools:
            name = raw.get("name")
            if not isinstance(name, str) or not name or len(name) > 128:
                raise ValueError("every tool requires a non-empty name of at most 128 characters")
            if name in result:
                raise ValueError(f"duplicate tool name: {name}")
            raw_schema = raw.get(
                "parameters_json_schema", raw.get("input_schema", raw.get("schema"))
            )
            schema: ObjectJsonSchema
            if raw_schema is None:
                schema = {"type": "object", "properties": {}, "additionalProperties": False}
            elif isinstance(raw_schema, Mapping):
                schema = dict(cast(Mapping[str, Any], raw_schema))
            else:
                raise ValueError(f"tool {name!r} schema must be an object")
            description_value = raw.get("description")
            description = str(description_value) if description_value is not None else None
            definition = ToolDefinition(
                name=name,
                description=description,
                parameters_json_schema=schema,
                kind="external",
                strict=bool(raw.get("strict", False)),
                sequential=bool(raw.get("sequential", False)),
                metadata={
                    "broker_only": True,
                    "tool_id": str(raw.get("id", name)),
                    "effects": raw.get("effects", []),
                },
            )
            # The toolset reference is filled after construction by get_tools.
            result[name] = ToolsetTool(
                toolset=cast(Any, None),
                tool_def=definition,
                max_retries=0,
                args_validator=validator,
            )
        return result

    async def get_tools(self, ctx: RunContext[object]) -> dict[str, ToolsetTool[object]]:
        del ctx
        return {
            name: ToolsetTool(
                toolset=self,
                tool_def=tool.tool_def,
                max_retries=tool.max_retries,
                args_validator=tool.args_validator,
            )
            for name, tool in self._tools.items()
        }

    async def call_tool(
        self,
        name: str,
        tool_args: dict[str, Any],
        ctx: RunContext[object],
        tool: ToolsetTool[object],
    ) -> Any:
        del ctx, tool
        # Defense in depth: `kind="external"` normally causes Pydantic AI to
        # defer before this method is entered. If framework behavior changes,
        # Python still cannot execute the requested effect.
        raise CallDeferred(
            metadata={"destination": "rust-broker", "tool": name, "arguments": tool_args}
        )
