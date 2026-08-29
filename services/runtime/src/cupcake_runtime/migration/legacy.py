from __future__ import annotations

import ast
import hashlib
import json
import re
import sqlite3
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol, cast

from .models import LegacyRecord, MigrationReport

MIGRATION_NAMESPACE = uuid.UUID("057bd9d5-42b6-4f6b-9f5f-126f6e3e51ee")
MAX_STATE_FILE_BYTES = 8 * 1024 * 1024
MAX_CHROMA_DOCUMENTS = 100_000
LEGACY_IMPORT_FORMAT_VERSION = 1
EMOTIONS = ("happiness", "sadness", "anger", "fear", "creativity", "curiosity")
SENSES = ("smell", "taste", "touch")
CHROMA_JSON_EXPORTS = frozenset({"documents.json", "chroma_documents.json"})
CHROMA_DATABASES = frozenset({"chroma.sqlite3", "chroma.sqlite", "chroma.db"})
SECRET_NAMES = frozenset(
    {
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        "secrets.json",
        "credentials.json",
        "api_keys.json",
        "apikeys.json",
        "tokens.json",
    }
)
GENERATED_DIRECTORY_NAMES = frozenset(
    {"__pycache__", "generated", "build", "dist", ".git", ".venv", "venv"}
)
SECRET_PLACEHOLDER = "[legacy credential omitted]"
type JsonValue = bool | int | float | str | list[JsonValue] | dict[str, JsonValue] | None
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([a-z0-9_.-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|"
    r"secret|password|authorization)[a-z0-9_.-]*)\s*([:=])\s*"
    r"(?:bearer\s+)?(?:[\"'])?[^\s,;\"'\]}]+"
)
_KNOWN_KEY_SHAPE = re.compile(
    r"(?i)(?:\b(?:sk|xai|co|rk|nvapi)[-_][a-z0-9_-]{16,}\b|\bAIza[a-z0-9_-]{30,}\b)"
)


class MigrationSink(Protocol):
    """Persistence boundary; implementations must apply each batch atomically."""

    def contains_migration(self, migration_id: str) -> bool: ...

    def apply_migration(
        self, report: MigrationReport, records: tuple[LegacyRecord, ...]
    ) -> None: ...


class InMemoryMigrationSink:
    def __init__(self) -> None:
        self.reports: dict[str, MigrationReport] = {}
        self.records: dict[str, LegacyRecord] = {}

    def contains_migration(self, migration_id: str) -> bool:
        return migration_id in self.reports

    def apply_migration(self, report: MigrationReport, records: tuple[LegacyRecord, ...]) -> None:
        if report.migration_id in self.reports:
            return
        self.records.update((record.record_id, record) for record in records)
        self.reports[report.migration_id] = report


class LegacyImporter:
    """Imports allowlisted state only; it never reads legacy credential files."""

    def __init__(self, legacy_root: Path, sink: MigrationSink) -> None:
        self.root = legacy_root.resolve(strict=True)
        self.state = self.root if self.root.name == "state_of_mind" else self.root / "state_of_mind"
        if not self.state.is_dir() or self.state.is_symlink():
            raise ValueError("legacy state_of_mind directory was not found or is a symlink")
        self.sink = sink
        self._warnings: list[str] = []
        self._source_hashes: list[tuple[str, str]] = []

    def import_once(
        self, *, dry_run: bool = False
    ) -> tuple[MigrationReport, tuple[LegacyRecord, ...]]:
        self._warnings = []
        self._source_hashes = []
        records: list[LegacyRecord] = []
        records.extend(self._conversation())
        records.extend(self._tasks())
        records.extend(self._single_text("personality.txt", "personality", "instruction"))
        records.extend(self._thoughts())
        records.extend(self._parameters())
        records.extend(self._chroma_documents())
        fingerprint = self._fingerprint()
        migration_id = str(uuid.uuid5(MIGRATION_NAMESPACE, fingerprint))
        counts = dict(sorted(Counter(record.kind for record in records).items()))
        ignored = tuple(sorted(self._present_secret_files()))
        if self.sink.contains_migration(migration_id):
            return (
                MigrationReport(
                    migration_id,
                    fingerprint,
                    "already_imported",
                    counts,
                    tuple(self._warnings),
                    ignored,
                ),
                (),
            )
        status = "dry_run" if dry_run else ("imported" if records else "no_data")
        report = MigrationReport(
            migration_id, fingerprint, status, counts, tuple(self._warnings), ignored
        )
        result = tuple(records)
        if not dry_run:
            self.sink.apply_migration(report, result)
        return report, result

    def _conversation(self) -> list[LegacyRecord]:
        value = self._read_json(self.state / "conversation.json")
        if value is None:
            return []
        messages = value.get("conversation") if isinstance(value, dict) else None
        if not isinstance(messages, list):
            self._warnings.append("conversation.json did not contain a conversation list")
            return []
        result: list[LegacyRecord] = []
        for index, item in enumerate(messages):
            if not isinstance(item, dict):
                self._warnings.append(f"conversation message {index} was not an object")
                continue
            message = item.get("message")
            sender = item.get("sender")
            if not isinstance(message, str) or not isinstance(sender, str) or not message.strip():
                continue
            normalized = sender.strip().lower()
            role = (
                "assistant"
                if normalized in {"assistant", "ai", "alex"}
                else "summary"
                if normalized == "summary"
                else "user"
            )
            attachment = item.get("file_upload")
            payload: dict[str, Any] = {"role": role, "content": message, "legacy_sender": sender}
            if isinstance(attachment, str) and attachment.strip() and attachment.lower() != "none":
                # Preserve the label only. Never follow legacy attachment paths.
                payload["legacy_attachment_reference"] = attachment
                payload["attachment_available"] = False
            result.append(
                self._record(
                    "conversation_message",
                    f"conversation:{index}",
                    payload,
                    "state_of_mind/conversation.json",
                )
            )
        return result

    def _tasks(self) -> list[LegacyRecord]:
        value = self._read_json(self.state / "task_list.json")
        if value is None:
            return []
        tasks = value.get("tasks") if isinstance(value, dict) else None
        if not isinstance(tasks, list):
            self._warnings.append("task_list.json did not contain a tasks list")
            return []
        result: list[LegacyRecord] = []
        for index, item in enumerate(tasks):
            if not isinstance(item, dict) or not isinstance(item.get("task"), str):
                self._warnings.append(f"legacy task {index} was invalid")
                continue
            key = str(item.get("id", index))
            result.append(
                self._record(
                    "task",
                    f"task:{key}",
                    {
                        "title": item["task"],
                        "status": "pending",
                        "legacy_id": item.get("id"),
                        "legacy_created_at": item.get("task_created_time"),
                    },
                    "state_of_mind/task_list.json",
                )
            )
        return result

    def _single_text(self, filename: str, kind: str, memory_type: str) -> list[LegacyRecord]:
        value = self._read_text(self.state / filename)
        if value is None or not value.strip():
            return []
        return [
            self._record(
                kind,
                filename,
                {"content": value.strip(), "memory_type": memory_type},
                f"state_of_mind/{filename}",
            )
        ]

    def _thoughts(self) -> list[LegacyRecord]:
        raw = self._read_text(self.state / "thought_bubble.txt")
        if raw is None or not raw.strip():
            return []
        try:
            parsed = ast.literal_eval(raw)
        except (SyntaxError, ValueError):
            parsed = [raw.strip()]
            self._warnings.append("thought_bubble.txt was imported as plain text")
        thoughts = list(_flatten_strings(parsed))
        return [
            self._record(
                "thought",
                f"thought:{index}",
                {"content": thought, "memory_type": "temporary_context"},
                "state_of_mind/thought_bubble.txt",
            )
            for index, thought in enumerate(thoughts)
            if thought.strip()
        ]

    def _parameters(self) -> list[LegacyRecord]:
        result: list[LegacyRecord] = []
        for name in EMOTIONS:
            raw = self._read_text(self.state / f"{name}.txt")
            if raw is None or not raw.strip():
                continue
            try:
                value: Any = float(raw.strip())
            except ValueError:
                value = raw.strip()
                self._warnings.append(f"{name}.txt did not contain a number")
            result.append(
                self._record(
                    "emotion",
                    f"emotion:{name}",
                    {"name": name, "value": value},
                    f"state_of_mind/{name}.txt",
                )
            )
        for name in SENSES:
            raw = self._read_text(self.state / f"{name}.txt")
            if raw is not None and raw.strip():
                result.append(
                    self._record(
                        "sense",
                        f"sense:{name}",
                        {"name": name, "value": raw.strip()},
                        f"state_of_mind/{name}.txt",
                    )
                )
        return result

    def _chroma_documents(self) -> list[LegacyRecord]:
        memory = (
            self.root.parent / "memory"
            if self.root.name == "state_of_mind"
            else self.root / "memory"
        )
        if not memory.exists():
            return []
        if memory.is_symlink() or not memory.is_dir():
            self._warnings.append(
                "legacy memory directory was ignored because it is not a regular directory"
            )
            return []
        documents: list[tuple[str, str, dict[str, Any]]] = []
        for path in sorted(memory.rglob("*")):
            if len(documents) >= MAX_CHROMA_DOCUMENTS:
                self._warnings.append("legacy Chroma import reached its document limit")
                break
            if path.is_symlink():
                self._warnings.append(
                    f"ignored symlink in legacy memory: {path.relative_to(memory)}"
                )
                continue
            if not path.is_file() or not path.resolve().is_relative_to(memory.resolve()):
                continue
            relative = path.relative_to(memory)
            if any(part.casefold() in GENERATED_DIRECTORY_NAMES for part in relative.parts[:-1]):
                continue
            if _is_secret_or_executable_name(path.name):
                continue
            if path.name.casefold() in CHROMA_JSON_EXPORTS:
                documents.extend(self._json_documents(path, memory))
            elif path.name.casefold() in CHROMA_DATABASES:
                documents.extend(self._sqlite_documents(path, memory))
        unique: dict[str, tuple[str, dict[str, Any]]] = {}
        for source_key, text, metadata in documents:
            if text.strip():
                unique.setdefault(
                    hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    (source_key, metadata | {"content": text}),
                )
        return [
            self._record("chroma_text", f"chroma:{digest}", payload, source)
            for digest, (source, payload) in sorted(unique.items())
        ]

    def _json_documents(self, path: Path, memory: Path) -> list[tuple[str, str, dict[str, Any]]]:
        value = self._read_json(path, relative_to=self.root)
        if value is None:
            return []
        source = str(path.relative_to(self.root)).replace("\\", "/")
        result: list[tuple[str, str, dict[str, Any]]] = []
        candidates = (
            value.get("documents", [])
            if isinstance(value, dict)
            else value
            if isinstance(value, list)
            else []
        )
        if isinstance(candidates, list):
            for index, candidate in enumerate(candidates[:MAX_CHROMA_DOCUMENTS]):
                if isinstance(candidate, str):
                    result.append((source, candidate, {"legacy_index": index}))
                elif isinstance(candidate, dict):
                    text = candidate.get(
                        "document", candidate.get("text", candidate.get("content"))
                    )
                    if isinstance(text, str):
                        raw_metadata = candidate.get("metadata")
                        metadata: dict[str, JsonValue] = (
                            raw_metadata if isinstance(raw_metadata, dict) else {}
                        )
                        result.append(
                            (
                                source,
                                _redact_secret_text(text),
                                {
                                    "legacy_index": index,
                                    "metadata": _redact_payload(metadata),
                                },
                            )
                        )
        return result

    def _sqlite_documents(self, path: Path, memory: Path) -> list[tuple[str, str, dict[str, Any]]]:
        source = str(path.relative_to(self.root)).replace("\\", "/")
        result: list[tuple[str, str, dict[str, Any]]] = []
        try:
            connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro&immutable=1", uri=True)
            connection.execute("PRAGMA query_only=ON")
            tables = [
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
                if isinstance(row[0], str)
            ]
            for table in tables:
                if not table.replace("_", "").isalnum():
                    continue
                columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
                text_columns = [
                    column
                    for column in columns
                    if str(column).lower() in {"document", "text", "content", "string_value"}
                ]
                for column in text_columns:
                    if len(result) >= MAX_CHROMA_DOCUMENTS:
                        break
                    where = f'"{column}" IS NOT NULL'
                    parameters: tuple[object, ...]
                    if str(column).lower() == "string_value" and "key" in columns:
                        where += ' AND "key" = ?'
                        parameters = ("chroma:document", MAX_CHROMA_DOCUMENTS - len(result))
                    else:
                        parameters = (MAX_CHROMA_DOCUMENTS - len(result),)
                    query = f'SELECT rowid, "{column}" FROM "{table}" WHERE {where} LIMIT ?'
                    for row_id, text in connection.execute(query, parameters):
                        if isinstance(text, str) and text.strip():
                            result.append(
                                (
                                    source,
                                    _redact_secret_text(text),
                                    {"legacy_table": table, "legacy_row_id": row_id},
                                )
                            )
            connection.close()
        except sqlite3.Error as exc:
            self._warnings.append(
                f"could not read legacy Chroma SQLite data: {exc.__class__.__name__}"
            )
        self._source_hashes.append(
            (
                source,
                hashlib.sha256(
                    json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest(),
            )
        )
        return result

    def _read_text(self, path: Path) -> str | None:
        if not self._safe_regular_file(path):
            return None
        try:
            data = path.read_bytes()
            if len(data) > MAX_STATE_FILE_BYTES:
                self._warnings.append(f"ignored oversized legacy file: {path.name}")
                return None
            text = data.decode("utf-8-sig")
            self._source_hashes.append(
                (
                    str(path.relative_to(self.root)),
                    hashlib.sha256(_redact_secret_text(text).encode("utf-8")).hexdigest(),
                )
            )
            return text
        except (OSError, UnicodeDecodeError):
            self._warnings.append(f"could not read legacy file: {path.name}")
            return None

    def _read_json(self, path: Path, *, relative_to: Path | None = None) -> JsonValue:
        if relative_to is None:
            raw = self._read_text(path)
        else:
            if not self._safe_regular_file(path, root=relative_to):
                return None
            try:
                data = path.read_bytes()
                if len(data) > MAX_STATE_FILE_BYTES:
                    self._warnings.append(f"ignored oversized legacy JSON file: {path.name}")
                    return None
                raw = data.decode("utf-8-sig")
                self._source_hashes.append(
                    (
                        str(path.relative_to(relative_to)),
                        hashlib.sha256(_redact_secret_text(raw).encode("utf-8")).hexdigest(),
                    )
                )
            except (OSError, UnicodeDecodeError):
                return None
        if raw is None:
            return None
        try:
            # The stdlib JSON decoder guarantees this recursive value shape.
            return cast(JsonValue, json.loads(raw))
        except json.JSONDecodeError:
            self._warnings.append(f"invalid JSON was ignored: {path.name}")
            return None

    def _safe_regular_file(self, path: Path, *, root: Path | None = None) -> bool:
        boundary = (root or self.root).resolve()
        try:
            return (
                path.exists()
                and path.is_file()
                and not path.is_symlink()
                and path.resolve().is_relative_to(boundary)
            )
        except OSError:
            return False

    def _fingerprint(self) -> str:
        digest = hashlib.sha256(
            f"cupcakeagi-legacy-migration-v{LEGACY_IMPORT_FORMAT_VERSION}\0".encode()
        )
        for name, value in sorted(set(self._source_hashes)):
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(value.encode("ascii"))
            digest.update(b"\0")
        return digest.hexdigest()

    def _record(self, kind: str, key: str, payload: dict[str, Any], source: str) -> LegacyRecord:
        safe_payload = _redact_payload(payload)
        record_id = str(
            uuid.uuid5(
                MIGRATION_NAMESPACE,
                f"{kind}\0{key}\0{json.dumps(safe_payload, sort_keys=True, default=str)}",
            )
        )
        return LegacyRecord(record_id, kind, source.replace("\\", "/"), safe_payload)

    def _present_secret_files(self) -> Iterable[str]:
        candidates = (self.root, self.state, self.root.parent)
        found: set[str] = set()
        for directory in candidates:
            for name in SECRET_NAMES:
                path = directory / name
                if path.exists():
                    try:
                        found.add(str(path.relative_to(self.root)))
                    except ValueError:
                        found.add(path.name)
        return found


def _flatten_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, (list, tuple)):
        for item in cast(Sequence[object], value):
            yield from _flatten_strings(item)


def _is_secret_or_executable_name(name: str) -> bool:
    lowered = name.casefold()
    suffix = Path(lowered).suffix
    return (
        lowered in SECRET_NAMES
        or lowered.startswith(".env")
        or any(token in lowered for token in ("api_key", "apikey", "credential", "secret"))
        or suffix
        in {
            ".env",
            ".pem",
            ".key",
            ".py",
            ".pyc",
            ".pyo",
            ".ps1",
            ".bat",
            ".cmd",
            ".exe",
            ".dll",
        }
    )


def _redact_secret_text(value: str) -> str:
    value = _SECRET_ASSIGNMENT.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{SECRET_PLACEHOLDER}", value
    )
    return _KNOWN_KEY_SHAPE.sub(SECRET_PLACEHOLDER, value)


def _redact_payload(value: object) -> Any:
    if isinstance(value, str):
        return _redact_secret_text(value)
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {str(key): _redact_payload(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [_redact_payload(item) for item in cast(list[object], value)]
    if isinstance(value, tuple):
        return tuple(_redact_payload(item) for item in cast(tuple[object, ...], value))
    return value
