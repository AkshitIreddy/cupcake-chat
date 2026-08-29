from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from cupcake_runtime.domain.ids import new_id
from cupcake_runtime.domain.models import StrictModel, utc_now

PROTOCOL_VERSION = 1


class ProtocolEnvelope(StrictModel):
    version: Literal[1] = PROTOCOL_VERSION
    message_id: str = Field(default_factory=new_id, min_length=1)
    correlation_id: str = Field(min_length=1)
    sequence: int = Field(ge=0)
    deadline: datetime | None = None
    run_id: str | None = None
    task_id: str | None = None
    parent_run_id: str | None = None
    type: str = Field(min_length=1, max_length=200, pattern=r"^[a-z][a-z0-9_.-]*$")
    sent_at: datetime = Field(default_factory=utc_now)
    payload: dict[str, Any] = Field(default_factory=dict)
    auth_tag: str = Field(default="", pattern=r"^(?:|[a-f0-9]{64})$")

    @field_validator("deadline")
    @classmethod
    def deadline_has_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("deadline must include a timezone")
        return value

    def signing_copy(self) -> ProtocolEnvelope:
        return self.model_copy(update={"auth_tag": ""})
