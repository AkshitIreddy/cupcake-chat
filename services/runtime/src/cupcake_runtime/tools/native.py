from __future__ import annotations

from typing import Any

from .models import DataDestination, DataFlowDisclosure, Effect, ToolDescriptor


def _object(properties: dict[str, Any], required: tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


def _descriptor(
    name: str,
    display_name: str,
    description: str,
    properties: dict[str, Any],
    required: tuple[str, ...],
    effects: frozenset[Effect],
    *,
    grants: tuple[str, ...] = (),
    flows: tuple[DataFlowDisclosure, ...] = (),
    timeout: int = 60,
) -> ToolDescriptor:
    return ToolDescriptor(
        name=name,
        version="1.0.0",
        display_name=display_name,
        description=description,
        input_schema=_object(properties, required),
        output_schema={"type": "object"},
        effects=effects,
        required_grants=grants,
        default_data_flows=flows,
        timeout_seconds=timeout,
    )


def native_tool_descriptors() -> tuple[ToolDescriptor, ...]:
    """The complete built-in surface; implementations live behind ToolBroker."""
    local = DataFlowDisclosure(
        DataDestination.LOCAL, "This device", ("requested input",), "Complete the tool action"
    )
    web = DataFlowDisclosure(
        DataDestination.PUBLIC_WEB,
        "Requested website",
        ("query or URL",),
        "Retrieve public information",
        True,
    )
    path = {"type": "string", "minLength": 1}
    return (
        _descriptor(
            "files.read",
            "Read file",
            "Read an approved local file without modifying it.",
            {
                "grant_id": {"type": "string"},
                "relative_path": path,
                "max_bytes": {"type": "integer"},
            },
            ("grant_id", "relative_path"),
            frozenset({Effect.READ_FILES}),
            grants=("filesystem.read",),
            flows=(local,),
        ),
        _descriptor(
            "files.search",
            "Search files",
            "Search text inside an approved folder.",
            {
                "grant_id": {"type": "string"},
                "query": path,
                "globs": {"type": "array"},
                "max_results": {"type": "integer"},
            },
            ("grant_id", "query"),
            frozenset({Effect.READ_FILES}),
            grants=("filesystem.read",),
            flows=(local,),
        ),
        _descriptor(
            "repository.inspect",
            "Inspect repository",
            "Read repository status, refs, and metadata.",
            {
                "grant_id": {"type": "string"},
                "operation": {"type": "string"},
                "revision": {"type": ["string", "null"]},
            },
            ("grant_id", "operation"),
            frozenset({Effect.READ_FILES}),
            grants=("repository.read",),
            flows=(local,),
        ),
        _descriptor(
            "repository.propose_patch",
            "Propose patch",
            "Stage a reviewable patch without applying it to the repository.",
            {"grant_id": {"type": "string"}, "patch": path, "base_revision": path},
            ("grant_id", "patch", "base_revision"),
            frozenset({Effect.READ_FILES}),
            grants=("repository.read",),
            flows=(local,),
        ),
        _descriptor(
            "repository.apply_patch",
            "Apply approved patch",
            "Apply the exact reviewed patch to the approved repository.",
            {"grant_id": {"type": "string"}, "patch_digest": path, "base_revision": path},
            ("grant_id", "patch_digest", "base_revision"),
            frozenset({Effect.READ_FILES, Effect.WRITE_FILES}),
            grants=("repository.write",),
            flows=(local,),
        ),
        _descriptor(
            "web.search",
            "Search the web",
            "Search public web sources using the configured provider.",
            {
                "query": path,
                "domains": {"type": "array"},
                "recency_days": {"type": ["integer", "null"]},
            },
            ("query",),
            frozenset({Effect.NETWORK}),
            flows=(web,),
        ),
        _descriptor(
            "web.fetch",
            "Fetch webpage",
            "Fetch one approved HTTP or HTTPS resource with bounded size.",
            {"url": path, "max_bytes": {"type": "integer"}},
            ("url",),
            frozenset({Effect.NETWORK}),
            flows=(web,),
        ),
        _descriptor(
            "python.run",
            "Run Python",
            "Run a staged Python program in the resource-limited offline sandbox.",
            {
                "source": path,
                "input_files": {"type": "array"},
                "timeout_seconds": {"type": "integer"},
                "memory_mb": {"type": "integer"},
            },
            ("source",),
            frozenset({Effect.EXECUTE_CODE}),
            grants=("sandbox.execute",),
            flows=(local,),
            timeout=900,
        ),
        _descriptor(
            "models.manage",
            "Manage local model",
            "Download, verify, load, unload, or remove a local model.",
            {
                "operation": {"type": "string"},
                "model_id": path,
                "expected_digest": {"type": ["string", "null"]},
            },
            ("operation", "model_id"),
            frozenset({Effect.NETWORK, Effect.WRITE_FILES, Effect.INSTALL}),
            grants=("models.manage",),
            flows=(local,),
            timeout=86_400,
        ),
        _descriptor(
            "artifacts.create",
            "Create artifact",
            "Create an immutable artifact revision.",
            {
                "artifact_type": path,
                "title": path,
                "content": {},
                "project_id": {"type": ["string", "null"]},
            },
            ("artifact_type", "title", "content"),
            frozenset({Effect.WRITE_FILES}),
            grants=("artifacts.write",),
            flows=(local,),
        ),
        _descriptor(
            "artifacts.update",
            "Update artifact",
            "Create a child revision from an existing artifact revision.",
            {"artifact_id": path, "base_revision_id": path, "content": {}},
            ("artifact_id", "base_revision_id", "content"),
            frozenset({Effect.WRITE_FILES}),
            grants=("artifacts.write",),
            flows=(local,),
        ),
        _descriptor(
            "artifacts.export",
            "Export artifact",
            "Export an artifact through an approved destination grant.",
            {
                "artifact_id": path,
                "revision_id": path,
                "destination_grant_id": path,
                "format": path,
            },
            ("artifact_id", "revision_id", "destination_grant_id", "format"),
            frozenset({Effect.WRITE_FILES}),
            grants=("filesystem.write",),
            flows=(local,),
        ),
    )
