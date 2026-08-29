from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from urllib.parse import urlsplit


class OriginError(ValueError):
    pass


def canonical_origin(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise OriginError("invalid origin")
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise OriginError("invalid origin port") from exc
    default = (parsed.scheme == "https" and parsed_port in {None, 443}) or (
        parsed.scheme == "http" and parsed_port in {None, 80}
    )
    port = "" if default else f":{parsed_port}"
    return f"{parsed.scheme}://{parsed.hostname.lower()}{port}"


def validate_origin(received_origin: str, allowed_origins: Iterable[str]) -> None:
    received = canonical_origin(received_origin)
    allowed = {canonical_origin(origin) for origin in allowed_origins}
    if received not in allowed:
        raise OriginError("MCP response origin is not allowlisted")


def validate_resolved_addresses(
    addresses: Iterable[str], *, allow_private_network: bool = False
) -> tuple[str, ...]:
    """Validate every DNS answer to prevent mixed-answer and rebinding bypasses."""
    resolved = tuple(addresses)
    if not resolved:
        raise OriginError("MCP hostname did not resolve")
    for address in resolved:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise OriginError("MCP resolver returned an invalid address") from exc
        if not allow_private_network and not ip.is_global:
            raise OriginError("MCP endpoint resolved to a non-public address")
        if ip.is_unspecified or ip.is_multicast:
            raise OriginError("MCP endpoint resolved to a forbidden address")
    return resolved
