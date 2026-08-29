from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cupcake_runtime.domain.ids import new_id


def utc_now() -> datetime:
    return datetime.now(UTC)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, use_enum_values=False)


class ConversationStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class MessageState(StrEnum):
    COMPLETE = "complete"
    CANCELLED = "cancelled"
    ERROR = "error"


class ArtifactKind(StrEnum):
    DOCUMENT = "document"
    CODE = "code"
    CONFIGURATION = "configuration"
    TABLE = "table"
    SPREADSHEET = "spreadsheet"
    IMAGE = "image"
    DIAGRAM = "diagram"
    WEBPAGE = "webpage"
    REPORT = "report"


class SearchEntityType(StrEnum):
    CONVERSATION = "conversation"
    MESSAGE = "message"
    PROJECT = "project"
    FILE = "file"
    MEMORY = "memory"
    TASK = "task"
    ARTIFACT = "artifact"


class Project(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10_000)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    archived_at: datetime | None = None


class ProjectFile(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    project_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1, max_length=512)
    grant_token: str = Field(min_length=1, max_length=512)
    relative_path: str = Field(min_length=1, max_length=4096)
    media_type: str = Field(default="application/octet-stream", max_length=255)
    byte_size: int = Field(ge=0)
    content_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    parse_status: str = Field(default="pending", max_length=40)
    indexed_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Conversation(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    project_id: str | None = None
    title: str = Field(default="New conversation", min_length=1, max_length=500)
    status: ConversationStatus = ConversationStatus.ACTIVE
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ConversationBranch(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    conversation_id: str = Field(min_length=1)
    name: str = Field(default="Main", min_length=1, max_length=200)
    forked_from_message_id: str | None = None
    head_message_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Message(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    conversation_id: str = Field(min_length=1)
    branch_id: str = Field(min_length=1)
    parent_message_id: str | None = None
    role: MessageRole
    content: str
    state: MessageState = MessageState.COMPLETE
    model_id: str | None = Field(default=None, max_length=500)
    provider_id: str | None = Field(default=None, max_length=100)
    run_id: str | None = None
    canonical_metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class Artifact(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    project_id: str | None = None
    conversation_id: str | None = None
    title: str = Field(min_length=1, max_length=500)
    kind: ArtifactKind
    media_type: str = Field(min_length=1, max_length=255)
    current_revision_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ArtifactRevision(StrictModel):
    id: str = Field(default_factory=new_id, min_length=1)
    artifact_id: str = Field(min_length=1)
    parent_revision_id: str | None = None
    object_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_size: int = Field(ge=0)
    summary: str = Field(default="", max_length=10_000)
    source_message_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class SearchDocument(StrictModel):
    entity_id: str = Field(min_length=1)
    project_id: str | None = None
    entity_type: SearchEntityType
    title: str = Field(default="", max_length=2000)
    body: str = Field(default="", max_length=10_000_000)
    updated_at: datetime = Field(default_factory=utc_now)


class SearchResult(StrictModel):
    entity_id: str
    project_id: str | None
    entity_type: SearchEntityType
    title: str
    snippet: str
    score: float


class Setting(StrictModel):
    key: str = Field(min_length=1, max_length=255, pattern=r"^[a-zA-Z0-9_.-]+$")
    value: Any
    updated_at: datetime = Field(default_factory=utc_now)


class ObjectMetadata(StrictModel):
    object_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_size: int = Field(ge=0)
    media_type: str = Field(default="application/octet-stream", max_length=255)
    created_at: datetime = Field(default_factory=utc_now)


class BackupManifestEntry(StrictModel):
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_size: int = Field(ge=0)


class BackupManifest(StrictModel):
    format_version: int = Field(default=1, ge=1)
    product_version: str = Field(min_length=1)
    created_at: datetime = Field(default_factory=utc_now)
    schema_version: int = Field(ge=1)
    entries: tuple[BackupManifestEntry, ...]

    @model_validator(mode="after")
    def unique_paths(self) -> BackupManifest:
        paths = [entry.path for entry in self.entries]
        if len(paths) != len(set(paths)):
            raise ValueError("backup manifest paths must be unique")
        return self
