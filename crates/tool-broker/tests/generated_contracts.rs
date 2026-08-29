use cupcake_tool_broker::generated::contracts_v1::protocol::ProtocolEnvelope;
use serde_json::{json, Value};

fn protocol_payload() -> Value {
    json!({
        "version": 1,
        "messageId": "019d04b8-6890-7f85-9db4-6c9a279f67f5",
        "correlationId": "019d04b8-6890-7f85-9db4-6c9a279f67f6",
        "sessionId": "019d04b8-6890-7f85-9db4-6c9a279f67f7",
        "sequence": 1,
        "deadline": "2027-01-01T00:00:00Z",
        "lineage": {},
        "type": "ping",
        "payload": {},
        "authTag": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    })
}

#[test]
fn generated_serde_contract_accepts_schema_shape() {
    let envelope: ProtocolEnvelope = serde_json::from_value(protocol_payload()).unwrap();
    assert_eq!(envelope.sequence, 1);
    assert_eq!(serde_json::to_value(envelope).unwrap()["version"], json!(1));
}

#[test]
fn generated_serde_contract_rejects_unknown_versions() {
    let mut payload = protocol_payload();
    payload["version"] = json!(2);
    assert!(serde_json::from_value::<ProtocolEnvelope>(payload).is_err());
}

#[test]
fn generated_serde_contract_rejects_unknown_fields() {
    let mut payload = protocol_payload();
    payload["unexpected"] = json!(true);
    assert!(serde_json::from_value::<ProtocolEnvelope>(payload).is_err());
}
