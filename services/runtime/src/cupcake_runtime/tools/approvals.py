from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from .models import ApprovalBinding, ToolPreflight, canonical_json


class ApprovalError(ValueError):
    pass


class ApprovalAuthority:
    """Creates invocation-bound, expiring, one-use approval capabilities."""

    def __init__(self, secret: bytes, *, max_ttl: timedelta = timedelta(minutes=15)) -> None:
        if len(secret) < 32:
            raise ValueError("approval secret must contain at least 32 bytes")
        self._secret = bytes(secret)
        self._max_ttl = max_ttl
        self._consumed: set[str] = set()

    def issue(
        self,
        approval_id: str,
        preflight: ToolPreflight,
        *,
        ttl: timedelta = timedelta(minutes=5),
        now: datetime | None = None,
    ) -> ApprovalBinding:
        if not approval_id:
            raise ApprovalError("approval ID is required")
        if ttl <= timedelta(0) or ttl > self._max_ttl:
            raise ApprovalError("approval TTL is outside the permitted range")
        issued_at = _utc(now)
        unsigned = ApprovalBinding(
            approval_id=approval_id,
            invocation_id=preflight.invocation_id,
            intent_digest=preflight.intent_digest,
            approved_effects=preflight.effects,
            approved_resources=preflight.resolved_resources,
            issued_at=issued_at,
            expires_at=issued_at + ttl,
            nonce=secrets.token_urlsafe(24),
            signature="",
        )
        return replace(unsigned, signature=self._sign(unsigned))

    def verify_and_consume(
        self,
        approval: ApprovalBinding,
        preflight: ToolPreflight,
        *,
        now: datetime | None = None,
    ) -> None:
        current = _utc(now)
        if not hmac.compare_digest(approval.signature, self._sign(approval)):
            raise ApprovalError("approval signature is invalid")
        if approval.nonce in self._consumed:
            raise ApprovalError("approval has already been consumed")
        if current < approval.issued_at or current >= approval.expires_at:
            raise ApprovalError("approval is not currently valid")
        if approval.expires_at - approval.issued_at > self._max_ttl:
            raise ApprovalError("approval lifetime exceeds the permitted maximum")
        if (
            approval.invocation_id != preflight.invocation_id
            or approval.intent_digest != preflight.intent_digest
        ):
            raise ApprovalError("approval is bound to another intent")
        if (
            approval.approved_effects != preflight.effects
            or approval.approved_resources != preflight.resolved_resources
        ):
            raise ApprovalError("approved effects or resources changed after approval")
        self._consumed.add(approval.nonce)

    def _sign(self, approval: ApprovalBinding) -> str:
        return hmac.new(
            self._secret, canonical_json(_binding_values(approval)), hashlib.sha256
        ).hexdigest()


def _binding_values(approval: ApprovalBinding) -> dict[str, object]:
    return {
        "approval_id": approval.approval_id,
        "invocation_id": approval.invocation_id,
        "intent_digest": approval.intent_digest,
        "approved_effects": sorted(effect.value for effect in approval.approved_effects),
        "approved_resources": list(approval.approved_resources),
        "issued_at": approval.issued_at.astimezone(UTC).isoformat(),
        "expires_at": approval.expires_at.astimezone(UTC).isoformat(),
        "nonce": approval.nonce,
    }


def _utc(value: datetime | None) -> datetime:
    result = value or datetime.now(UTC)
    if result.tzinfo is None:
        raise ApprovalError("approval timestamps must be timezone-aware")
    return result.astimezone(UTC)
