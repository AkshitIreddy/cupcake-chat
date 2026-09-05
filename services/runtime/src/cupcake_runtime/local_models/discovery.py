"""Bounded, read-only discovery of community GGUF repositories.

Discovery is intentionally separate from Cupcake's signed install catalog. A
community result opens its upstream model card; it cannot enter the managed
download pipeline until an explicit trust/import flow exists.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any, Protocol, cast, runtime_checkable
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

HUGGING_FACE_API = "https://huggingface.co/api/models"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_PAGE_SIZE = 100
_PARAMETERS = re.compile(r"(?:^|[-_/ ])(\d+(?:\.\d+)?)\s*[bB](?:[-_/ ]|$)")
_CURSOR = re.compile(r"^[A-Za-z0-9_-]{1,4096}$")


@runtime_checkable
class _HeaderGetter(Protocol):
    def get(self, key: str, default: object = None, /) -> object: ...


@runtime_checkable
class _ResponseHeaderGetter(Protocol):
    def getheader(self, name: str, default: object = None, /) -> object: ...


def search_huggingface_gguf(
    query: str = "",
    *,
    limit: int = 24,
    cursor: str | None = None,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    """Return one bounded page of Hugging Face GGUF model cards."""

    clean_query = _normalize_query(query)
    clean_limit = max(1, min(int(limit), MAX_PAGE_SIZE))
    clean_cursor = _normalize_cursor(cursor)
    parameters = {
        "filter": "gguf",
        "sort": "downloads",
        "direction": "-1",
        "limit": str(clean_limit),
        "full": "true",
    }
    if clean_query:
        parameters["search"] = clean_query
    if clean_cursor:
        parameters["cursor"] = clean_cursor
    request = Request(
        f"{HUGGING_FACE_API}?{urlencode(parameters)}",
        headers={
            "Accept": "application/json",
            "User-Agent": "CupcakeAI-Desktop/2 community-model-discovery",
        },
    )
    with opener(request, timeout=12) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
        link_header = _response_header(response, "Link")
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("Hugging Face discovery response exceeded the safety limit")
    decoded: object = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, list):
        raise ValueError("Hugging Face returned an unexpected discovery response")

    items: list[dict[str, Any]] = []
    for decoded_record in cast(list[object], decoded):
        if not isinstance(decoded_record, dict):
            continue
        untyped_record = cast(dict[object, object], decoded_record)
        if not all(isinstance(key, str) for key in untyped_record):
            continue
        record = cast(dict[str, object], untyped_record)
        model_id = record.get("modelId") or record.get("id")
        if not isinstance(model_id, str) or not model_id or len(model_id) > 240:
            continue
        decoded_tags = record.get("tags")
        tags = (
            [tag[:64] for tag in cast(list[object], decoded_tags) if isinstance(tag, str)]
            if isinstance(decoded_tags, list)
            else []
        )
        license_tag = next(
            (tag.removeprefix("license:") for tag in tags if tag.startswith("license:")),
            None,
        )
        parameter_match = _PARAMETERS.search(model_id)
        author, _, short_name = model_id.partition("/")
        if not short_name:
            short_name = author
            author = "Hugging Face"
        capability_tags = [
            tag
            for tag in tags
            if tag in {"text-generation", "conversational", "vision", "multimodal", "coding"}
        ][:3]
        if "gguf" not in {tag.lower() for tag in capability_tags}:
            capability_tags.append("GGUF")
        items.append(
            {
                "id": f"hf:{model_id}",
                "provider": "Hugging Face",
                "name": short_name.removesuffix("-GGUF").replace("_", " "),
                "route": "Local",
                "tags": capability_tags or ["GGUF"],
                "context": "See model card",
                "cost": "Local",
                "status": "community",
                "description": (
                    f"Community GGUF published by {author}. Review the model card, files, "
                    "license, and compatibility before importing."
                ),
                "source": "Hugging Face Hub",
                "sourceUrl": f"https://huggingface.co/{quote(model_id, safe='/')}",
                "license": license_tag,
                "parameters": f"{parameter_match.group(1)}B" if parameter_match else None,
                "downloads": _json_integer(record.get("downloads")),
                "likes": _json_integer(record.get("likes")),
                "lastModified": record.get("lastModified"),
                "gated": bool(record.get("gated")),
                "fit": "pending",
                "fitReason": "Choose a quantization on the model card to estimate device fit.",
            }
        )
    next_cursor = _next_cursor(link_header)
    return {
        "source": "huggingface",
        "query": clean_query,
        "count": len(items),
        "limit": clean_limit,
        "hasMore": bool(next_cursor),
        "nextCursor": next_cursor,
        "models": items,
    }


def _normalize_query(query: object) -> str:
    """Accept keywords, publisher/model IDs, and pasted Hugging Face URLs."""

    clean = " ".join(str(query).strip().split())
    if clean.startswith(("https://huggingface.co/", "http://huggingface.co/")):
        parsed = urlparse(clean)
        segments = [unquote(part) for part in parsed.path.split("/") if part]
        if len(segments) >= 2:
            clean = "/".join(segments[:2])
    return clean[:120]


def _normalize_cursor(cursor: object) -> str | None:
    """Only accept opaque cursor tokens previously issued by the Hub."""

    if cursor is None:
        return None
    clean = str(cursor).strip()
    if not _CURSOR.fullmatch(clean):
        raise ValueError("invalid Hugging Face pagination cursor")
    return clean


def _response_header(response: object, name: str) -> str | None:
    headers: object = getattr(response, "headers", None)
    value = headers.get(name) if isinstance(headers, _HeaderGetter) else None
    if value is None and isinstance(response, _ResponseHeaderGetter):
        value = response.getheader(name)
    return str(value) if value else None


def _json_integer(value: object) -> int:
    """Preserve JSON integer coercion after validating the decoded boundary."""

    if value is None or value is False or value == "":
        return 0
    if isinstance(value, str | int | float):
        return int(value)
    raise TypeError(f"expected a JSON number, got {type(value).__name__}")


def _next_cursor(link_header: str | None) -> str | None:
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' not in part and "rel=next" not in part:
            continue
        match = re.search(r"<([^>]+)>", part)
        if not match:
            continue
        values = parse_qs(urlparse(match.group(1)).query).get("cursor", [])
        if values and _CURSOR.fullmatch(values[0]):
            return values[0]
    return None
