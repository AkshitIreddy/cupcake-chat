from __future__ import annotations

import pytest

from cupcake_runtime.mcp.models import (
    MCPCallBrokerRequest,
    MCPConnectionDescriptor,
    MCPOAuthConfig,
    MCPTransport,
)
from cupcake_runtime.mcp.schema_cache import MCPToolSchema, SchemaCatalog
from cupcake_runtime.mcp.security import OriginError, validate_origin, validate_resolved_addresses


def remote(**overrides: object) -> MCPConnectionDescriptor:
    values: dict[str, object] = {
        "connection_id": "remote-1",
        "display_name": "Remote service",
        "transport": MCPTransport.STREAMABLE_HTTP,
        "endpoint": "https://mcp.example.test/rpc",
        "allowed_origins": ("https://mcp.example.test",),
    }
    values.update(overrides)
    return MCPConnectionDescriptor(**values)  # type: ignore[arg-type]


def test_connection_descriptors_separate_stdio_and_remote_fields() -> None:
    local = MCPConnectionDescriptor(
        "local", "Local", MCPTransport.STDIO, command=("server", "--stdio")
    )
    assert local.command == ("server", "--stdio")
    with pytest.raises(ValueError, match="HTTPS"):
        remote(endpoint="http://mcp.example.test")
    with pytest.raises(ValueError, match="remote connection fields"):
        MCPConnectionDescriptor(
            "bad", "Bad", MCPTransport.STDIO, command=("server",), endpoint="https://example.test"
        )
    with pytest.raises(ValueError, match="explicit allowed origin"):
        remote(allowed_origins=())
    with pytest.raises(ValueError, match="authorization endpoint"):
        MCPOAuthConfig(
            "http://oauth.example.test/authorize",
            "https://oauth.example.test/token",
            "client",
            "http://127.0.0.1:1234/callback",
        )


def test_origin_and_dns_validation_block_rebinding_and_private_targets() -> None:
    validate_origin("https://MCP.EXAMPLE.test:443/path", ("https://mcp.example.test",))
    with pytest.raises(OriginError, match="allowlisted"):
        validate_origin("https://evil.example.test", ("https://mcp.example.test",))
    with pytest.raises(OriginError, match="port"):
        validate_origin("https://mcp.example.test:99999", ("https://mcp.example.test",))
    with pytest.raises(OriginError, match="non-public"):
        validate_resolved_addresses(("93.184.216.34", "127.0.0.1"))
    assert validate_resolved_addresses(("127.0.0.1",), allow_private_network=True) == ("127.0.0.1",)


def test_schema_change_invalidates_approvals_and_stale_calls() -> None:
    catalog = SchemaCatalog()
    original = MCPToolSchema(
        "lookup", "Lookup", {"type": "object", "properties": {"q": {"type": "string"}}}
    )
    first = catalog.update("remote-1", (original,))
    assert not first.invalidated_approvals
    catalog.get("remote-1", "lookup", expected_catalog_digest=first.catalog_digest)
    changed = MCPToolSchema(
        "lookup", "Lookup", {"type": "object", "properties": {"q": {"type": "integer"}}}
    )
    second = catalog.update("remote-1", (changed,))
    assert second.invalidated_approvals and second.changed == frozenset({"lookup"})
    with pytest.raises(ValueError, match="changed"):
        catalog.get("remote-1", "lookup", expected_catalog_digest=first.catalog_digest)

    wire = MCPCallBrokerRequest(
        "remote-1", "invoke-1", "lookup", {"q": 1}, second.catalog_digest
    ).to_wire()
    assert wire["request_type"] == "mcp.tool.call"
    assert wire["payload"]["catalog_digest"] == second.catalog_digest
