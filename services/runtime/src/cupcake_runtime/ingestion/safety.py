from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

from .models import LimitExceededError, UnsafeSourceError


def safe_source_path(path: Path, root: Path) -> Path:
    root = root.resolve(strict=True)
    if root.is_file():
        root = root.parent
    try:
        resolved = path.resolve(strict=True)
    except (FileNotFoundError, RuntimeError) as exc:
        raise UnsafeSourceError(f"source cannot be resolved safely: {path}") from exc
    if not resolved.is_relative_to(root):
        raise UnsafeSourceError(f"source escapes its granted root: {path}")
    # Reject links even when their target is in-root. This prevents a target swap
    # between preflight and read on platforms without an openat-style safe handle.
    cursor = path.absolute()
    while cursor != root.parent and cursor != cursor.parent:
        if cursor.is_symlink():
            raise UnsafeSourceError(f"symbolic links are not ingested: {path}")
        if cursor == root:
            break
        cursor = cursor.parent
    return resolved


def validate_archive_member(name: str) -> PurePosixPath:
    if not name or "\x00" in name:
        raise UnsafeSourceError("archive contains an empty or NUL-bearing member name")
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    if member.is_absolute() or any(part in ("", ".", "..") for part in member.parts):
        raise UnsafeSourceError(f"archive member escapes extraction root: {name!r}")
    if len(member.parts) > 32:
        raise LimitExceededError(f"archive member nesting exceeds 32 segments: {name!r}")
    # Windows drive and NT namespace paths are unsafe even when parsed on POSIX.
    first = member.parts[0]
    if ":" in first or first.startswith("//"):
        raise UnsafeSourceError(f"archive member has an unsafe root: {name!r}")
    return member


def read_bounded(path: Path, max_bytes: int) -> bytes:
    stat = path.stat(follow_symlinks=False)
    if stat.st_size > max_bytes:
        raise LimitExceededError(f"source exceeds {max_bytes} bytes: {path.name}")
    flags = os.O_RDONLY
    # Windows defaults low-level descriptors to text mode; a ZIP byte such as
    # Ctrl-Z can otherwise be interpreted as EOF and silently truncate input.
    flags |= int(getattr(os, "O_BINARY", 0))
    flags |= int(getattr(os, "O_NOFOLLOW", 0))
    fd = os.open(path, flags)
    try:
        data = bytearray()
        while len(data) <= max_bytes:
            block = os.read(fd, min(1024 * 1024, max_bytes + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > max_bytes:
            raise LimitExceededError(f"source exceeds {max_bytes} bytes: {path.name}")
        return bytes(data)
    finally:
        os.close(fd)
