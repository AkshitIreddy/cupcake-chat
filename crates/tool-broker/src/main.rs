use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::credential_prompt::prompt_api_key;
use cupcake_tool_broker::framing::{
    read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES,
};
use cupcake_tool_broker::integration::BrokerIntegration;
use cupcake_tool_broker::protocol::{
    decode_transport_secret, uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard,
    RuntimeBrokerRequest,
};
use cupcake_tool_broker::registry::native_descriptor_catalog;
use cupcake_tool_broker::runtime::RuntimeChild;
use cupcake_tool_broker::vault::{select_platform_vault, SecretBytes, SelectedVault};
use cupcake_tool_broker::{BrokerError, Result, PROTOCOL_VERSION};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{stdin, stdout, BufReader, BufWriter, Write};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration as StdDuration;
use url::Url;
use uuid::Uuid;

type OutboundMessages = Vec<(MessageType, Map<String, Value>)>;

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{{\"level\":\"error\",\"component\":\"broker\",\"message\":{}}}",
            serde_json::to_string(&safe_error(&error))
                .unwrap_or_else(|_| "\"broker failed\"".into())
        );
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != "--stdio" {
        return Err(BrokerError::InvalidConfig(
            "usage: cupcake-tool-broker --stdio".into(),
        ));
    }
    let declared_version = std::env::var("CUPCAKE_PROTOCOL_VERSION")
        .map_err(|_| BrokerError::InvalidConfig("CUPCAKE_PROTOCOL_VERSION is required".into()))?
        .parse::<u16>()
        .map_err(|_| BrokerError::InvalidConfig("invalid protocol version".into()))?;
    if declared_version != PROTOCOL_VERSION {
        return Err(BrokerError::UnsupportedProtocol(declared_version));
    }
    let encoded_secret = std::env::var("CUPCAKE_BROKER_AUTH")
        .map_err(|_| BrokerError::InvalidConfig("CUPCAKE_BROKER_AUTH is required".into()))?;
    let secret = decode_transport_secret(&encoded_secret)?;
    // Children launched later must not inherit the transport authenticator.
    std::env::remove_var("CUPCAKE_BROKER_AUTH");
    drop(encoded_secret);

    let mut output = BufWriter::new(stdout().lock());
    let (incoming_tx, incoming_rx) = mpsc::channel::<Result<ProtocolEnvelope>>();
    let reader_secret = secret.clone();
    std::thread::spawn(move || {
        let mut input = BufReader::new(stdin());
        let mut replay = ReplayGuard::default();
        loop {
            let result = (|| {
                let envelope: ProtocolEnvelope =
                    read_protocol_frame(&mut input, DEFAULT_MAX_FRAME_BYTES)?;
                envelope.verify_auth(&reader_secret)?;
                replay.accept(&envelope, Utc::now())?;
                Ok(envelope)
            })();
            let terminal = result.is_err();
            if incoming_tx.send(result).is_err() || terminal {
                break;
            }
        }
    });
    let mut queued = VecDeque::new();
    let mut outgoing_sequences: HashMap<Uuid, u64> = HashMap::new();
    let mut handshaken = false;
    let mut runtime: Option<RuntimeChild> = None;
    let credential_vault = select_platform_vault();
    let data_dir = std::env::var_os("CUPCAKE_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| BrokerError::InvalidConfig("CUPCAKE_DATA_DIR is required".into()))?;
    let mut integration = BrokerIntegration::open(&data_dir)?;

    loop {
        let mut envelope: ProtocolEnvelope = match queued.pop_front().map(Ok).unwrap_or_else(|| {
            incoming_rx
                .recv()
                .unwrap_or(Err(BrokerError::TruncatedFrame))
        }) {
            Ok(value) => value,
            // Closing stdin is the normal desktop shutdown path. A partial body
            // is indistinguishable at this sync boundary and is safe to reject.
            Err(BrokerError::TruncatedFrame) => return Ok(()),
            Err(error) => return Err(error),
        };
        let (responses, should_continue) = match envelope.message_type {
            MessageType::Handshake if !handshaken => {
                require_handshake(&envelope.payload)?;
                handshaken = true;
                (
                    vec![(
                        MessageType::Handshake,
                        object(json!({
                            "product": "CUPCAKEAGI",
                            "protocolVersion": PROTOCOL_VERSION,
                            "brokerVersion": env!("CARGO_PKG_VERSION"),
                            "pid": std::process::id(),
                            "capabilities": ["tool-policy", "filesystem-grants", "mcp", "credential-vault", "sandbox-plans", "python-runtime-proxy"]
                        })),
                    )],
                    true,
                )
            }
            MessageType::Handshake => (
                vec![(
                    MessageType::Response,
                    failure("HANDSHAKE_ALREADY_COMPLETE", "Handshake is one-time", false),
                )],
                true,
            ),
            MessageType::Ping if handshaken => (vec![(MessageType::Pong, Map::new())], true),
            MessageType::Request if handshaken => {
                let routed = match dispatch_secure_request(
                    &mut envelope.payload,
                    &mut runtime,
                    &credential_vault,
                ) {
                    Ok(Some(responses)) => responses,
                    Err(error) => vec![(
                        MessageType::Response,
                        failure("SECURE_REQUEST_FAILED", &safe_error(&error), false),
                    )],
                    Ok(None) => {
                        if let Some(response) =
                            dispatch_broker_request(&envelope.payload, &mut integration)
                        {
                            vec![(MessageType::Response, response)]
                        } else {
                            prepare_migration_request(&mut envelope.payload, &mut integration)
                                .and_then(|cleanup_migration| {
                                    prepare_chat_attachment_preflight(
                                        &mut envelope.payload,
                                        &mut integration,
                                    )?;
                                    configure_selected_provider(
                                        &envelope.payload,
                                        &mut runtime,
                                        &credential_vault,
                                    )?;
                                    prepare_chat_attachments(
                                        &mut envelope.payload,
                                        &mut integration,
                                        &mut runtime,
                                    )?;
                                    let response = proxy_runtime_stream(
                                        ensure_runtime(&mut runtime)?,
                                        &envelope.payload,
                                        &incoming_rx,
                                        &mut queued,
                                        &mut output,
                                        &mut outgoing_sequences,
                                        &secret,
                                        &envelope,
                                    )?;
                                    if cleanup_migration
                                        && response.get("ok").and_then(Value::as_bool) == Some(true)
                                    {
                                        integration.cleanup_migration_snapshot()?;
                                    }
                                    Ok(response)
                                })
                                .map(|response| vec![(MessageType::Response, response)])
                                .unwrap_or_else(|error| {
                                    vec![(
                                        MessageType::Response,
                                        failure("RUNTIME_UNAVAILABLE", &safe_error(&error), true),
                                    )]
                                })
                        }
                    }
                };
                (routed, true)
            }
            MessageType::Event if handshaken => {
                let response = match integration.handle_desktop_event(&envelope.payload) {
                    Ok(result) => success(result),
                    Err(error) => failure("INVALID_DESKTOP_EVENT", &safe_error(&error), false),
                };
                (vec![(MessageType::Response, response)], true)
            }
            MessageType::Cancel if handshaken => {
                let routed = ensure_runtime(&mut runtime)
                    .and_then(|child| child.control().signal_cancel(envelope.payload.clone()))
                    .map(|()| {
                        vec![(
                            MessageType::Response,
                            success(json!({"cancelRequested": true})),
                        )]
                    })
                    .unwrap_or_else(|_| {
                        vec![(
                            MessageType::Response,
                            failure("NOT_RUNNING", "No matching run is active", false),
                        )]
                    });
                (routed, true)
            }
            MessageType::Shutdown if handshaken => {
                if let Some(child) = runtime.as_mut() {
                    child.shutdown();
                }
                (
                    vec![(MessageType::Response, success(json!({"stopped": true})))],
                    false,
                )
            }
            _ => (
                vec![(
                    MessageType::Response,
                    failure(
                        "INVALID_PROTOCOL_STATE",
                        "Message is not valid in the current state",
                        false,
                    ),
                )],
                false,
            ),
        };

        for (response_type, response_payload) in responses {
            write_outbound(
                &mut output,
                &mut outgoing_sequences,
                &secret,
                envelope.correlation_id,
                envelope.session_id,
                envelope.lineage.clone(),
                response_type,
                response_payload,
            )?;
        }
        if !should_continue {
            return Ok(());
        }
    }
}

fn prepare_migration_request(
    payload: &mut Map<String, Value>,
    integration: &mut BrokerIntegration,
) -> Result<bool> {
    match payload.get("method").and_then(Value::as_str) {
        Some("migration.preview") => {
            let handle_id = payload
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("sourceHandleId"))
                .and_then(Value::as_str)
                .ok_or(BrokerError::InvalidGrant)?;
            let staged = integration.stage_migration_snapshot(handle_id)?;
            payload.insert(
                "method".into(),
                Value::String("migration.preview.private".into()),
            );
            payload.insert(
                "params".into(),
                json!({
                    "snapshotPath": staged.snapshot_path.to_string_lossy(),
                    "manifestPath": staged.manifest_path.to_string_lossy(),
                    "manifestSha256": staged.manifest_sha256,
                    "stagingToken": staged.staging_id
                }),
            );
            Ok(false)
        }
        Some("migration.execute") | Some("migration.decline") => Ok(true),
        _ => Ok(false),
    }
}

enum RuntimeStreamMessage {
    Event(Map<String, Value>),
    Done(Result<Map<String, Value>>),
}

#[allow(clippy::too_many_arguments)]
fn proxy_runtime_stream<W: Write>(
    runtime: &mut RuntimeChild,
    payload: &Map<String, Value>,
    incoming: &mpsc::Receiver<Result<ProtocolEnvelope>>,
    queued: &mut VecDeque<ProtocolEnvelope>,
    output: &mut W,
    outgoing_sequences: &mut HashMap<Uuid, u64>,
    secret: &[u8],
    desktop_request: &ProtocolEnvelope,
) -> Result<Map<String, Value>> {
    let control = runtime.control();
    std::thread::scope(|scope| {
        let (stream_tx, stream_rx) = mpsc::channel();
        scope.spawn(move || {
            let result = runtime.request_streaming(payload, |event| {
                stream_tx
                    .send(RuntimeStreamMessage::Event(event))
                    .map_err(|_| {
                        BrokerError::InvalidConfig("desktop stream receiver stopped".into())
                    })
            });
            if let Err(error) = &result {
                eprintln!("{{\"level\":\"error\",\"component\":\"broker\",\"errorType\":\"runtime_stream\",\"message\":\"{}\"}}", error);
            }
            let _ = stream_tx.send(RuntimeStreamMessage::Done(result));
        });

        loop {
            while let Ok(message) = stream_rx.try_recv() {
                match message {
                    RuntimeStreamMessage::Event(payload) => write_outbound(
                        output,
                        outgoing_sequences,
                        secret,
                        desktop_request.correlation_id,
                        desktop_request.session_id,
                        desktop_request.lineage.clone(),
                        MessageType::Event,
                        payload,
                    )?,
                    RuntimeStreamMessage::Done(result) => return result,
                }
            }

            match incoming.recv_timeout(StdDuration::from_millis(10)) {
                Ok(Ok(envelope)) if envelope.message_type == MessageType::Cancel => {
                    let response = match control.signal_cancel(envelope.payload.clone()) {
                        Ok(()) => success(json!({"cancelRequested": true})),
                        Err(error) => failure("CANCEL_FAILED", &safe_error(&error), true),
                    };
                    write_outbound(
                        output,
                        outgoing_sequences,
                        secret,
                        envelope.correlation_id,
                        envelope.session_id,
                        envelope.lineage,
                        MessageType::Response,
                        response,
                    )?;
                }
                Ok(Ok(envelope)) if envelope.message_type == MessageType::Ping => {
                    write_outbound(
                        output,
                        outgoing_sequences,
                        secret,
                        envelope.correlation_id,
                        envelope.session_id,
                        envelope.lineage,
                        MessageType::Pong,
                        Map::new(),
                    )?;
                }
                Ok(Ok(envelope)) => queued.push_back(envelope),
                Ok(Err(BrokerError::TruncatedFrame)) => return Err(BrokerError::TruncatedFrame),
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(BrokerError::TruncatedFrame)
                }
            }
        }
    })
}

fn prepare_chat_attachments(
    payload: &mut Map<String, Value>,
    integration: &mut BrokerIntegration,
    runtime: &mut Option<RuntimeChild>,
) -> Result<()> {
    if payload.get("method").and_then(Value::as_str) != Some("chat.send") {
        return Ok(());
    }
    let params = payload
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BrokerError::InvalidEnvelope("chat params are required".into()))?;
    let handle_ids = requested_attachment_handle_ids(params)?;
    if handle_ids.is_empty() {
        return Ok(());
    }
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let conversation_id = params
        .get("conversationId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut product_attachments = Vec::with_capacity(handle_ids.len());
    let mut attachment_bindings = Vec::with_capacity(handle_ids.len());
    let mut staged_attachments = Vec::with_capacity(handle_ids.len());
    let mut staged_ids = Vec::new();
    let result = (|| -> Result<()> {
        for handle_id in &handle_ids {
            let staged = integration.stage_attachment(handle_id)?;
            staged_ids.push(staged.staging_id.clone());
            attachment_bindings.push(staged_attachment_binding(&staged));
            staged_attachments.push(staged);
        }
        attachment_bindings.sort_by(|left, right| {
            left.get("handleId")
                .and_then(Value::as_str)
                .cmp(&right.get("handleId").and_then(Value::as_str))
        });
        validate_confirmed_attachment_bindings(params, &attachment_bindings)?;
        for staged in &staged_attachments {
            let structured_document = integration.parse_staged_document(staged)?;
            // Parsing may be a long-running sandbox operation. Re-resolve the
            // desktop grant and re-hash both source and staged copies after it
            // completes, immediately before the private runtime request.
            integration.revalidate_staged_attachment(staged)?;
            let request = object(json!({
                "method": "ingestion.ingest.private",
                "params": {
                    "projectId": project_id.clone(),
                    "conversationId": conversation_id.clone(),
                    "sourceHandle": staged.source_handle_id,
                    "displayName": staged.display_name.clone(),
                    "stagedPath": staged.payload_path.to_string_lossy(),
                    "manifestPath": staged.manifest_path.to_string_lossy(),
                    "sha256": staged.sha256.clone(),
                    "byteSize": staged.byte_size,
                    "mediaType": "application/octet-stream",
                    "structuredDocument": structured_document
                }
            }));
            let messages = ensure_runtime(runtime)?.request(&request)?;
            let response = messages
                .last()
                .and_then(|(message_type, value)| {
                    (*message_type == MessageType::Response).then_some(value)
                })
                .ok_or_else(|| {
                    BrokerError::InvalidEnvelope("ingestion response is missing".into())
                })?;
            if response.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(BrokerError::InvalidConfig(
                    "runtime rejected staged attachment".into(),
                ));
            }
            let ingested = response.get("result").cloned().unwrap_or(Value::Null);
            product_attachments.push(resolved_attachment_descriptor(&ingested, staged)?);
        }
        Ok(())
    })();
    let mut cleanup_error = None;
    for staging_id in &staged_ids {
        if let Err(error) = integration.cleanup_staged_attachment(staging_id) {
            cleanup_error.get_or_insert(error);
        }
    }
    if let Some(error) = cleanup_error {
        return Err(error);
    }
    result?;
    params.insert(
        "attachments".into(),
        Value::Array(product_attachments.clone()),
    );
    params.insert(
        "attachmentHandles".into(),
        Value::Array(handle_ids.into_iter().map(Value::String).collect()),
    );
    params.insert(
        "attachmentBindings".into(),
        Value::Array(attachment_bindings),
    );
    Ok(())
}

/// Resolve and hash attachment capabilities during cloud disclosure preflight.
/// Only the opaque handle, byte count, and digest cross the broker boundary;
/// neither the renderer nor the runtime confirmation record receives a path.
fn prepare_chat_attachment_preflight(
    payload: &mut Map<String, Value>,
    integration: &mut BrokerIntegration,
) -> Result<()> {
    if payload.get("method").and_then(Value::as_str) != Some("chat.preflight") {
        return Ok(());
    }
    let params = payload
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| BrokerError::InvalidEnvelope("chat params are required".into()))?;
    let handle_ids = requested_attachment_handle_ids(params)?;
    let mut bindings = Vec::with_capacity(handle_ids.len());
    for handle_id in handle_ids {
        let staged = integration.stage_attachment(&handle_id)?;
        let staging_id = staged.staging_id.clone();
        let result = integration
            .revalidate_staged_attachment(&staged)
            .map(|()| staged_attachment_binding(&staged));
        let cleanup = integration.cleanup_staged_attachment(&staging_id);
        bindings.push(result?);
        cleanup?;
    }
    bindings.sort_by(|left, right| {
        left.get("handleId")
            .and_then(Value::as_str)
            .cmp(&right.get("handleId").and_then(Value::as_str))
    });
    params.insert("attachmentBindings".into(), Value::Array(bindings));
    Ok(())
}

fn staged_attachment_binding(staged: &cupcake_tool_broker::integration::StagedAttachment) -> Value {
    json!({
        "handleId": staged.source_handle_id,
        "byteSize": staged.byte_size,
        "sha256": staged.sha256,
    })
}

fn validate_confirmed_attachment_bindings(
    params: &Map<String, Value>,
    actual: &[Value],
) -> Result<()> {
    let Some(intent) = params.get("outboundIntent") else {
        return Ok(());
    };
    let expected = intent
        .as_object()
        .and_then(|value| value.get("attachmentBindings"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BrokerError::Integrity(
                "confirmed outbound intent is missing attachment bindings".into(),
            )
        })?;
    if expected.as_slice() != actual {
        return Err(BrokerError::Integrity(
            "attachment changed after outbound confirmation".into(),
        ));
    }
    Ok(())
}

/// Accept both the renderer's compact `attachmentHandles` contract and its
/// richer attachment records. When both are present they must identify the
/// same ordered capabilities. Presentation metadata (including destination)
/// is intentionally ignored.
fn requested_attachment_handle_ids(params: &Map<String, Value>) -> Result<Vec<String>> {
    let compact = match params.get("attachmentHandles") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        BrokerError::InvalidEnvelope(
                            "attachmentHandles must contain handle IDs".into(),
                        )
                    })
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => {
            return Err(BrokerError::InvalidEnvelope(
                "attachmentHandles must be an array".into(),
            ))
        }
    };
    let structured = match params.get("attachments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_object()
                    .and_then(|attachment| attachment.get("handleId"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        BrokerError::InvalidEnvelope("attachment must contain a handleId".into())
                    })
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => {
            return Err(BrokerError::InvalidEnvelope(
                "attachments must be an array".into(),
            ))
        }
    };
    if !compact.is_empty() && !structured.is_empty() && compact != structured {
        return Err(BrokerError::InvalidEnvelope(
            "attachment handle lists do not match".into(),
        ));
    }
    let handles = if compact.is_empty() {
        structured
    } else {
        compact
    };
    if handles.len() > 32 {
        return Err(BrokerError::InvalidConfig(
            "a chat can attach at most 32 files".into(),
        ));
    }
    let mut unique = HashSet::with_capacity(handles.len());
    if !handles.iter().all(|handle| unique.insert(handle.clone())) {
        return Err(BrokerError::InvalidEnvelope(
            "attachment handles must be unique".into(),
        ));
    }
    Ok(handles)
}

fn resolved_attachment_descriptor(
    ingested: &Value,
    staged: &cupcake_tool_broker::integration::StagedAttachment,
) -> Result<Value> {
    let file_id = ingested
        .get("file")
        .and_then(Value::as_object)
        .and_then(|file| file.get("id"))
        .and_then(Value::as_str)
        // Retain compatibility with recorded fixtures from the earliest 2.0
        // runtime while preferring the current nested product file record.
        .or_else(|| ingested.get("fileId").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BrokerError::Integrity("ingested attachment file ID is missing".into()))?;
    let source_id = ingested
        .get("sourceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BrokerError::Integrity("ingested attachment source ID is missing".into()))?;
    Ok(json!({
        "fileId": file_id,
        "sourceId": source_id,
        "name": staged.display_name,
        "sha256": staged.sha256,
        "byteSize": staged.byte_size,
        "mediaType": "application/octet-stream",
        "brokerGrantId": staged.broker_grant_id
    }))
}

fn require_handshake(payload: &Map<String, Value>) -> Result<()> {
    if payload.get("product").and_then(Value::as_str) != Some("CUPCAKEAGI")
        || payload.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
    {
        return Err(BrokerError::InvalidEnvelope(
            "invalid CUPCAKEAGI handshake payload".into(),
        ));
    }
    Ok(())
}

fn dispatch_broker_request(
    payload: &Map<String, Value>,
    integration: &mut BrokerIntegration,
) -> Option<Map<String, Value>> {
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return Some(failure(
            "INVALID_REQUEST",
            "Request method is required",
            false,
        ));
    };
    Some(match method {
        "broker.describe" => success(json!({
            "name": "cupcake-tool-broker",
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": PROTOCOL_VERSION
        })),
        "tools.list" => success(
            serde_json::to_value(native_descriptor_catalog()).unwrap_or(Value::Array(vec![])),
        ),
        "broker.native.preflight" => {
            integration.native_preflight(payload.get("params").cloned().unwrap_or(Value::Null))
        }
        "broker.native.approval.issue" => {
            integration.native_issue_approval(payload.get("params").cloned().unwrap_or(Value::Null))
        }
        "broker.native.execute" => {
            integration.native_execute(payload.get("params").cloned().unwrap_or(Value::Null))
        }
        "broker.native.cancel" => {
            integration.native_cancel(payload.get("params").cloned().unwrap_or(Value::Null))
        }
        "broker.dispatch" => {
            let request = payload
                .get("params")
                .cloned()
                .ok_or("missing params")
                .and_then(|value| {
                    serde_json::from_value::<RuntimeBrokerRequest>(value)
                        .map_err(|_| "invalid params")
                });
            match request {
                Ok(request) if request.validate().is_ok() => integration.dispatch(request),
                _ => failure(
                    "INVALID_REQUEST",
                    "Broker dispatch payload is malformed",
                    false,
                ),
            }
        }
        _ => return None,
    })
}

#[allow(clippy::too_many_arguments)]
fn write_outbound<W: Write>(
    output: &mut W,
    outgoing_sequences: &mut HashMap<Uuid, u64>,
    secret: &[u8],
    correlation_id: Uuid,
    session_id: Uuid,
    lineage: ProtocolLineage,
    message_type: MessageType,
    payload: Map<String, Value>,
) -> Result<()> {
    let sequence = outgoing_sequences
        .entry(correlation_id)
        .and_modify(|value| *value += 1)
        .or_insert(1);
    let response = ProtocolEnvelope::unsigned(
        uuid_v7(),
        correlation_id,
        session_id,
        *sequence,
        (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339_opts(SecondsFormat::Millis, true),
        lineage,
        message_type,
        payload,
    )
    .sign(secret)?;
    write_protocol_frame(output, &response, DEFAULT_MAX_FRAME_BYTES)
}

fn ensure_runtime(runtime: &mut Option<RuntimeChild>) -> Result<&mut RuntimeChild> {
    if runtime.is_none() {
        *runtime = RuntimeChild::launch_from_environment()?;
    }
    runtime
        .as_mut()
        .ok_or_else(|| BrokerError::InvalidConfig("packaged Python runtime is unavailable".into()))
}

fn dispatch_secure_request(
    payload: &mut Map<String, Value>,
    runtime: &mut Option<RuntimeChild>,
    vault: &SelectedVault,
) -> Result<Option<OutboundMessages>> {
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return Ok(None);
    };
    match method {
        "providers.status" => {
            let mut providers = provider_names()
                .iter()
                .map(|provider| {
                    let configured = vault.inner().load(&provider_account(provider))?.is_some();
                    Ok(json!({"provider": provider, "configured": configured}))
                })
                .collect::<Result<Vec<_>>>()?;
            let generic = load_openai_compatible_endpoint(vault)?;
            let generic_configured = if let Some(endpoint) = &generic {
                vault
                    .inner()
                    .load(&openai_compatible_key_account(&endpoint.id))?
                    .is_some()
            } else {
                false
            };
            providers.push(json!({
                "provider": "openai-compatible",
                "configured": generic_configured,
                "endpointId": generic.as_ref().map(|endpoint| endpoint.id.as_str())
            }));
            Ok(Some(vec![(
                MessageType::Response,
                success(json!({
                    "providers": providers,
                    "vault": vault.inner().backend_name(),
                    "persistent": vault.inner().is_persistent(),
                    "fallbackReason": vault.fallback_reason()
                })),
            )]))
        }
        "providers.catalog.refresh" => {
            let params = payload
                .get("params")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    BrokerError::InvalidEnvelope("catalog params are required".into())
                })?;
            let provider = params
                .get("provider")
                .and_then(Value::as_str)
                .filter(|value| *value == "nvidia-nim")
                .ok_or_else(|| BrokerError::InvalidConfig("unsupported catalog provider".into()))?;
            let secret = vault
                .inner()
                .load(&provider_account(provider))?
                .ok_or_else(|| {
                    BrokerError::PermissionDenied("NVIDIA NIM is not connected".into())
                })?;
            let mut options = Map::new();
            if params.get("force").and_then(Value::as_bool) == Some(true) {
                options.insert("forceCatalogRefresh".into(), Value::Bool(true));
            }
            let result = configure_provider(provider, secret.expose(), &options, runtime)?;
            Ok(Some(vec![(MessageType::Response, success(result))]))
        }
        "providers.connect" | "providers.connectInteractive" => {
            let interactive = method == "providers.connectInteractive";
            let params = payload
                .get_mut("params")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    BrokerError::InvalidEnvelope("provider params are required".into())
                })?;
            let provider = params
                .get("provider")
                .and_then(Value::as_str)
                .filter(|value| provider_names().contains(value) || *value == "openai-compatible")
                .ok_or_else(|| BrokerError::InvalidConfig("unsupported provider".into()))?
                .to_owned();
            let secret = if interactive {
                let label = provider_prompt_label(&provider);
                prompt_api_key(label)?
            } else {
                if !cfg!(debug_assertions)
                    || std::env::var("CUPCAKE_ALLOW_DEV_SECRET_INJECTION").as_deref() != Ok("1")
                {
                    params.remove("secret");
                    return Err(BrokerError::PermissionDenied(
                        "direct credential injection is disabled; use Windows credential entry"
                            .into(),
                    ));
                }
                let raw_secret = params
                    .remove("secret")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .ok_or_else(|| {
                        BrokerError::InvalidConfig("provider secret is required".into())
                    })?;
                SecretBytes::new(raw_secret.into_bytes())?
            };
            let endpoint_id = if provider == "openai-compatible" {
                let raw_base_url =
                    params
                        .get("baseUrl")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            BrokerError::InvalidConfig(
                                "OpenAI-compatible base URL is required".into(),
                            )
                        })?;
                let endpoint = validate_openai_compatible_endpoint(raw_base_url)?;
                params.insert("baseUrl".into(), Value::String(endpoint.base_url.clone()));
                vault
                    .inner()
                    .store(&openai_compatible_key_account(&endpoint.id), &secret)?;
                store_openai_compatible_endpoint(vault, &endpoint)?;
                Some(endpoint.id)
            } else {
                vault.inner().store(&provider_account(&provider), &secret)?;
                None
            };
            let runtime_result = configure_provider(&provider, secret.expose(), params, runtime)?;
            let mut response = json!({
                "provider": provider,
                "configured": true,
                "endpointId": endpoint_id,
                "persistent": vault.inner().is_persistent()
            });
            if let Some(catalog) = runtime_result.get("catalog") {
                response["catalog"] = catalog.clone();
            }
            Ok(Some(vec![(MessageType::Response, success(response))]))
        }
        "providers.disconnect" => {
            let provider = payload
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("provider"))
                .and_then(Value::as_str)
                .filter(|value| provider_names().contains(value) || *value == "openai-compatible")
                .ok_or_else(|| BrokerError::InvalidConfig("unsupported provider".into()))?;
            let removed = if provider == "openai-compatible" {
                if let Some(endpoint) = load_openai_compatible_endpoint(vault)? {
                    let removed = vault
                        .inner()
                        .delete(&openai_compatible_key_account(&endpoint.id))?;
                    vault.inner().delete(OPENAI_COMPATIBLE_ENDPOINT_ACCOUNT)?;
                    removed
                } else {
                    false
                }
            } else {
                vault.inner().delete(&provider_account(provider))?
            };
            Ok(Some(vec![(
                MessageType::Response,
                success(json!({"provider": provider, "configured": false, "removed": removed})),
            )]))
        }
        "broker.providers.resolve_compatible_route" => Err(BrokerError::PermissionDenied(
            "runtime route resolution is private to the broker".into(),
        )),
        _ => Ok(None),
    }
}

fn configure_selected_provider(
    payload: &Map<String, Value>,
    runtime: &mut Option<RuntimeChild>,
    vault: &SelectedVault,
) -> Result<()> {
    if payload.get("method").and_then(Value::as_str) != Some("chat.send") {
        return Ok(());
    }
    let Some(model_id) = payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("modelId"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let provider = model_id.split(':').next().unwrap_or_default();
    if provider == "openai-compatible" {
        if resolve_runtime_compatible_route(model_id, runtime)?.is_some() {
            // The exact model already owns its runtime-scoped configuration in
            // Python.  It may include an ephemeral app-managed local bearer
            // token, so copying it into the cloud credential vault would both
            // weaken isolation and break local runtimes that need no user key.
            return Ok(());
        }
        let endpoint = load_openai_compatible_endpoint(vault)?.ok_or_else(|| {
            BrokerError::PermissionDenied("OpenAI-compatible endpoint is not connected".into())
        })?;
        let secret = vault
            .inner()
            .load(&openai_compatible_key_account(&endpoint.id))?
            .ok_or_else(|| {
                BrokerError::PermissionDenied("OpenAI-compatible endpoint is not connected".into())
            })?;
        let options = object(json!({"baseUrl": endpoint.base_url}));
        let _ = configure_provider(provider, secret.expose(), &options, runtime)?;
        return Ok(());
    }
    if !provider_names().contains(&provider) {
        return Ok(());
    }
    let secret = vault
        .inner()
        .load(&provider_account(provider))?
        .ok_or_else(|| BrokerError::PermissionDenied(format!("{provider} is not connected")))?;
    let _ = configure_provider(provider, secret.expose(), &Map::new(), runtime)?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeCompatibleRoute {
    model_id: String,
    base_url: String,
    runtime_kind: String,
    privacy_route: String,
}

fn resolve_runtime_compatible_route(
    model_id: &str,
    runtime: &mut Option<RuntimeChild>,
) -> Result<Option<RuntimeCompatibleRoute>> {
    let request = object(json!({
        "method": "broker.providers.resolve_compatible_route",
        "params": {"modelId": model_id}
    }));
    let messages = ensure_runtime(runtime)?.request(&request)?;
    let response = messages
        .last()
        .map(|(_, payload)| payload)
        .ok_or_else(|| BrokerError::InvalidEnvelope("runtime route response is missing".into()))?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(BrokerError::PermissionDenied(
            "runtime rejected compatible route resolution".into(),
        ));
    }
    let Some(value) = response.get("result").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    validate_runtime_compatible_route(model_id, value).map(Some)
}

fn validate_runtime_compatible_route(
    selected_model_id: &str,
    value: &Value,
) -> Result<RuntimeCompatibleRoute> {
    let route = value
        .as_object()
        .ok_or_else(|| BrokerError::Integrity("runtime route must be an object".into()))?;
    let model_id = route
        .get("modelId")
        .and_then(Value::as_str)
        .filter(|model_id| *model_id == selected_model_id)
        .ok_or_else(|| BrokerError::Integrity("runtime route model identity mismatch".into()))?;
    let base_url = route
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| BrokerError::Integrity("runtime route base URL is missing".into()))?;
    let runtime_kind = route
        .get("runtimeKind")
        .and_then(Value::as_str)
        .ok_or_else(|| BrokerError::Integrity("runtime route kind is missing".into()))?;
    let privacy_route = route
        .get("privacyRoute")
        .and_then(Value::as_str)
        .ok_or_else(|| BrokerError::Integrity("runtime route privacy is missing".into()))?;

    let url = Url::parse(base_url)
        .map_err(|_| BrokerError::Integrity("runtime route URL is invalid".into()))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::Integrity(
            "runtime route URL contains forbidden components".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let loopback = host == "localhost"
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    match runtime_kind {
        "cupcake_llama_cpp" | "ollama" | "lm_studio" => {
            if privacy_route != "local" || !loopback || !matches!(url.scheme(), "http" | "https") {
                return Err(BrokerError::PermissionDenied(
                    "local runtime route must use a loopback HTTP(S) origin".into(),
                ));
            }
        }
        "vllm" => {
            if privacy_route != "self_hosted" {
                return Err(BrokerError::PermissionDenied(
                    "vLLM route must remain self-hosted".into(),
                ));
            }
            if loopback {
                if !matches!(url.scheme(), "http" | "https") {
                    return Err(BrokerError::PermissionDenied(
                        "loopback vLLM route must use HTTP(S)".into(),
                    ));
                }
            } else {
                // Remote compatible origins retain the same HTTPS, no-userinfo,
                // public-address policy as user-configured generic endpoints.
                validate_openai_compatible_endpoint(base_url)?;
            }
        }
        _ => {
            return Err(BrokerError::PermissionDenied(
                "runtime route kind is not trusted".into(),
            ))
        }
    }
    Ok(RuntimeCompatibleRoute {
        model_id: model_id.into(),
        base_url: base_url.trim_end_matches('/').into(),
        runtime_kind: runtime_kind.into(),
        privacy_route: privacy_route.into(),
    })
}

fn configure_provider(
    provider: &str,
    secret: &[u8],
    options: &Map<String, Value>,
    runtime: &mut Option<RuntimeChild>,
) -> Result<Value> {
    let credential = std::str::from_utf8(secret)
        .map_err(|_| BrokerError::InvalidConfig("provider secret is not UTF-8".into()))?;
    let mut params = Map::new();
    params.insert("provider".into(), Value::String(provider.into()));
    params.insert("credentialLease".into(), Value::String(credential.into()));
    if let Some(value) = options.get("baseUrl") {
        params.insert("baseUrl".into(), value.clone());
    }
    if let Some(value) = options.get("organization") {
        params.insert("organization".into(), value.clone());
    }
    if let Some(value) = options
        .get("forceCatalogRefresh")
        .filter(|value| value.is_boolean())
    {
        params.insert("forceCatalogRefresh".into(), value.clone());
    }
    let request = object(json!({"method": "providers.configure", "params": params}));
    let messages = ensure_runtime(runtime)?.request(&request)?;
    let response = messages.last().map(|(_, payload)| payload).ok_or_else(|| {
        BrokerError::InvalidEnvelope("runtime provider response is missing".into())
    })?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(BrokerError::PermissionDenied(
            "runtime rejected provider configuration".into(),
        ));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn provider_names() -> &'static [&'static str] {
    &[
        "openai",
        "anthropic",
        "google",
        "xai",
        "mistral",
        "cohere",
        "nvidia-nim",
    ]
}

fn provider_account(provider: &str) -> String {
    format!("provider.{provider}.api-key")
}

fn provider_prompt_label(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "google" => "Google Gemini",
        "xai" => "xAI",
        "mistral" => "Mistral",
        "cohere" => "Cohere",
        "nvidia-nim" => "NVIDIA NIM",
        "openai-compatible" => "OpenAI-compatible endpoint",
        _ => "AI provider",
    }
}

const OPENAI_COMPATIBLE_ENDPOINT_ACCOUNT: &str = "provider.openai-compatible.selected-endpoint";

#[derive(Debug)]
struct OpenAiCompatibleEndpoint {
    id: String,
    base_url: String,
}

fn validate_openai_compatible_endpoint(value: &str) -> Result<OpenAiCompatibleEndpoint> {
    let mut url = Url::parse(value)
        .map_err(|_| BrokerError::InvalidConfig("invalid OpenAI-compatible base URL".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::InvalidConfig(
            "OpenAI-compatible base URL must be credential-free HTTPS".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(BrokerError::InvalidConfig(
            "OpenAI-compatible endpoint must be a remote HTTPS origin".into(),
        ));
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        let unsafe_address = match address {
            IpAddr::V4(value) => {
                value.is_private()
                    || value.is_loopback()
                    || value.is_link_local()
                    || value.is_broadcast()
                    || value.is_unspecified()
                    || value.is_multicast()
            }
            IpAddr::V6(value) => {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_multicast()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
            }
        };
        if unsafe_address {
            return Err(BrokerError::InvalidConfig(
                "OpenAI-compatible endpoint cannot use a private or local address".into(),
            ));
        }
    }
    let normalized_path = if url.path() == "/" {
        "/".to_owned()
    } else {
        url.path().trim_end_matches('/').to_owned()
    };
    url.set_path(&normalized_path);
    let base_url = url.to_string();
    let digest = hex::encode(Sha256::digest(base_url.as_bytes()));
    Ok(OpenAiCompatibleEndpoint {
        id: format!("endpoint_{digest}"),
        base_url,
    })
}

fn openai_compatible_key_account(endpoint_id: &str) -> String {
    format!("provider.openai-compatible.{endpoint_id}.api-key")
}

fn store_openai_compatible_endpoint(
    vault: &SelectedVault,
    endpoint: &OpenAiCompatibleEndpoint,
) -> Result<()> {
    let metadata = serde_json::to_vec(&json!({
        "endpointId": endpoint.id,
        "baseUrl": endpoint.base_url
    }))?;
    vault.inner().store(
        OPENAI_COMPATIBLE_ENDPOINT_ACCOUNT,
        &SecretBytes::new(metadata)?,
    )
}

fn load_openai_compatible_endpoint(
    vault: &SelectedVault,
) -> Result<Option<OpenAiCompatibleEndpoint>> {
    let Some(metadata) = vault.inner().load(OPENAI_COMPATIBLE_ENDPOINT_ACCOUNT)? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(metadata.expose())
        .map_err(|_| BrokerError::Integrity("invalid endpoint metadata".into()))?;
    let base_url = value
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| BrokerError::Integrity("endpoint base URL is missing".into()))?;
    let validated = validate_openai_compatible_endpoint(base_url)?;
    if value.get("endpointId").and_then(Value::as_str) != Some(validated.id.as_str()) {
        return Err(BrokerError::Integrity(
            "endpoint identity digest mismatch".into(),
        ));
    }
    Ok(Some(validated))
}

fn success(result: Value) -> Map<String, Value> {
    object(json!({"ok": true, "result": result}))
}

fn failure(code: &str, message: &str, retryable: bool) -> Map<String, Value> {
    object(json!({
        "ok": false,
        "error": {"code": code, "message": message, "retryable": retryable}
    }))
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn safe_error(error: &BrokerError) -> String {
    match error {
        BrokerError::InvalidEnvelope(_) => {
            "broker rejected a malformed or unauthenticated frame".into()
        }
        BrokerError::Json(_) => "broker rejected malformed JSON".into(),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compatible_endpoint_identity_is_stable_and_normalized() {
        let first = validate_openai_compatible_endpoint("https://API.Example.test/v1/").unwrap();
        let second = validate_openai_compatible_endpoint("https://api.example.test/v1").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.base_url, "https://api.example.test/v1");
        assert!(first.id.starts_with("endpoint_"));
    }

    #[test]
    fn compatible_endpoint_rejects_local_insecure_and_credential_urls() {
        for value in [
            "http://api.example.test/v1",
            "https://localhost/v1",
            "https://127.0.0.1/v1",
            "https://user:secret@example.test/v1",
            "https://example.test/v1?account=chosen-by-renderer",
        ] {
            assert!(
                validate_openai_compatible_endpoint(value).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn runtime_compatible_route_accepts_only_matching_trusted_boundaries() {
        let local = json!({
            "modelId": "openai-compatible:lm/local-model",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "runtimeKind": "lm_studio",
            "privacyRoute": "local"
        });
        assert!(
            validate_runtime_compatible_route("openai-compatible:lm/local-model", &local).is_ok()
        );

        for rejected in [
            json!({
                "modelId": "openai-compatible:lm/different-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "lm_studio",
                "privacyRoute": "local"
            }),
            json!({
                "modelId": "openai-compatible:lm/local-model",
                "baseUrl": "https://models.example.test/v1",
                "runtimeKind": "lm_studio",
                "privacyRoute": "local"
            }),
            json!({
                "modelId": "openai-compatible:lm/local-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "lm_studio",
                "privacyRoute": "self_hosted"
            }),
            json!({
                "modelId": "openai-compatible:lm/local-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "forged_runtime",
                "privacyRoute": "local"
            }),
        ] {
            assert!(validate_runtime_compatible_route(
                "openai-compatible:lm/local-model",
                &rejected
            )
            .is_err());
        }
    }

    #[test]
    fn runtime_vllm_route_requires_https_when_not_loopback() {
        let remote = json!({
            "modelId": "openai-compatible:vllm/model",
            "baseUrl": "https://models.example.test/v1",
            "runtimeKind": "vllm",
            "privacyRoute": "self_hosted"
        });
        assert!(validate_runtime_compatible_route("openai-compatible:vllm/model", &remote).is_ok());

        let insecure_remote = json!({
            "modelId": "openai-compatible:vllm/model",
            "baseUrl": "http://models.example.test/v1",
            "runtimeKind": "vllm",
            "privacyRoute": "self_hosted"
        });
        assert!(validate_runtime_compatible_route(
            "openai-compatible:vllm/model",
            &insecure_remote
        )
        .is_err());
    }

    #[test]
    fn structured_attachments_resolve_only_handle_ids_and_ignore_destination() {
        let params = object(json!({
            "attachments": [{
                "handleId": "018f1e2d-3c4b-7a69-8def-0123456789ab",
                "name": "private.txt",
                "destination": "renderer-chosen-cloud"
            }]
        }));
        assert_eq!(
            requested_attachment_handle_ids(&params).unwrap(),
            vec!["018f1e2d-3c4b-7a69-8def-0123456789ab"]
        );
    }

    #[test]
    fn mismatched_or_duplicate_attachment_handles_are_rejected() {
        let mismatch = object(json!({
            "attachmentHandles": ["018f1e2d-3c4b-7a69-8def-0123456789ab"],
            "attachments": [{"handleId":"018f1e2d-3c4b-7a69-8def-abcdefabcdef"}]
        }));
        assert!(requested_attachment_handle_ids(&mismatch).is_err());

        let duplicate = object(json!({
            "attachmentHandles": [
                "018f1e2d-3c4b-7a69-8def-0123456789ab",
                "018f1e2d-3c4b-7a69-8def-0123456789ab"
            ]
        }));
        assert!(requested_attachment_handle_ids(&duplicate).is_err());
    }

    #[test]
    fn preflight_hashes_opaque_attachment_and_send_rejects_changed_bytes() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("source.txt");
        std::fs::write(&path, "confirmed bytes").unwrap();
        let mut integration = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        integration
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"source.txt","absolutePath":path,"writable":false}})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        let mut payload = object(json!({
            "method": "chat.preflight",
            "params": {
                "attachmentHandles": [handle_id],
                "attachments": [{"handleId": handle_id}]
            }
        }));
        prepare_chat_attachment_preflight(&mut payload, &mut integration).unwrap();
        let bindings = payload["params"]["attachmentBindings"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(bindings[0]["handleId"], handle_id);
        assert_eq!(bindings[0]["byteSize"], 15);
        assert_eq!(
            bindings[0]["sha256"],
            hex::encode(Sha256::digest(b"confirmed bytes"))
        );
        assert!(!Value::Object(payload.clone())
            .to_string()
            .contains(selected.path().to_str().unwrap()));

        std::fs::write(&path, "different bytes").unwrap();
        let changed = integration.stage_attachment(handle_id).unwrap();
        integration.revalidate_staged_attachment(&changed).unwrap();
        let changed_binding = staged_attachment_binding(&changed);
        integration
            .cleanup_staged_attachment(&changed.staging_id)
            .unwrap();
        let send_params = object(json!({
            "outboundIntent": {"attachmentBindings": bindings}
        }));
        assert!(matches!(
            validate_confirmed_attachment_bindings(&send_params, &[changed_binding]),
            Err(BrokerError::Integrity(_))
        ));
    }

    #[test]
    fn nested_runtime_file_identity_becomes_a_path_free_private_descriptor() {
        let staged = cupcake_tool_broker::integration::StagedAttachment {
            staging_id: "018f1e2d-3c4b-7a69-8def-0123456789ab".into(),
            payload_path: PathBuf::from("C:/private/payload.input"),
            manifest_path: PathBuf::from("C:/private/manifest.json"),
            byte_size: 7,
            sha256: "ab".repeat(32),
            display_name: "notes.txt".into(),
            source_handle_id: "018f1e2d-3c4b-7a69-8def-abcdefabcdef".into(),
            broker_grant_id: "grant_private".into(),
        };
        let descriptor = resolved_attachment_descriptor(
            &json!({"file":{"id":"file-7"},"sourceId":"source-9"}),
            &staged,
        )
        .unwrap();
        assert_eq!(descriptor["fileId"], "file-7");
        assert_eq!(descriptor["sourceId"], "source-9");
        assert_eq!(descriptor["brokerGrantId"], "grant_private");
        assert!(!descriptor.to_string().contains("C:/private"));
        assert!(descriptor.get("destination").is_none());
    }
}
