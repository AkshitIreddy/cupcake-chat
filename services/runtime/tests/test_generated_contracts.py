from __future__ import annotations

import pytest
from pydantic import ValidationError

from cupcake_runtime.generated.contracts_v1 import ProtocolEnvelope


def protocol_payload() -> dict[str, object]:
    return {
        "version": 1,
        "messageId": "019d04b8-6890-7f85-9db4-6c9a279f67f5",
        "correlationId": "019d04b8-6890-7f85-9db4-6c9a279f67f6",
        "sessionId": "019d04b8-6890-7f85-9db4-6c9a279f67f7",
        "sequence": 1,
        "deadline": "2027-01-01T00:00:00Z",
        "lineage": {},
        "type": "ping",
        "payload": {},
        "authTag": "A" * 43,
    }


def test_generated_pydantic_contract_accepts_schema_shape() -> None:
    envelope = ProtocolEnvelope.model_validate(protocol_payload(), strict=True)

    assert envelope.version == 1
    assert envelope.type_ == "ping"
    assert envelope.model_dump(by_alias=True)["type"] == "ping"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("version", 2),
        ("unexpected", True),
        ("type_", "ping"),
    ],
)
def test_generated_pydantic_contract_rejects_version_and_unknown_fields(
    field: str,
    value: object,
) -> None:
    payload = protocol_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        ProtocolEnvelope.model_validate(payload, strict=True)
