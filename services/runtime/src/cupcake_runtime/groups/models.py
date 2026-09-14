from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

HANDLE_PATTERN = re.compile(r"^[a-z0-9_-]{2,32}$")
AVATAR_PATTERN = re.compile(
    r"^(?:|atlas:(?:0|[1-9][0-9]{0,2})|product:[a-z0-9][a-z0-9/_-]{0,180}\.(?:png|svg|webp))$"
)


class GroupStrategy(StrEnum):
    SMART = "smart-selective"
    MENTIONS_ONLY = "mentions-only"


class GroupTurnStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    WAITING = "waiting_for_you"
    SELECTION_FAILED = "selection_failed"
    MEMBER_FAILED = "member_failed"
    CANCELLED = "cancelled"
    AWAITING_TOOL = "awaiting_tool"
    INTERRUPTED = "interrupted"


@dataclass(frozen=True, slots=True)
class PersonaPersonality:
    preset: str = "balanced"
    warmth: float = 0.5
    brevity: float = 0.5
    initiative: float = 0.5

    def __post_init__(self) -> None:
        if not 1 <= len(self.preset) <= 40:
            raise ValueError("personality preset must contain 1..40 characters")
        for name, value in (
            ("warmth", self.warmth),
            ("brevity", self.brevity),
            ("initiative", self.initiative),
        ):
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"personality {name} must be between 0 and 1")

    def public(self) -> dict[str, Any]:
        return {
            "preset": self.preset,
            "warmth": self.warmth,
            "brevity": self.brevity,
            "initiative": self.initiative,
        }


@dataclass(frozen=True, slots=True)
class PersonaProfile:
    id: str
    name: str
    handle: str
    model_id: str
    avatar: str = ""
    role: str = ""
    description: str = ""
    instructions: str = ""
    speak_when: str = ""
    personality: PersonaPersonality = field(default_factory=PersonaPersonality)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    archived_at: datetime | None = None
    catalog_key: str | None = None

    def __post_init__(self) -> None:
        if not 1 <= len(self.name.strip()) <= 40:
            raise ValueError("persona name must contain 1..40 characters")
        if HANDLE_PATTERN.fullmatch(self.handle) is None:
            raise ValueError(
                "persona handle must use 2..32 lowercase letters, numbers, underscores, or hyphens"
            )
        if not 1 <= len(self.model_id) <= 500:
            raise ValueError("persona model id must contain 1..500 characters")
        if AVATAR_PATTERN.fullmatch(self.avatar) is None:
            raise ValueError("persona avatar must be a bundled atlas or product asset")
        if self.catalog_key is not None and not 1 <= len(self.catalog_key) <= 80:
            raise ValueError("persona catalog key must contain 1..80 characters")
        for label, value, maximum in (
            ("avatar", self.avatar, 200),
            ("role", self.role, 120),
            ("description", self.description, 1000),
            ("instructions", self.instructions, 4000),
            ("speakWhen", self.speak_when, 1000),
        ):
            if len(value) > maximum:
                raise ValueError(f"persona {label} exceeds {maximum} characters")

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "handle": self.handle,
            "avatar": self.avatar,
            "role": self.role,
            "description": self.description,
            "instructions": self.instructions,
            "speakWhen": self.speak_when,
            "personality": self.personality.public(),
            "modelId": self.model_id,
            "createdAt": self.created_at.isoformat(),
            "updatedAt": self.updated_at.isoformat(),
            "archivedAt": self.archived_at.isoformat() if self.archived_at else None,
        }


@dataclass(frozen=True, slots=True)
class DefaultPersonaSpec:
    """Product-owned persona template inserted once into each profile."""

    key: str
    name: str
    handle: str
    role: str
    description: str
    instructions: str
    speak_when: str
    personality: PersonaPersonality
    avatar: str = ""

    def __post_init__(self) -> None:
        # Reuse the public persona validation rules so catalog copy cannot drift
        # outside the same constraints as a persona created in the app.
        PersonaProfile(
            id="catalog-validation",
            name=self.name,
            handle=self.handle,
            avatar=self.avatar,
            role=self.role,
            description=self.description,
            instructions=self.instructions,
            speak_when=self.speak_when,
            personality=self.personality,
            model_id="catalog-validation",
            catalog_key=self.key,
        )
