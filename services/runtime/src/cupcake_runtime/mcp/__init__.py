"""Security-focused Model Context Protocol connection contracts."""

from .models import (
    MCPCallBrokerRequest,
    MCPConnectBrokerRequest,
    MCPConnectionDescriptor,
    MCPDisconnectBrokerRequest,
    MCPListToolsBrokerRequest,
    MCPOAuthConfig,
    MCPTransport,
)
from .schema_cache import MCPToolSchema, SchemaCatalog, SchemaChange
from .security import OriginError, validate_origin, validate_resolved_addresses

__all__ = [
    "MCPCallBrokerRequest",
    "MCPConnectBrokerRequest",
    "MCPConnectionDescriptor",
    "MCPDisconnectBrokerRequest",
    "MCPListToolsBrokerRequest",
    "MCPOAuthConfig",
    "MCPToolSchema",
    "MCPTransport",
    "OriginError",
    "SchemaCatalog",
    "SchemaChange",
    "validate_origin",
    "validate_resolved_addresses",
]
