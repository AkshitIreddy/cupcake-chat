from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any, cast
from urllib.parse import urlsplit

MCP_BROKER_PROTOCOL_VERSION = 1


class MCPTransport(StrEnum):
    STDIO = "stdio"
    STREAMABLE_HTTP = "streamable_http"


@dataclass(frozen=True, slots=True)
class MCPOAuthConfig:
    authorization_endpoint: str
    token_endpoint: str
    client_id: str
    redirect_uri: str
    scopes: tuple[str, ...] = ()
    pkce_method: str = "S256"

    def __post_init__(self) -> None:
        if self.pkce_method != "S256":
            raise ValueError("MCP OAuth requires PKCE S256")
        for name, value in (
            ("authorization endpoint", self.authorization_endpoint),
            ("token endpoint", self.token_endpoint),
            ("redirect URI", self.redirect_uri),
        ):
            parsed = urlsplit(value)
            try:
                _ = parsed.port
            except ValueError as exc:
                raise ValueError(f"invalid OAuth {name}") from exc
            is_loopback_redirect = (
                name == "redirect URI"
                and parsed.scheme == "http"
                and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
            )
            if (
                not parsed.hostname
                or parsed.username
                or parsed.password
                or (parsed.scheme != "https" and not is_loopback_redirect)
            ):
                raise ValueError(f"invalid OAuth {name}")
        if not self.client_id:
            raise ValueError("OAuth client ID is required")


@dataclass(frozen=True, slots=True)
class MCPConnectionDescriptor:
    connection_id: str
    display_name: str
    transport: MCPTransport
    command: tuple[str, ...] = ()
    endpoint: str | None = None
    allowed_origins: tuple[str, ...] = ()
    oauth: MCPOAuthConfig | None = None
    credential_ref: str | None = None
    allowed_tools: tuple[str, ...] = ()
    allow_private_network: bool = False
    connect_timeout_seconds: int = 15

    def __post_init__(self) -> None:
        if not self.connection_id or not self.display_name.strip():
            raise ValueError("MCP connection identity is required")
        if self.connect_timeout_seconds < 1 or self.connect_timeout_seconds > 120:
            raise ValueError("MCP connection timeout is outside the safe range")
        if self.transport == MCPTransport.STDIO:
            if not self.command or any(not part or "\x00" in part for part in self.command):
                raise ValueError("stdio MCP requires a non-empty argument vector")
            if self.endpoint or self.allowed_origins or self.oauth or self.credential_ref:
                raise ValueError("stdio MCP cannot include remote connection fields")
        elif self.transport == MCPTransport.STREAMABLE_HTTP:
            if self.command or not self.endpoint:
                raise ValueError("remote MCP requires an endpoint and no command")
            parsed = urlsplit(self.endpoint)
            try:
                _ = parsed.port
            except ValueError as exc:
                raise ValueError("remote MCP endpoint has an invalid port") from exc
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.fragment
            ):
                raise ValueError(
                    "remote MCP endpoint must be an HTTPS URL without user info or fragment"
                )
            if not self.allowed_origins:
                raise ValueError("remote MCP requires at least one explicit allowed origin")
        if len(self.allowed_tools) != len(set(self.allowed_tools)):
            raise ValueError("allowed MCP tools must be unique")


@dataclass(frozen=True, slots=True)
class MCPConnectBrokerRequest:
    connection: MCPConnectionDescriptor
    request_type: str = field(default="mcp.connect", init=False)

    def to_wire(self) -> dict[str, Any]:
        return _wire_request(self.request_type, {"connection": asdict(self.connection)})


@dataclass(frozen=True, slots=True)
class MCPListToolsBrokerRequest:
    connection_id: str
    expected_catalog_digest: str | None = None
    request_type: str = field(default="mcp.tools.list", init=False)

    def to_wire(self) -> dict[str, Any]:
        return _wire_request(self.request_type, asdict(self))


@dataclass(frozen=True, slots=True)
class MCPCallBrokerRequest:
    connection_id: str
    invocation_id: str
    tool_name: str
    arguments: Mapping[str, Any]
    catalog_digest: str
    approval_digest: str | None = None
    request_type: str = field(default="mcp.tool.call", init=False)

    def __post_init__(self) -> None:
        if not all((self.connection_id, self.invocation_id, self.tool_name, self.catalog_digest)):
            raise ValueError("MCP call identity and catalog digest are required")

    def to_wire(self) -> dict[str, Any]:
        return _wire_request(self.request_type, asdict(self))


@dataclass(frozen=True, slots=True)
class MCPDisconnectBrokerRequest:
    connection_id: str
    reason: str = "requested"
    request_type: str = field(default="mcp.disconnect", init=False)

    def to_wire(self) -> dict[str, Any]:
        return _wire_request(self.request_type, asdict(self))


def _wire_request(request_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    clean = dict(payload)
    clean.pop("request_type", None)
    clean = _convert(clean)
    return {
        "protocol_version": MCP_BROKER_PROTOCOL_VERSION,
        "request_type": request_type,
        "payload": clean,
    }


def _convert(value: object) -> Any:
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, tuple | list):
        return [_convert(item) for item in cast(tuple[object, ...] | list[object], value)]
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {str(key): _convert(item) for key, item in mapping.items()}
    return value
