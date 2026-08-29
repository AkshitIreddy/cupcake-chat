//! Deterministic private-pipe runtime used by broker process integration tests.
//! Packaging always selects the `cupcake-tool-broker` binary explicitly; this
//! helper is never staged as a product sidecar.

use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::framing::{
    read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES,
};
use cupcake_tool_broker::protocol::{
    decode_transport_secret, uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard,
};
use cupcake_tool_broker::{BrokerError, Result, PROTOCOL_VERSION};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{stdin, stdout, BufReader, BufWriter};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

fn main() {
    if let Err(error) = run() {
        eprintln!("fake runtime failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if std::env::args_os().nth(1).as_deref() != Some(OsStr::new("--stdio")) {
        return Err(BrokerError::InvalidConfig(
            "fake runtime requires --stdio".into(),
        ));
    }
    let secret = decode_transport_secret(
        &std::env::var("CUPCAKE_RUNTIME_AUTH")
            .map_err(|_| BrokerError::InvalidConfig("runtime auth missing".into()))?,
    )?;
    let mut input = BufReader::new(stdin().lock());
    let mut output = BufWriter::new(stdout().lock());
    let mut replay = ReplayGuard::default();
    let mut sequences: HashMap<Uuid, u64> = HashMap::new();
    let mut local_models_discovered = false;

    loop {
        let envelope: ProtocolEnvelope =
            match read_protocol_frame(&mut input, DEFAULT_MAX_FRAME_BYTES) {
                Ok(value) => value,
                Err(BrokerError::TruncatedFrame) => return Ok(()),
                Err(error) => return Err(error),
            };
        envelope.verify_auth(&secret)?;
        replay.accept(&envelope, Utc::now())?;
        match envelope.message_type {
            MessageType::Handshake => write(
                &mut output,
                &mut sequences,
                &secret,
                &envelope,
                MessageType::Handshake,
                object(json!({"product":"CUPCAKEAGI","protocolVersion":PROTOCOL_VERSION})),
            )?,
            MessageType::Request => {
                let method = envelope.payload.get("method").and_then(Value::as_str);
                let model_id = envelope
                    .payload
                    .get("params")
                    .and_then(Value::as_object)
                    .and_then(|params| params.get("modelId"))
                    .and_then(Value::as_str);
                if method == Some("chat.send") && model_id == Some("mock:stream") {
                    write(
                        &mut output,
                        &mut sequences,
                        &secret,
                        &envelope,
                        MessageType::Event,
                        object(json!({
                            "type":"message.delta",
                            "payload":{"text":"first"},
                            "timestamp":Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
                        })),
                    )?;
                    thread::sleep(Duration::from_millis(1_500));
                }
                let result = match method {
                    Some("local_models.discover") => {
                        local_models_discovered = true;
                        json!({
                            "endpoints": [{
                                "id": "lm_studio:http://127.0.0.1:1234",
                                "kind": "lm_studio",
                                "base_url": "",
                                "state": "ready",
                                "models": ["local-test-model"]
                            }],
                            "models": [{
                                "id": "openai-compatible:lm-studio-local/local-test-model",
                                "provider": "openai-compatible",
                                "model": "local-test-model",
                                "display_name": "Local test model",
                                "privacy_route": "local",
                                "metadata": {"runtime_kind": "lm_studio"}
                            }]
                        })
                    }
                    Some("broker.providers.resolve_compatible_route")
                        if local_models_discovered
                            && model_id
                                == Some("openai-compatible:lm-studio-local/local-test-model") =>
                    {
                        json!({
                            "modelId": model_id,
                            "baseUrl": "http://127.0.0.1:1234/v1",
                            "runtimeKind": "lm_studio",
                            "privacyRoute": "local"
                        })
                    }
                    Some("broker.providers.resolve_compatible_route") => Value::Null,
                    _ => json!({"method": method}),
                };
                write(
                    &mut output,
                    &mut sequences,
                    &secret,
                    &envelope,
                    MessageType::Response,
                    object(json!({"ok":true,"result":result})),
                )?;
            }
            MessageType::Cancel => write(
                &mut output,
                &mut sequences,
                &secret,
                &envelope,
                MessageType::Response,
                object(json!({"ok":true,"result":{"cancelled":true}})),
            )?,
            MessageType::Shutdown => {
                write(
                    &mut output,
                    &mut sequences,
                    &secret,
                    &envelope,
                    MessageType::Response,
                    object(json!({"ok":true,"result":{"stopped":true}})),
                )?;
                return Ok(());
            }
            _ => {
                return Err(BrokerError::InvalidEnvelope(
                    "unexpected fake-runtime message".into(),
                ))
            }
        }
    }
}

fn write<W: std::io::Write>(
    output: &mut W,
    sequences: &mut HashMap<Uuid, u64>,
    secret: &[u8],
    request: &ProtocolEnvelope,
    message_type: MessageType,
    payload: Map<String, Value>,
) -> Result<()> {
    let sequence = sequences
        .entry(request.correlation_id)
        .and_modify(|value| *value += 1)
        .or_insert(1);
    let response = ProtocolEnvelope::unsigned(
        uuid_v7(),
        request.correlation_id,
        request.session_id,
        *sequence,
        (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339_opts(SecondsFormat::Millis, true),
        ProtocolLineage::default(),
        message_type,
        payload,
    )
    .sign(secret)?;
    write_protocol_frame(output, &response, DEFAULT_MAX_FRAME_BYTES)
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
