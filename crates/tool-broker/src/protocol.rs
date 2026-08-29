use crate::{BrokerError, Result, PROTOCOL_VERSION};
use base64::prelude::*;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::Sha256;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use subtle::ConstantTimeEq;
use uuid::{Uuid, Version};

type HmacSha256 = Hmac<Sha256>;
const DEFAULT_REPLAY_CAPACITY: usize = 4096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Handshake,
    Request,
    Response,
    Event,
    Cancel,
    Ping,
    Pong,
    Shutdown,
}

/// Request wrapper emitted by the packaged Python runtime for privileged tool
/// and MCP operations. The payload remains operation-specific, while the
/// discriminator is exhaustive and closed here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RuntimeBrokerRequest {
    pub protocol_version: u16,
    pub request_type: RuntimeRequestType,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeRequestType {
    #[serde(rename = "tool.preflight")]
    ToolPreflight,
    #[serde(rename = "tool.approval.verify")]
    ToolApprovalVerify,
    #[serde(rename = "tool.execute")]
    ToolExecute,
    #[serde(rename = "tool.cancel")]
    ToolCancel,
    #[serde(rename = "mcp.connect")]
    McpConnect,
    #[serde(rename = "mcp.tools.list")]
    McpToolsList,
    #[serde(rename = "mcp.tool.call")]
    McpToolCall,
    #[serde(rename = "mcp.disconnect")]
    McpDisconnect,
}

impl RuntimeBrokerRequest {
    pub fn validate(&self) -> Result<()> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(BrokerError::UnsupportedProtocol(self.protocol_version));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolLineage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<Uuid>,
}

/// Exact Serde representation of `@cupcakeagi/contracts` ProtocolEnvelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolEnvelope {
    pub version: u16,
    pub message_id: Uuid,
    pub correlation_id: Uuid,
    pub session_id: Uuid,
    pub sequence: u64,
    pub deadline: String,
    pub lineage: ProtocolLineage,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    pub payload: Map<String, Value>,
    pub auth_tag: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedEnvelope<'a> {
    version: u16,
    message_id: Uuid,
    correlation_id: Uuid,
    session_id: Uuid,
    sequence: u64,
    deadline: &'a str,
    lineage: &'a ProtocolLineage,
    #[serde(rename = "type")]
    message_type: MessageType,
    payload: &'a Map<String, Value>,
}

impl ProtocolEnvelope {
    #[allow(clippy::too_many_arguments)]
    pub fn unsigned(
        message_id: Uuid,
        correlation_id: Uuid,
        session_id: Uuid,
        sequence: u64,
        deadline: String,
        lineage: ProtocolLineage,
        message_type: MessageType,
        payload: Map<String, Value>,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            message_id,
            correlation_id,
            session_id,
            sequence,
            deadline,
            lineage,
            message_type,
            payload,
            auth_tag: String::new(),
        }
    }

    pub fn sign(mut self, secret: &[u8]) -> Result<Self> {
        self.auth_tag = self.expected_auth_tag(secret)?;
        Ok(self)
    }

    pub fn verify_auth(&self, secret: &[u8]) -> Result<()> {
        let expected = self.expected_auth_tag(secret)?;
        let valid_shape = self.auth_tag.len() == 43
            && self
                .auth_tag
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
        if !valid_shape
            || expected
                .as_bytes()
                .ct_eq(self.auth_tag.as_bytes())
                .unwrap_u8()
                != 1
        {
            return Err(BrokerError::InvalidEnvelope(
                "authentication tag mismatch".into(),
            ));
        }
        Ok(())
    }

    pub fn validate(&self, now: DateTime<Utc>) -> Result<()> {
        if self.version != PROTOCOL_VERSION {
            return Err(BrokerError::UnsupportedProtocol(self.version));
        }
        for (name, id) in [
            ("messageId", Some(self.message_id)),
            ("correlationId", Some(self.correlation_id)),
            ("sessionId", Some(self.session_id)),
            ("lineage.runId", self.lineage.run_id),
            ("lineage.taskId", self.lineage.task_id),
            ("lineage.parentRunId", self.lineage.parent_run_id),
        ] {
            if let Some(id) = id {
                if id.get_version() != Some(Version::SortRand) {
                    return Err(BrokerError::InvalidEnvelope(format!(
                        "{name} must be UUIDv7"
                    )));
                }
            }
        }
        if self.sequence == 0 || self.sequence > MAX_SAFE_INTEGER {
            return Err(BrokerError::InvalidEnvelope(
                "sequence must be a positive JavaScript-safe integer".into(),
            ));
        }
        if !self.deadline.ends_with('Z') {
            return Err(BrokerError::InvalidEnvelope(
                "deadline must be a UTC RFC 3339 timestamp ending in Z".into(),
            ));
        }
        let deadline = DateTime::parse_from_rfc3339(&self.deadline)
            .map_err(|_| BrokerError::InvalidEnvelope("deadline is not RFC 3339".into()))?
            .with_timezone(&Utc);
        if deadline < now {
            return Err(BrokerError::InvalidEnvelope("deadline has elapsed".into()));
        }
        Ok(())
    }

    fn expected_auth_tag(&self, secret: &[u8]) -> Result<String> {
        let unsigned = UnsignedEnvelope {
            version: self.version,
            message_id: self.message_id,
            correlation_id: self.correlation_id,
            session_id: self.session_id,
            sequence: self.sequence,
            deadline: &self.deadline,
            lineage: &self.lineage,
            message_type: self.message_type,
            payload: &self.payload,
        };
        let canonical = canonical_json(&serde_json::to_value(unsigned)?)?;
        let mut mac = HmacSha256::new_from_slice(secret)
            .map_err(|_| BrokerError::InvalidConfig("invalid HMAC key".into()))?;
        mac.update(canonical.as_bytes());
        Ok(BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }
}

/// Session-bound replay and ordering guard. A failed frame never mutates state.
#[derive(Debug)]
pub struct ReplayGuard {
    session_id: Option<Uuid>,
    next_by_correlation: HashMap<Uuid, u64>,
    seen: HashSet<Uuid>,
    seen_order: VecDeque<Uuid>,
    capacity: usize,
}

impl Default for ReplayGuard {
    fn default() -> Self {
        Self::new(DEFAULT_REPLAY_CAPACITY)
    }
}

impl ReplayGuard {
    pub fn new(capacity: usize) -> Self {
        Self {
            session_id: None,
            next_by_correlation: HashMap::new(),
            seen: HashSet::new(),
            seen_order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn session_id(&self) -> Option<Uuid> {
        self.session_id
    }

    pub fn accept(&mut self, envelope: &ProtocolEnvelope, now: DateTime<Utc>) -> Result<()> {
        envelope.validate(now)?;
        if let Some(session) = self.session_id {
            if envelope.session_id != session {
                return Err(BrokerError::InvalidEnvelope(
                    "frame belongs to a different session".into(),
                ));
            }
        } else if envelope.message_type != MessageType::Handshake {
            return Err(BrokerError::InvalidEnvelope(
                "the first authenticated frame must be a handshake".into(),
            ));
        }
        if self.seen.contains(&envelope.message_id) {
            return Err(BrokerError::InvalidEnvelope(
                "message replay detected".into(),
            ));
        }
        let expected = self
            .next_by_correlation
            .get(&envelope.correlation_id)
            .copied()
            .unwrap_or(1);
        if envelope.sequence != expected {
            return Err(BrokerError::SequenceViolation {
                expected,
                actual: envelope.sequence,
            });
        }

        self.session_id.get_or_insert(envelope.session_id);
        self.next_by_correlation
            .insert(envelope.correlation_id, expected + 1);
        self.seen.insert(envelope.message_id);
        self.seen_order.push_back(envelope.message_id);
        while self.seen_order.len() > self.capacity {
            if let Some(oldest) = self.seen_order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        Ok(())
    }
}

pub fn decode_transport_secret(value: &str) -> Result<Vec<u8>> {
    let decoded = BASE64_URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| BrokerError::InvalidConfig("invalid transport secret encoding".into()))?;
    if decoded.len() < 32 {
        return Err(BrokerError::InvalidConfig(
            "transport secret must contain at least 256 bits".into(),
        ));
    }
    Ok(decoded)
}

pub fn uuid_v7() -> Uuid {
    Uuid::now_v7()
}

/// RFC 8785-compatible canonical JSON for the contract's JSON domain.
pub fn canonical_json(value: &Value) -> Result<String> {
    let mut output = String::new();
    write_canonical(value, &mut output)?;
    Ok(output)
}

fn write_canonical(value: &Value, output: &mut String) -> Result<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => write_number(value, output)?,
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write_canonical(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn write_number(value: &Number, output: &mut String) -> Result<()> {
    if let Some(integer) = value.as_i64() {
        output.push_str(&integer.to_string());
    } else if let Some(integer) = value.as_u64() {
        output.push_str(&integer.to_string());
    } else if let Some(float) = value.as_f64() {
        if !float.is_finite() {
            return Err(BrokerError::InvalidEnvelope(
                "non-finite JSON number".into(),
            ));
        }
        output.push_str(ryu_js::Buffer::new().format_finite(float));
    } else {
        return Err(BrokerError::InvalidEnvelope("invalid JSON number".into()));
    }
    Ok(())
}

fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(sequence: u64) -> ProtocolEnvelope {
        ProtocolEnvelope::unsigned(
            uuid_v7(),
            uuid_v7(),
            uuid_v7(),
            sequence,
            (Utc::now() + chrono::Duration::seconds(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ProtocolLineage::default(),
            MessageType::Handshake,
            Map::new(),
        )
        .sign(&[7; 32])
        .unwrap()
    }

    #[test]
    fn exact_contract_is_camel_case_and_closed() {
        let value = serde_json::to_value(envelope(1)).unwrap();
        assert!(value.get("messageId").is_some());
        assert!(value.get("message_id").is_none());
        let mut value = value;
        value["surprise"] = Value::Bool(true);
        assert!(serde_json::from_value::<ProtocolEnvelope>(value).is_err());
    }

    #[test]
    fn signs_and_detects_tampering() {
        let envelope = envelope(1);
        envelope.verify_auth(&[7; 32]).unwrap();
        let mut tampered = envelope.clone();
        tampered.payload.insert("extra".into(), Value::Bool(true));
        assert!(tampered.verify_auth(&[7; 32]).is_err());
    }

    #[test]
    fn canonical_json_matches_ecmascript_shape() {
        let value = serde_json::json!({"z": 1.0, "a": [true, {"b": "x"}]});
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":[true,{"b":"x"}],"z":1}"#
        );
    }

    #[test]
    fn replay_guard_binds_session_and_orders_each_correlation() {
        let now = Utc::now();
        let first = envelope(1);
        let correlation = first.correlation_id;
        let session = first.session_id;
        let mut guard = ReplayGuard::default();
        guard.accept(&first, now).unwrap();
        assert!(guard.accept(&first, now).is_err());

        let mut second = envelope(2);
        second.correlation_id = correlation;
        second.session_id = session;
        second = second.sign(&[7; 32]).unwrap();
        guard.accept(&second, now).unwrap();

        let mut foreign = envelope(1);
        foreign.message_type = MessageType::Request;
        foreign = foreign.sign(&[7; 32]).unwrap();
        assert!(guard.accept(&foreign, now).is_err());
    }
}
