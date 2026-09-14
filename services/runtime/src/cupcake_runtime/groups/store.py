from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast

from cupcake_runtime.domain.ids import new_id
from cupcake_runtime.storage.database import Database

from .models import (
    DefaultPersonaSpec,
    GroupStrategy,
    GroupTurnStatus,
    PersonaPersonality,
    PersonaProfile,
)


def _now() -> datetime:
    return datetime.now(UTC)


def _stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_stamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _decoded(value: str) -> Any:
    return json.loads(value)


class GroupStore:
    """Transactional profile-local storage for personas, rosters, and group turns."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def create_persona(
        self,
        *,
        name: str,
        handle: str,
        model_id: str,
        avatar: str = "",
        role: str = "",
        description: str = "",
        instructions: str = "",
        speak_when: str = "",
        personality: PersonaPersonality | None = None,
    ) -> PersonaProfile:
        now = _now()
        persona = PersonaProfile(
            id=new_id(),
            name=name.strip(),
            handle=handle.strip(),
            model_id=model_id,
            avatar=avatar,
            role=role,
            description=description,
            instructions=instructions,
            speak_when=speak_when,
            personality=personality or PersonaPersonality(),
            created_at=now,
            updated_at=now,
        )
        try:
            with self.database.transaction() as connection:
                connection.execute(
                    """INSERT INTO personas(
                        id,name,handle,avatar,role,description,instructions,speak_when,
                        personality_json,model_id,created_at,updated_at,archived_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        persona.id,
                        persona.name,
                        persona.handle,
                        persona.avatar,
                        persona.role,
                        persona.description,
                        persona.instructions,
                        persona.speak_when,
                        _json(persona.personality.public()),
                        persona.model_id,
                        _stamp(now),
                        _stamp(now),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            if "handle" in str(exc).casefold() or "unique" in str(exc).casefold():
                raise ValueError("persona handle is already in use") from None
            raise
        return persona

    def list_personas(self, *, include_archived: bool = False) -> tuple[PersonaProfile, ...]:
        where = "" if include_archived else "WHERE archived_at IS NULL"
        rows = self.database.connection.execute(
            f"""SELECT * FROM personas {where}
                ORDER BY CASE WHEN catalog_key IS NULL THEN 0 ELSE 1 END,
                         CASE WHEN catalog_key IS NOT NULL THEN catalog_position END,
                         updated_at DESC,id DESC"""
        ).fetchall()
        return tuple(self._persona(row) for row in rows)

    def ensure_default_personas(
        self,
        defaults: Sequence[DefaultPersonaSpec],
        *,
        model_id: str,
    ) -> tuple[PersonaProfile, ...]:
        """Insert each product persona once without modifying profile-owned rows.

        ``catalog_key`` is the durable identity. Handles stay friendly on a fresh
        profile, while a pre-existing custom handle wins and the catalog entry gets
        a deterministic free suffix. Existing catalog personas, including archived
        or user-edited ones, are left byte-for-byte alone on later starts.
        """

        if not 1 <= len(model_id) <= 500:
            raise ValueError("persona model id must contain 1..500 characters")
        inserted: list[PersonaProfile] = []
        now = _now()
        with self.database.transaction() as connection:
            used_handles = {
                str(row["handle"]).casefold()
                for row in connection.execute("SELECT handle FROM personas").fetchall()
            }
            for position, default in enumerate(defaults):
                existing = connection.execute(
                    "SELECT 1 FROM personas WHERE catalog_key=?", (default.key,)
                ).fetchone()
                if existing is not None:
                    continue
                handle = _available_catalog_handle(default.handle, used_handles)
                persona = PersonaProfile(
                    id=new_id(),
                    name=default.name,
                    handle=handle,
                    avatar=default.avatar,
                    role=default.role,
                    description=default.description,
                    instructions=default.instructions,
                    speak_when=default.speak_when,
                    personality=default.personality,
                    model_id=model_id,
                    created_at=now,
                    updated_at=now,
                    catalog_key=default.key,
                    catalog_model_managed=True,
                )
                connection.execute(
                    """INSERT INTO personas(
                        id,name,handle,avatar,role,description,instructions,speak_when,
                        personality_json,model_id,created_at,updated_at,archived_at,
                        catalog_key,catalog_position,catalog_model_managed
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,1)""",
                    (
                        persona.id,
                        persona.name,
                        persona.handle,
                        persona.avatar,
                        persona.role,
                        persona.description,
                        persona.instructions,
                        persona.speak_when,
                        _json(persona.personality.public()),
                        persona.model_id,
                        _stamp(now),
                        _stamp(now),
                        default.key,
                        position,
                    ),
                )
                used_handles.add(handle.casefold())
                inserted.append(persona)
        return tuple(inserted)

    def rebind_default_persona_models(self, model_id: str) -> int:
        """Point untouched catalog personas at the newly selected default model."""

        if not 1 <= len(model_id) <= 500:
            raise ValueError("persona model id must contain 1..500 characters")
        now = _stamp(_now())
        with self.database.transaction() as connection:
            changed = connection.execute(
                """UPDATE personas SET model_id=?,updated_at=?
                   WHERE catalog_key IS NOT NULL AND catalog_model_managed=1
                     AND model_id<>?""",
                (model_id, now, model_id),
            ).rowcount
        return int(changed)

    def get_persona(self, persona_id: str) -> PersonaProfile:
        row = self.database.connection.execute(
            "SELECT * FROM personas WHERE id=?", (persona_id,)
        ).fetchone()
        if row is None:
            raise KeyError("persona not found")
        return self._persona(row)

    def update_persona(self, persona_id: str, changes: Mapping[str, Any]) -> PersonaProfile:
        current = self.get_persona(persona_id)
        personality_value = changes.get("personality")
        personality = (
            _personality(cast(Mapping[str, Any], personality_value))
            if isinstance(personality_value, Mapping)
            else current.personality
        )
        updated = PersonaProfile(
            id=current.id,
            name=str(changes.get("name", current.name)).strip(),
            handle=str(changes.get("handle", current.handle)).strip(),
            avatar=str(changes.get("avatar", current.avatar)),
            role=str(changes.get("role", current.role)),
            description=str(changes.get("description", current.description)),
            instructions=str(changes.get("instructions", current.instructions)),
            speak_when=str(changes.get("speakWhen", current.speak_when)),
            personality=personality,
            model_id=str(changes.get("modelId", current.model_id)),
            created_at=current.created_at,
            updated_at=_now(),
            archived_at=current.archived_at,
            catalog_key=current.catalog_key,
            catalog_model_managed=(
                current.catalog_model_managed if "modelId" not in changes else False
            ),
        )
        try:
            with self.database.transaction() as connection:
                connection.execute(
                    """UPDATE personas SET name=?,handle=?,avatar=?,role=?,description=?,
                       instructions=?,speak_when=?,personality_json=?,model_id=?,updated_at=?,
                       catalog_model_managed=? WHERE id=?""",
                    (
                        updated.name,
                        updated.handle,
                        updated.avatar,
                        updated.role,
                        updated.description,
                        updated.instructions,
                        updated.speak_when,
                        _json(updated.personality.public()),
                        updated.model_id,
                        _stamp(updated.updated_at),
                        int(updated.catalog_model_managed),
                        updated.id,
                    ),
                )
                self._bump_persona_rosters(connection, updated.id, updated.updated_at)
        except sqlite3.IntegrityError as exc:
            if "handle" in str(exc).casefold() or "unique" in str(exc).casefold():
                raise ValueError("persona handle is already in use") from None
            raise
        return updated

    def archive_persona(self, persona_id: str) -> PersonaProfile:
        current = self.get_persona(persona_id)
        if current.archived_at is not None:
            return current
        now = _now()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE personas SET archived_at=?,updated_at=? WHERE id=?",
                (_stamp(now), _stamp(now), persona_id),
            )
            connection.execute(
                "UPDATE conversation_participants SET enabled=0 WHERE persona_id=?",
                (persona_id,),
            )
            conversations = connection.execute(
                """SELECT conversation_id FROM conversation_group_settings
                   WHERE lead_participant_id IN (
                       SELECT id FROM conversation_participants WHERE persona_id=?
                   )""",
                (persona_id,),
            ).fetchall()
            for row in conversations:
                self._assign_first_available_lead(connection, str(row["conversation_id"]))
            self._bump_persona_rosters(connection, persona_id, now)
        return self.get_persona(persona_id)

    def list_participants(self, conversation_id: str) -> tuple[dict[str, Any], ...]:
        self._require_conversation(conversation_id)
        rows = self.database.connection.execute(
            f"""SELECT cp.*, {_PERSONA_COLUMNS}, cgs.lead_participant_id
               FROM conversation_participants cp
               JOIN personas p ON p.id=cp.persona_id
               JOIN conversation_group_settings cgs ON cgs.conversation_id=cp.conversation_id
               WHERE cp.conversation_id=? ORDER BY cp.position, cp.id""",
            (conversation_id,),
        ).fetchall()
        return tuple(self._participant(row) for row in rows)

    def add_participant(
        self, conversation_id: str, persona_id: str, *, enabled: bool = True
    ) -> dict[str, Any]:
        self._require_conversation(conversation_id)
        persona = self.get_persona(persona_id)
        if persona.archived_at is not None:
            raise ValueError("archived personas cannot be added")
        now = _now()
        with self.database.transaction() as connection:
            count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM conversation_participants WHERE conversation_id=?",
                    (conversation_id,),
                ).fetchone()[0]
            )
            if count >= 8:
                raise ValueError("a conversation can have at most 8 Cupcakes")
            settings = connection.execute(
                "SELECT * FROM conversation_group_settings WHERE conversation_id=?",
                (conversation_id,),
            ).fetchone()
            participant_id = new_id()
            connection.execute(
                """INSERT INTO conversation_participants(
                    id,conversation_id,persona_id,position,enabled,added_at
                ) VALUES (?,?,?,?,?,?)""",
                (
                    participant_id,
                    conversation_id,
                    persona_id,
                    count,
                    int(enabled),
                    _stamp(now),
                ),
            )
            if settings is None:
                connection.execute(
                    """INSERT INTO conversation_group_settings(
                        conversation_id,strategy,max_replies,lead_participant_id,
                        roster_revision,updated_at
                    ) VALUES (?,?,?,?,1,?)""",
                    (
                        conversation_id,
                        GroupStrategy.SMART.value,
                        2,
                        participant_id if enabled else None,
                        _stamp(now),
                    ),
                )
            else:
                if enabled and settings["lead_participant_id"] is None:
                    connection.execute(
                        """UPDATE conversation_group_settings SET lead_participant_id=?
                           WHERE conversation_id=?""",
                        (participant_id, conversation_id),
                    )
                self._bump_roster(connection, conversation_id, now)
        return self.get_participant(conversation_id, participant_id)

    def get_participant(self, conversation_id: str, participant_id: str) -> dict[str, Any]:
        row = self.database.connection.execute(
            f"""SELECT cp.*, {_PERSONA_COLUMNS}, cgs.lead_participant_id
               FROM conversation_participants cp
               JOIN personas p ON p.id=cp.persona_id
               JOIN conversation_group_settings cgs ON cgs.conversation_id=cp.conversation_id
               WHERE cp.conversation_id=? AND cp.id=?""",
            (conversation_id, participant_id),
        ).fetchone()
        if row is None:
            raise KeyError("conversation participant not found")
        return self._participant(row)

    def remove_participant(self, conversation_id: str, participant_id: str) -> None:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                """SELECT (cgs.lead_participant_id=cp.id) AS is_lead
                   FROM conversation_participants cp
                   JOIN conversation_group_settings cgs ON cgs.conversation_id=cp.conversation_id
                   WHERE cp.conversation_id=? AND cp.id=?""",
                (conversation_id, participant_id),
            ).fetchone()
            if row is None:
                raise KeyError("conversation participant not found")
            connection.execute(
                "DELETE FROM conversation_participants WHERE conversation_id=? AND id=?",
                (conversation_id, participant_id),
            )
            remaining = connection.execute(
                """SELECT id FROM conversation_participants WHERE conversation_id=?
                   ORDER BY position,id""",
                (conversation_id,),
            ).fetchall()
            for position, remaining_row in enumerate(remaining):
                connection.execute(
                    "UPDATE conversation_participants SET position=? WHERE id=?",
                    (position + 1000, remaining_row["id"]),
                )
            for position, remaining_row in enumerate(remaining):
                connection.execute(
                    "UPDATE conversation_participants SET position=? WHERE id=?",
                    (position, remaining_row["id"]),
                )
            if bool(row["is_lead"]):
                self._assign_first_available_lead(connection, conversation_id)
            self._bump_roster(connection, conversation_id, now)

    def update_participant(
        self, conversation_id: str, participant_id: str, *, enabled: bool
    ) -> dict[str, Any]:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                """SELECT cp.enabled,p.archived_at,cgs.lead_participant_id
                   FROM conversation_participants cp
                   JOIN personas p ON p.id=cp.persona_id
                   JOIN conversation_group_settings cgs
                     ON cgs.conversation_id=cp.conversation_id
                   WHERE cp.conversation_id=? AND cp.id=?""",
                (conversation_id, participant_id),
            ).fetchone()
            if row is None:
                raise KeyError("conversation participant not found")
            if enabled and row["archived_at"] is not None:
                raise ValueError("an archived persona cannot be enabled")
            if bool(row["enabled"]) == enabled:
                return self.get_participant(conversation_id, participant_id)
            connection.execute(
                """UPDATE conversation_participants SET enabled=?
                   WHERE conversation_id=? AND id=?""",
                (int(enabled), conversation_id, participant_id),
            )
            if not enabled and row["lead_participant_id"] == participant_id:
                self._assign_first_available_lead(connection, conversation_id)
            elif enabled and row["lead_participant_id"] is None:
                connection.execute(
                    """UPDATE conversation_group_settings SET lead_participant_id=?
                       WHERE conversation_id=?""",
                    (participant_id, conversation_id),
                )
            self._bump_roster(connection, conversation_id, now)
        return self.get_participant(conversation_id, participant_id)

    def reorder_participants(self, conversation_id: str, participant_ids: Sequence[str]) -> None:
        current = self.list_participants(conversation_id)
        current_ids = [str(item["id"]) for item in current]
        if len(participant_ids) != len(set(participant_ids)) or set(participant_ids) != set(
            current_ids
        ):
            raise ValueError("participantIds must include every participant exactly once")
        now = _now()
        with self.database.transaction() as connection:
            # Clear the immediate UNIQUE(conversation_id, position) constraint first.
            for offset, participant_id in enumerate(participant_ids, start=1000):
                connection.execute(
                    """UPDATE conversation_participants SET position=?
                       WHERE conversation_id=? AND id=?""",
                    (offset, conversation_id, participant_id),
                )
            for position, participant_id in enumerate(participant_ids):
                connection.execute(
                    """UPDATE conversation_participants SET position=?
                       WHERE conversation_id=? AND id=?""",
                    (position, conversation_id, participant_id),
                )
            self._bump_roster(connection, conversation_id, now)

    def get_settings(self, conversation_id: str) -> dict[str, Any]:
        self._require_conversation(conversation_id)
        row = self.database.connection.execute(
            "SELECT * FROM conversation_group_settings WHERE conversation_id=?",
            (conversation_id,),
        ).fetchone()
        if row is None:
            raise KeyError("conversation group settings not found")
        return self._settings(row)

    def set_settings(
        self,
        conversation_id: str,
        *,
        strategy: GroupStrategy,
        max_replies: int,
        lead_participant_id: str | None,
    ) -> dict[str, Any]:
        if not 1 <= max_replies <= 3:
            raise ValueError("maxReplies must be between 1 and 3")
        if lead_participant_id is not None:
            participant = self.get_participant(conversation_id, lead_participant_id)
            if not bool(participant["enabled"]):
                raise ValueError("leadParticipantId must be an enabled roster member")
        if strategy is GroupStrategy.SMART and lead_participant_id is None:
            raise ValueError("Smart selection requires an enabled lead Cupcake")
        now = _now()
        with self.database.transaction() as connection:
            self._require_conversation(conversation_id)
            row = connection.execute(
                "SELECT roster_revision FROM conversation_group_settings WHERE conversation_id=?",
                (conversation_id,),
            ).fetchone()
            revision = int(row["roster_revision"]) + 1 if row else 1
            connection.execute(
                """INSERT INTO conversation_group_settings(
                    conversation_id,strategy,max_replies,lead_participant_id,
                    roster_revision,updated_at
                ) VALUES (?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
                    strategy=excluded.strategy,max_replies=excluded.max_replies,
                    lead_participant_id=excluded.lead_participant_id,
                    roster_revision=excluded.roster_revision,updated_at=excluded.updated_at""",
                (
                    conversation_id,
                    strategy.value,
                    max_replies,
                    lead_participant_id,
                    revision,
                    _stamp(now),
                ),
            )
        return self.get_settings(conversation_id)

    def create_turn(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        branch_id: str,
        user_message_id: str,
        mode: str,
        digest: str,
        plan_revision: str,
        responder_limit: int,
        plan: Mapping[str, Any],
    ) -> dict[str, Any]:
        now = _now()
        with self.database.transaction() as connection:
            active = connection.execute(
                """SELECT id FROM group_turns
                   WHERE conversation_id=? AND branch_id=? AND status='running' LIMIT 1""",
                (conversation_id, branch_id),
            ).fetchone()
            if active is not None:
                raise ValueError("a group turn is already running on this branch")
            connection.execute(
                """INSERT INTO group_turns(
                    id,conversation_id,branch_id,user_message_id,status,mode,confirmed_digest,
                    plan_revision,responder_limit,selector_calls,responder_calls,
                    selector_usage_json,plan_json,created_at,updated_at,completed_at
                ) VALUES (?,?,?,?,?,?,?,?,?,0,0,'[]',?,?,?,NULL)""",
                (
                    turn_id,
                    conversation_id,
                    branch_id,
                    user_message_id,
                    GroupTurnStatus.RUNNING.value,
                    mode,
                    digest,
                    plan_revision,
                    responder_limit,
                    _json(plan),
                    _stamp(now),
                    _stamp(now),
                ),
            )
        return self.get_turn(turn_id)

    def record_selector(
        self,
        turn_id: str,
        *,
        status: str,
        selection: Mapping[str, Any] | None,
        usage: Mapping[str, Any],
        error_code: str | None = None,
    ) -> None:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("invalid selector attempt status")
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT selector_usage_json FROM group_turns WHERE id=?", (turn_id,)
            ).fetchone()
            if row is None:
                raise KeyError("group turn not found")
            usages = cast(list[Any], _decoded(str(row["selector_usage_json"])))
            usages.append(
                {
                    "status": status,
                    "selection": dict(selection) if selection is not None else None,
                    "usage": dict(usage),
                    "errorCode": error_code,
                }
            )
            connection.execute(
                """UPDATE group_turns SET selector_calls=selector_calls+1,
                   selector_usage_json=?,updated_at=? WHERE id=?""",
                (_json(usages), _stamp(_now()), turn_id),
            )

    def record_member_selected(
        self,
        turn_id: str,
        *,
        sequence: int,
        participant_id: str,
        reason_code: str,
        reason: str,
        snapshot: Mapping[str, Any],
    ) -> None:
        now = _now()
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO group_turn_members(
                    turn_id,sequence,participant_id,status,message_id,selection_reason_code,
                    selection_reason,speaker_snapshot_json,usage_snapshot_json,error_code,
                    created_at,updated_at
                ) VALUES (?,?,?,'selected',NULL,?,?,?,'{}',NULL,?,?)""",
                (
                    turn_id,
                    sequence,
                    participant_id,
                    reason_code,
                    reason,
                    _json(snapshot),
                    _stamp(now),
                    _stamp(now),
                ),
            )

    def complete_member(
        self,
        turn_id: str,
        sequence: int,
        *,
        status: str,
        message_id: str | None,
        usage: Mapping[str, Any],
        error_code: str | None = None,
    ) -> None:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("invalid group member status")
        with self.database.transaction() as connection:
            changed = connection.execute(
                """UPDATE group_turn_members SET status=?,message_id=?,usage_snapshot_json=?,
                   error_code=?,updated_at=? WHERE turn_id=? AND sequence=?""",
                (
                    status,
                    message_id,
                    _json(usage),
                    error_code,
                    _stamp(_now()),
                    turn_id,
                    sequence,
                ),
            ).rowcount
            if changed != 1:
                raise KeyError("group turn member not found")
            connection.execute(
                """UPDATE group_turns SET responder_calls=responder_calls+1,updated_at=?
                   WHERE id=?""",
                (_stamp(_now()), turn_id),
            )

    def finish_turn(self, turn_id: str, status: GroupTurnStatus) -> dict[str, Any]:
        if status is GroupTurnStatus.RUNNING:
            raise ValueError("cannot finish a group turn as running")
        now = _now()
        with self.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE group_turns SET status=?,updated_at=?,completed_at=? WHERE id=?",
                (status.value, _stamp(now), _stamp(now), turn_id),
            ).rowcount
            if changed != 1:
                raise KeyError("group turn not found")
        return self.get_turn(turn_id)

    def get_turn(self, turn_id: str) -> dict[str, Any]:
        row = self.database.connection.execute(
            "SELECT * FROM group_turns WHERE id=?", (turn_id,)
        ).fetchone()
        if row is None:
            raise KeyError("group turn not found")
        members = self.database.connection.execute(
            """SELECT * FROM group_turn_members WHERE turn_id=?
               ORDER BY sequence""",
            (turn_id,),
        ).fetchall()
        plan = cast(dict[str, Any], _decoded(str(row["plan_json"])))
        return {
            "turnId": str(row["id"]),
            "conversationId": str(row["conversation_id"]),
            "branchId": str(row["branch_id"]),
            "userMessageId": str(row["user_message_id"]),
            "status": str(row["status"]),
            "mode": str(row["mode"]),
            "digest": str(row["confirmed_digest"]),
            "planRevision": str(row["plan_revision"]),
            "rosterRevision": int(plan.get("rosterRevision", 0)),
            "maxReplies": int(row["responder_limit"]),
            "maxSelectorCalls": int(row["responder_limit"]) if row["mode"] == "smart" else 0,
            "selectorCalls": int(row["selector_calls"]),
            "responderCalls": int(row["responder_calls"]),
            "selectorUsage": _decoded(str(row["selector_usage_json"])),
            "plan": plan,
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
            "completedAt": row["completed_at"],
            "members": [self._turn_member(item) for item in members],
        }

    def list_turns(self, conversation_id: str, *, limit: int = 20) -> tuple[dict[str, Any], ...]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        self._require_conversation(conversation_id)
        rows = self.database.connection.execute(
            """SELECT id FROM group_turns WHERE conversation_id=?
               ORDER BY created_at DESC,id DESC LIMIT ?""",
            (conversation_id, limit),
        ).fetchall()
        return tuple(self.get_turn(str(row["id"])) for row in rows)

    def latest_turn(
        self, conversation_id: str, *, branch_id: str | None = None
    ) -> dict[str, Any] | None:
        self._require_conversation(conversation_id)
        clauses = ["conversation_id=?"]
        arguments: list[object] = [conversation_id]
        if branch_id is not None:
            clauses.append("branch_id=?")
            arguments.append(branch_id)
        row = self.database.connection.execute(
            "SELECT id FROM group_turns WHERE "
            + " AND ".join(clauses)
            + " ORDER BY created_at DESC,id DESC LIMIT 1",
            arguments,
        ).fetchone()
        return self.get_turn(str(row["id"])) if row is not None else None

    def active_turn(self, conversation_id: str, *, branch_id: str) -> dict[str, Any] | None:
        self._require_conversation(conversation_id)
        row = self.database.connection.execute(
            """SELECT id FROM group_turns
               WHERE conversation_id=? AND branch_id=? AND status='running'
               ORDER BY created_at DESC,id DESC LIMIT 1""",
            (conversation_id, branch_id),
        ).fetchone()
        return self.get_turn(str(row["id"])) if row is not None else None

    def recover_interrupted(self) -> int:
        now = _stamp(_now())
        with self.database.transaction() as connection:
            connection.execute(
                """UPDATE group_turn_members
                   SET status='cancelled',error_code='RUNTIME_RESTART',updated_at=?
                   WHERE status='selected' AND turn_id IN (
                       SELECT id FROM group_turns WHERE status='running'
                   )""",
                (now,),
            )
            changed = connection.execute(
                """UPDATE group_turns SET status='interrupted',updated_at=?,completed_at=?
                   WHERE status='running'""",
                (now, now),
            ).rowcount
        return int(changed)

    def _require_conversation(self, conversation_id: str) -> None:
        row = self.database.connection.execute(
            "SELECT 1 FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if row is None:
            raise KeyError("conversation not found")

    @staticmethod
    def _bump_roster(connection: sqlite3.Connection, conversation_id: str, now: datetime) -> None:
        connection.execute(
            """UPDATE conversation_group_settings
               SET roster_revision=roster_revision+1,updated_at=? WHERE conversation_id=?""",
            (_stamp(now), conversation_id),
        )

    @staticmethod
    def _assign_first_available_lead(connection: sqlite3.Connection, conversation_id: str) -> None:
        row = connection.execute(
            """SELECT cp.id FROM conversation_participants cp
               JOIN personas p ON p.id=cp.persona_id
               WHERE cp.conversation_id=? AND cp.enabled=1 AND p.archived_at IS NULL
               ORDER BY cp.position,cp.id LIMIT 1""",
            (conversation_id,),
        ).fetchone()
        connection.execute(
            """UPDATE conversation_group_settings SET lead_participant_id=?
               WHERE conversation_id=?""",
            (str(row["id"]) if row else None, conversation_id),
        )

    def _bump_persona_rosters(
        self, connection: sqlite3.Connection, persona_id: str, now: datetime
    ) -> None:
        conversation_rows = connection.execute(
            "SELECT conversation_id FROM conversation_participants WHERE persona_id=?",
            (persona_id,),
        ).fetchall()
        for row in conversation_rows:
            self._bump_roster(connection, str(row["conversation_id"]), now)

    @staticmethod
    def _persona(row: sqlite3.Row, *, prefix: str = "") -> PersonaProfile:
        personality_value = cast(Mapping[str, Any], _decoded(str(row[f"{prefix}personality_json"])))
        return PersonaProfile(
            id=str(row[f"{prefix}id"]),
            name=str(row[f"{prefix}name"]),
            handle=str(row[f"{prefix}handle"]),
            avatar=str(row[f"{prefix}avatar"]),
            role=str(row[f"{prefix}role"]),
            description=str(row[f"{prefix}description"]),
            instructions=str(row[f"{prefix}instructions"]),
            speak_when=str(row[f"{prefix}speak_when"]),
            personality=_personality(personality_value),
            model_id=str(row[f"{prefix}model_id"]),
            created_at=cast(datetime, _parse_stamp(str(row[f"{prefix}created_at"]))),
            updated_at=cast(datetime, _parse_stamp(str(row[f"{prefix}updated_at"]))),
            archived_at=_parse_stamp(row[f"{prefix}archived_at"]),
            catalog_key=(
                str(row[f"{prefix}catalog_key"])
                if row[f"{prefix}catalog_key"] is not None
                else None
            ),
            catalog_model_managed=bool(row[f"{prefix}catalog_model_managed"]),
        )

    def _participant(self, row: sqlite3.Row) -> dict[str, Any]:
        persona = self._persona(row, prefix="persona_")
        return {
            "id": str(row["id"]),
            "conversationId": str(row["conversation_id"]),
            "personaId": str(row["persona_id"]),
            "position": int(row["position"]),
            "enabled": bool(row["enabled"]),
            "isLead": row["lead_participant_id"] == row["id"],
            "addedAt": str(row["added_at"]),
            "persona": persona.public(),
        }

    @staticmethod
    def _settings(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "conversationId": str(row["conversation_id"]),
            "strategy": str(row["strategy"]),
            "maxReplies": int(row["max_replies"]),
            "leadParticipantId": row["lead_participant_id"],
            "rosterRevision": int(row["roster_revision"]),
            "updatedAt": str(row["updated_at"]),
        }

    @staticmethod
    def _turn_member(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "sequence": int(row["sequence"]),
            "participantId": str(row["participant_id"]),
            "status": str(row["status"]),
            "messageId": row["message_id"],
            "selectionReasonCode": str(row["selection_reason_code"]),
            "selectionReason": str(row["selection_reason"]),
            "speaker": _decoded(str(row["speaker_snapshot_json"])),
            "usage": _decoded(str(row["usage_snapshot_json"])),
            "errorCode": row["error_code"],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }


def _personality(value: Mapping[str, Any]) -> PersonaPersonality:
    return PersonaPersonality(
        preset=str(value.get("preset") or "balanced"),
        warmth=float(value.get("warmth", 0.5)),
        brevity=float(value.get("brevity", 0.5)),
        initiative=float(value.get("initiative", 0.5)),
    )


_PERSONA_COLUMNS = ",".join(
    f"p.{column} AS persona_{column}"
    for column in (
        "id",
        "name",
        "handle",
        "avatar",
        "role",
        "description",
        "instructions",
        "speak_when",
        "personality_json",
        "model_id",
        "created_at",
        "updated_at",
        "archived_at",
        "catalog_key",
        "catalog_model_managed",
    )
)


def _available_catalog_handle(preferred: str, used: set[str]) -> str:
    if preferred.casefold() not in used:
        return preferred
    base = preferred[:24].rstrip("_-")
    for suffix in ("-helper", *(f"-{index}" for index in range(2, 10_000))):
        candidate = f"{base}{suffix}"[:32]
        if candidate.casefold() not in used:
            return candidate
    raise RuntimeError("could not allocate a persona catalog handle")
