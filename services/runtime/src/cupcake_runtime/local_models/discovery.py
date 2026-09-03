"""Bounded, read-only discovery of community GGUF repositories.

Discovery is intentionally separate from Cupcake's signed install catalog. A
community result opens its upstream model card; it cannot enter the managed
download pipeline until an explicit trust/import flow exists.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

HUGGING_FACE_API = "https://huggingface.co/api/models"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_RESULTS = 500
_PARAMETERS = re.compile(r"(?:^|[-_/ ])(\d+(?:\.\d+)?)\s*[bB](?:[-_/ ]|$)")


def search_huggingface_gguf(
    query: str = "",
    *,
    limit: int = 24,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    """Return popular Hugging Face GGUF model cards with strict I/O bounds."""

    clean_query = _normalize_query(query)
    clean_limit = max(1, min(int(limit), MAX_RESULTS))
    parameters = {
        "filter": "gguf",
        "sort": "downloads",
        "direction": "-1",
        "limit": str(clean_limit),
        "full": "true",
    }
    if clean_query:
        parameters["search"] = clean_query
    request = Request(
        f"{HUGGING_FACE_API}?{urlencode(parameters)}",
        headers={
            "Accept": "application/json",
            "User-Agent": "CupcakeAI-Desktop/2 community-model-discovery",
        },
    )
    with opener(request, timeout=12) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("Hugging Face discovery response exceeded the safety limit")
    decoded = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, list):
        raise ValueError("Hugging Face returned an unexpected discovery response")

    items: list[dict[str, Any]] = []
    for record in decoded:
        if not isinstance(record, dict):
            continue
        model_id = record.get("modelId") or record.get("id")
        if not isinstance(model_id, str) or not model_id or len(model_id) > 240:
            continue
        tags = [str(tag)[:64] for tag in record.get("tags", []) if isinstance(tag, str)]
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
                "downloads": int(record.get("downloads") or 0),
                "likes": int(record.get("likes") or 0),
                "lastModified": record.get("lastModified"),
                "gated": bool(record.get("gated")),
                "fit": "pending",
                "fitReason": "Choose a quantization on the model card to estimate device fit.",
            }
        )
    return {
        "source": "huggingface",
        "query": clean_query,
        "count": len(items),
        "limit": clean_limit,
        "hasMore": len(items) == clean_limit,
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
