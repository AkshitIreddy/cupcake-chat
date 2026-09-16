use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::audit::redact;
use cupcake_tool_broker::backup_envelope::load_profile_master_key_for_backup;
use cupcake_tool_broker::backup_restore::{
    extract_restore_workspace, read_restore_manifest, resolve_restore_profile_key,
    restore_security_snapshot,
};
use cupcake_tool_broker::framing::{
    read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES,
};
use cupcake_tool_broker::integration::{ArtifactExportRequest, BrokerIntegration};
use cupcake_tool_broker::protocol::{
    decode_transport_secret, uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard,
    RuntimeBrokerRequest, RuntimeRequestType,
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
                                    let restart_runtime_after_response =
                                        envelope.payload.get("method").and_then(Value::as_str)
                                            == Some("content_protection.set");
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
                                    let response = complete_artifact_export_response(
                                        &envelope.payload,
                                        response,
                                        &mut integration,
                                    );
                                    let response = complete_backup_create_response(
                                        &envelope.payload,
                                        response,
                                        runtime.as_mut(),
                                        &mut integration,
                                    );
                                    let response = complete_backup_restore_response(
                                        &envelope.payload,
                                        response,
                                        runtime.as_mut(),
                                        &mut integration,
                                        &data_dir,
                                    );
                                    let response = complete_task_tool_response_with_dispatch(
                                        &envelope.payload,
                                        response,
                                        runtime.as_mut(),
                                        &mut integration,
                                        &mut |request, integration| {
                                            dispatch_task_tool_with_control(
                                                request,
                                                integration,
                                                &incoming_rx,
                                                &mut queued,
                                                &mut output,
                                                &mut outgoing_sequences,
                                                &secret,
                                            )
                                        },
                                    );
                                    if cleanup_migration
                                        && response.get("ok").and_then(Value::as_bool) == Some(true)
                                    {
                                        integration.cleanup_migration_snapshot()?;
                                    }
                                    if restart_runtime_after_response {
                                        if let Some(child) = runtime.as_mut() {
                                            child.shutdown();
                                        }
                                        runtime = None;
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
    Ready,
    Event(Map<String, Value>),
    Done(Result<Map<String, Value>>),
}

enum TaskToolExecutionMessage {
    Done(Map<String, Value>),
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
    let active_is_download =
        payload.get("method").and_then(Value::as_str) == Some("local_models.cupcake.download");
    std::thread::scope(|scope| {
        let (stream_tx, stream_rx) = mpsc::channel();
        let stream_control = control.clone();
        scope.spawn(move || {
            let ready_tx = stream_tx.clone();
            let result = runtime.request_streaming_with_started(
                payload,
                || {
                    if active_is_download {
                        stream_control.open_download_control_window()?;
                    }
                    ready_tx.send(RuntimeStreamMessage::Ready).map_err(|_| {
                        BrokerError::InvalidConfig("desktop stream receiver stopped".into())
                    })
                },
                |event| {
                    stream_tx
                        .send(RuntimeStreamMessage::Event(event))
                        .map_err(|_| {
                            BrokerError::InvalidConfig("desktop stream receiver stopped".into())
                        })
                },
            );
            if let Err(error) = &result {
                eprintln!("{{\"level\":\"error\",\"component\":\"broker\",\"errorType\":\"runtime_stream\",\"message\":\"{}\"}}", error);
            }
            if active_is_download {
                stream_control.close_download_control_window();
            }
            let _ = stream_tx.send(RuntimeStreamMessage::Done(result));
        });

        match stream_rx.recv() {
            Ok(RuntimeStreamMessage::Ready) => {}
            Ok(RuntimeStreamMessage::Done(result)) => return result,
            Ok(RuntimeStreamMessage::Event(_)) => {
                return Err(BrokerError::InvalidEnvelope(
                    "runtime event arrived before request readiness".into(),
                ))
            }
            Err(_) => {
                return Err(BrokerError::InvalidConfig(
                    "runtime stream stopped before request readiness".into(),
                ))
            }
        }

        loop {
            while let Ok(message) = stream_rx.try_recv() {
                match message {
                    RuntimeStreamMessage::Ready => {
                        return Err(BrokerError::InvalidEnvelope(
                            "runtime stream reported readiness twice".into(),
                        ))
                    }
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
                Ok(Ok(envelope))
                    if active_is_download
                        && envelope.message_type == MessageType::Request
                        && is_download_control_request(&envelope.payload) =>
                {
                    let response = match control.request_download_control(
                        envelope.payload.clone(),
                        StdDuration::from_secs(10),
                    ) {
                        Ok(Some(response)) => response,
                        Ok(None) => {
                            queued.push_back(envelope);
                            continue;
                        }
                        Err(error) => failure("DOWNLOAD_CONTROL_FAILED", &safe_error(&error), true),
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
                Ok(Ok(envelope))
                    if active_is_download
                        && envelope.message_type == MessageType::Request
                        && envelope.payload.get("method").and_then(Value::as_str)
                            == Some("local_models.cupcake.download") =>
                {
                    write_outbound(
                        output,
                        outgoing_sequences,
                        secret,
                        envelope.correlation_id,
                        envelope.session_id,
                        envelope.lineage,
                        MessageType::Response,
                        failure(
                            "DOWNLOAD_BUSY",
                            "Another model or runtime download is active; pause or cancel it before starting this one",
                            true,
                        ),
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

fn is_download_control_request(payload: &Map<String, Value>) -> bool {
    matches!(
        payload.get("method").and_then(Value::as_str),
        Some("local_models.cupcake.download.pause" | "local_models.cupcake.download.cancel")
    ) && payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("artifactId"))
        .and_then(Value::as_str)
        .is_some_and(|artifact_id| !artifact_id.trim().is_empty())
}

#[allow(clippy::too_many_arguments)]
fn dispatch_task_tool_with_control<W: Write>(
    request: RuntimeBrokerRequest,
    integration: &mut BrokerIntegration,
    incoming: &mpsc::Receiver<Result<ProtocolEnvelope>>,
    queued: &mut VecDeque<ProtocolEnvelope>,
    output: &mut W,
    outgoing_sequences: &mut HashMap<Uuid, u64>,
    secret: &[u8],
) -> Map<String, Value> {
    let invocation_id = request
        .payload
        .get("intent")
        .and_then(Value::as_object)
        .and_then(|intent| intent.get("invocation_id"))
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    let Some(invocation_id) = invocation_id else {
        return failure(
            "TASK_TOOL_CONTINUATION_FAILED",
            "The task tool invocation identity is invalid",
            false,
        );
    };
    let cancellation = integration.python_cancellation();
    let controlled = std::thread::scope(|scope| -> Result<Map<String, Value>> {
        let (execution_tx, execution_rx) = mpsc::channel();
        scope.spawn(move || {
            let response = integration.dispatch(request);
            let _ = execution_tx.send(TaskToolExecutionMessage::Done(response));
        });
        let mut cancel_pending = false;

        loop {
            if let Ok(TaskToolExecutionMessage::Done(response)) = execution_rx.try_recv() {
                return Ok(response);
            }
            if cancel_pending && cancellation.cancel(&invocation_id.to_string()).is_ok() {
                cancel_pending = false;
            }

            match incoming.recv_timeout(StdDuration::from_millis(10)) {
                Ok(Ok(envelope)) if envelope.message_type == MessageType::Cancel => {
                    let target = envelope
                        .payload
                        .get("targetId")
                        .and_then(Value::as_str)
                        .and_then(|value| Uuid::parse_str(value).ok());
                    if target == Some(invocation_id) {
                        cancel_pending = cancellation.cancel(&invocation_id.to_string()).is_err();
                        let response = success(json!({
                            "targetId": invocation_id,
                            "cancelRequested": true
                        }));
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
                    } else {
                        queued.push_back(envelope);
                    }
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
    });
    controlled
        .unwrap_or_else(|error| failure("TASK_TOOL_CONTINUATION_FAILED", &safe_error(&error), true))
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
        "broker.permission_mode.get" => success(json!({
            "mode": integration.permission_mode()
        })),
        "broker.permission_mode.set" => {
            let mode = payload
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("mode"))
                .and_then(Value::as_str);
            match mode {
                Some(mode) => match integration.set_permission_mode(mode) {
                    Ok(value) => success(value),
                    Err(error) => failure("PERMISSION_MODE_FAILED", &safe_error(&error), false),
                },
                None => failure("INVALID_REQUEST", "Permission mode is required", false),
            }
        }
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

fn hydrate_named_compatible_providers(
    runtime: &mut Option<RuntimeChild>,
    vault: &SelectedVault,
) -> Result<()> {
    for provider in ["groq", "openrouter", "cloudflare"] {
        let Some(endpoint) = load_named_compatible_endpoint(vault, provider)? else {
            continue;
        };
        let Some(secret) = vault.inner().load(&provider_account(provider))? else {
            continue;
        };
        let mut cached_models = load_named_compatible_catalog(vault, provider)?;
        if cached_models.is_empty() {
            let Some(model_id) = endpoint.model_id.as_deref() else {
                continue;
            };
            cached_models.push(NamedCompatibleCatalogModel {
                model_id: model_id.to_owned(),
                display_name: if provider == "openrouter" && model_id == "openrouter/free" {
                    "Variable free-model router".to_owned()
                } else {
                    model_id.to_owned()
                },
            });
        }
        for model in cached_models {
            if !named_compatible_model_allowed(provider, &model.model_id) {
                return Err(BrokerError::Integrity(
                    "saved provider model violates the account-chat policy".into(),
                ));
            }
            let options = object(json!({
                "baseUrl": endpoint.base_url,
                "endpointId": endpoint.id,
                "modelId": model.model_id,
                "displayName": format!("{} · {}", provider_label(provider), model.display_name),
                "trustedHydration": true
            }));
            let _ = configure_provider("openai-compatible", secret.expose(), &options, runtime)?;
        }
    }
    Ok(())
}

fn dispatch_secure_request(
    payload: &mut Map<String, Value>,
    runtime: &mut Option<RuntimeChild>,
    vault: &SelectedVault,
) -> Result<Option<OutboundMessages>> {
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return Ok(None);
    };
    if matches!(
        method,
        "app.bootstrap"
            | "models.list"
            | "providers.status"
            | "conversations.participants.list"
            | "groups.turn.preflight"
            | "groups.turn.send"
    ) {
        hydrate_named_compatible_providers(runtime, vault)?;
        // Group readiness and execution do not pass through chat.send. Restore
        // saved native credentials before either path inspects the adapters.
        // Trusted hydration performs no provider request and exposes no secret
        // to the renderer, including while the workspace is offline.
        for provider in provider_names()
            .iter()
            .filter(|p| !is_named_compatible_provider(p))
        {
            if let Some(secret) = vault.inner().load(&provider_account(provider))? {
                let options = if *provider == "nvidia-nim" {
                    object(json!({
                        "trustedHydration": true,
                        "catalogModels": load_nvidia_nim_catalog(vault)?
                    }))
                } else {
                    object(json!({"trustedHydration":true}))
                };
                configure_provider(provider, secret.expose(), &options, runtime)?;
            }
        }
    }
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
                .filter(|value| *value == "nvidia-nim" || is_named_compatible_provider(value))
                .ok_or_else(|| BrokerError::InvalidConfig("unsupported catalog provider".into()))?;
            let secret = vault
                .inner()
                .load(&provider_account(provider))?
                .ok_or_else(|| {
                    BrokerError::PermissionDenied(format!("{provider} is not connected"))
                })?;
            let mut options = Map::new();
            if params.get("force").and_then(Value::as_bool) == Some(true) {
                options.insert("forceCatalogRefresh".into(), Value::Bool(true));
            }
            let endpoint = if is_named_compatible_provider(provider) {
                let endpoint =
                    load_named_compatible_endpoint(vault, provider)?.ok_or_else(|| {
                        BrokerError::PermissionDenied(format!("{provider} is not connected"))
                    })?;
                let model_id = endpoint.model_id.as_deref().ok_or_else(|| {
                    BrokerError::Integrity("saved provider selection is missing".into())
                })?;
                options.insert("baseUrl".into(), Value::String(endpoint.base_url.clone()));
                options.insert("endpointId".into(), Value::String(endpoint.id.clone()));
                options.insert("modelId".into(), Value::String(model_id.to_owned()));
                options.insert("allowSelectedReplacement".into(), Value::Bool(true));
                if provider == "cloudflare" {
                    let account_id = endpoint
                        .base_url
                        .strip_prefix("https://api.cloudflare.com/client/v4/accounts/")
                        .and_then(|value| value.strip_suffix("/ai/v1"))
                        .ok_or_else(|| {
                            BrokerError::Integrity("saved Cloudflare endpoint is invalid".into())
                        })?;
                    options.insert("accountId".into(), Value::String(account_id.to_owned()));
                }
                Some(endpoint)
            } else {
                None
            };
            let result = configure_provider(provider, secret.expose(), &options, runtime)?;
            if let Some(mut endpoint) = endpoint {
                let catalog = named_compatible_catalog_from_result(provider, &result)?;
                if endpoint
                    .model_id
                    .as_deref()
                    .is_none_or(|selected| !catalog.iter().any(|model| model.model_id == selected))
                {
                    let preferred = named_compatible_default_model(provider);
                    endpoint.model_id = catalog
                        .iter()
                        .find(|model| model.model_id == preferred)
                        .or_else(|| catalog.first())
                        .map(|model| model.model_id.clone());
                }
                store_named_compatible_endpoint(vault, provider, &endpoint, &catalog)?;
            } else if provider == "nvidia-nim" {
                store_nvidia_nim_catalog(vault, &nvidia_nim_catalog_from_result(&result)?)?;
            }
            Ok(Some(vec![(MessageType::Response, success(result))]))
        }
        "providers.test" | "providers.connect" => {
            let persist = method == "providers.connect";
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
            // This method is reachable only through the authenticated host-to-broker
            // pipe. The Tauri host exposes it as a dedicated command instead of the
            // generic runtime facade, so the secret is removed from the request map
            // immediately and never returned to the webview.
            let raw_secret = params
                .remove("secret")
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| BrokerError::InvalidConfig("provider secret is required".into()))?;
            let secret = SecretBytes::new(raw_secret.into_bytes())?;

            let compatible_preset = is_named_compatible_provider(&provider);
            let endpoint = if provider == "openai-compatible" {
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
                params.insert("endpointId".into(), Value::String(endpoint.id.clone()));
                Some(endpoint)
            } else if compatible_preset {
                let endpoint = named_compatible_endpoint(&provider, params)?;
                let model = params
                    .get("modelId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        BrokerError::InvalidConfig(
                            "Named provider preset requires an explicit model".into(),
                        )
                    })?;
                if !named_compatible_model_allowed(&provider, model) {
                    return Err(BrokerError::PermissionDenied(
                        "Named provider presets accept only supported account-discovered routes"
                            .into(),
                    ));
                }
                params.insert("baseUrl".into(), Value::String(endpoint.base_url.clone()));
                params.insert("endpointId".into(), Value::String(endpoint.id.clone()));
                Some(endpoint)
            } else {
                None
            };
            params.insert("validateOnly".into(), Value::Bool(!persist));

            // Validate first. A wrong key must never become a persisted, apparently
            // configured credential.
            let runtime_response =
                configure_provider_response(&provider, secret.expose(), params, runtime)?;
            if runtime_response.get("ok").and_then(Value::as_bool) != Some(true) {
                let diagnostic =
                    redact(runtime_response.get("error").cloned().unwrap_or_else(|| {
                        json!({
                            "code": "provider_unavailable",
                            "message": "The provider rejected the connection test.",
                            "retryable": false
                        })
                    }));
                return Ok(Some(vec![(
                    MessageType::Response,
                    success(json!({
                        "provider": provider,
                        "tested": false,
                        "configured": false,
                        "persistent": false,
                        "diagnostic": diagnostic
                    })),
                )]));
            }
            let runtime_result = runtime_response
                .get("result")
                .cloned()
                .unwrap_or(Value::Null);
            let onboarding_state = runtime_result
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let tested = matches!(onboarding_state, "ready" | "degraded");
            if !tested {
                let mut response = runtime_result.as_object().cloned().unwrap_or_default();
                response.insert("tested".into(), Value::Bool(false));
                response.insert("configured".into(), Value::Bool(false));
                response.insert("persistent".into(), Value::Bool(false));
                return Ok(Some(vec![(
                    MessageType::Response,
                    success(Value::Object(response)),
                )]));
            }
            if !persist {
                let mut response = runtime_result.as_object().cloned().unwrap_or_default();
                response.insert("tested".into(), Value::Bool(true));
                response.insert("configured".into(), Value::Bool(false));
                response.insert("persistent".into(), Value::Bool(false));
                return Ok(Some(vec![(
                    MessageType::Response,
                    success(Value::Object(response)),
                )]));
            }

            let endpoint_id = if provider == "openai-compatible" {
                let endpoint = endpoint.ok_or_else(|| {
                    BrokerError::InvalidConfig("validated endpoint is missing".into())
                })?;
                vault
                    .inner()
                    .store(&openai_compatible_key_account(&endpoint.id), &secret)?;
                store_openai_compatible_endpoint(vault, &endpoint)?;
                Some(endpoint.id)
            } else if compatible_preset {
                let endpoint = endpoint.ok_or_else(|| {
                    BrokerError::InvalidConfig("validated preset endpoint is missing".into())
                })?;
                vault.inner().store(&provider_account(&provider), &secret)?;
                let catalog = named_compatible_catalog_from_result(&provider, &runtime_result)?;
                store_named_compatible_endpoint(vault, &provider, &endpoint, &catalog)?;
                Some(endpoint.id)
            } else {
                vault.inner().store(&provider_account(&provider), &secret)?;
                if provider == "nvidia-nim" {
                    store_nvidia_nim_catalog(
                        vault,
                        &nvidia_nim_catalog_from_result(&runtime_result)?,
                    )?;
                }
                None
            };
            let mut response = runtime_result.as_object().cloned().unwrap_or_default();
            response.insert("provider".into(), Value::String(provider));
            response.insert("tested".into(), Value::Bool(true));
            response.insert("configured".into(), Value::Bool(true));
            response.insert(
                "persistent".into(),
                Value::Bool(vault.inner().is_persistent()),
            );
            response.insert(
                "endpointId".into(),
                endpoint_id.map(Value::String).unwrap_or(Value::Null),
            );
            Ok(Some(vec![(
                MessageType::Response,
                success(Value::Object(response)),
            )]))
        }
        "providers.disconnect" => {
            let provider = payload
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("provider"))
                .and_then(Value::as_str)
                .filter(|value| provider_names().contains(value) || *value == "openai-compatible")
                .ok_or_else(|| BrokerError::InvalidConfig("unsupported provider".into()))?;
            let runtime_response = disconnect_provider_response(provider, runtime);
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
            } else if is_named_compatible_provider(provider) {
                let removed = vault.inner().delete(&provider_account(provider))?;
                vault
                    .inner()
                    .delete(&named_compatible_endpoint_account(provider))?;
                removed
            } else {
                let removed = vault.inner().delete(&provider_account(provider))?;
                if provider == "nvidia-nim" {
                    vault.inner().delete(NVIDIA_NIM_CATALOG_ACCOUNT)?;
                }
                removed
            };
            let runtime_disconnected = match runtime_response {
                Ok(response) if response.get("ok").and_then(Value::as_bool) == Some(true) => true,
                Ok(_) | Err(_) => {
                    // A failed disconnect must not leave a credential-bearing provider
                    // configuration alive in the Python child. Dropping the supervised
                    // child clears that memory before a future clean restart.
                    *runtime = None;
                    false
                }
            };
            Ok(Some(vec![(
                MessageType::Response,
                success(json!({
                    "provider": provider,
                    "configured": false,
                    "persistent": vault.inner().is_persistent(),
                    "removed": removed,
                    "runtimeDisconnected": runtime_disconnected
                })),
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
        let (selected_endpoint, selected_model) = model_id
            .strip_prefix("openai-compatible:")
            .and_then(|value| value.split_once('/'))
            .ok_or_else(|| {
                BrokerError::InvalidConfig("OpenAI-compatible model identity is invalid".into())
            })?;
        let (endpoint, secret) = if is_named_compatible_provider(selected_endpoint) {
            if !named_compatible_model_allowed(selected_endpoint, selected_model) {
                return Err(BrokerError::PermissionDenied(
                    "Named provider presets accept only supported account-discovered routes".into(),
                ));
            }
            let endpoint =
                load_named_compatible_endpoint(vault, selected_endpoint)?.ok_or_else(|| {
                    BrokerError::PermissionDenied(format!("{selected_endpoint} is not connected"))
                })?;
            let cached_models = load_named_compatible_catalog(vault, selected_endpoint)?;
            let selected_is_saved = named_compatible_model_was_saved(
                selected_model,
                endpoint.model_id.as_deref(),
                &cached_models,
            );
            if !selected_is_saved {
                return Err(BrokerError::PermissionDenied(
                    "Named provider model was not discovered for this connected account".into(),
                ));
            }
            let secret = vault
                .inner()
                .load(&provider_account(selected_endpoint))?
                .ok_or_else(|| {
                    BrokerError::PermissionDenied(format!("{selected_endpoint} is not connected"))
                })?;
            (endpoint, secret)
        } else {
            let endpoint = load_openai_compatible_endpoint(vault)?.ok_or_else(|| {
                BrokerError::PermissionDenied("OpenAI-compatible endpoint is not connected".into())
            })?;
            if selected_endpoint != endpoint.id {
                return Err(BrokerError::PermissionDenied(
                    "OpenAI-compatible model belongs to a different endpoint".into(),
                ));
            }
            let secret = vault
                .inner()
                .load(&openai_compatible_key_account(&endpoint.id))?
                .ok_or_else(|| {
                    BrokerError::PermissionDenied(
                        "OpenAI-compatible endpoint is not connected".into(),
                    )
                })?;
            (endpoint, secret)
        };
        let options = object(json!({
            "baseUrl": endpoint.base_url,
            "endpointId": endpoint.id,
            "modelId": selected_model,
            "displayName": selected_model,
            "trustedHydration": true
        }));
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
    let options = if provider == "nvidia-nim" {
        let selected_model = model_id.strip_prefix("nvidia-nim:").ok_or_else(|| {
            BrokerError::InvalidConfig("NVIDIA NIM model identity is invalid".into())
        })?;
        object(json!({
            "trustedHydration": true,
            "modelId": selected_model
        }))
    } else {
        object(json!({"trustedHydration": true}))
    };
    let _ = configure_provider(provider, secret.expose(), &options, runtime)?;
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
        "cupcake_llama_cpp" => {
            if privacy_route != "local" || !loopback || !matches!(url.scheme(), "http" | "https") {
                return Err(BrokerError::PermissionDenied(
                    "Cupcake Local must use a loopback HTTP(S) origin".into(),
                ));
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
    let response = configure_provider_response(provider, secret, options, runtime)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let diagnostic = redact(response.get("error").cloned().unwrap_or(Value::Null));
        let code = diagnostic
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("PROVIDER_TEST_FAILED");
        return Err(BrokerError::PermissionDenied(format!(
            "provider connection test failed ({code})"
        )));
    }
    let result = response.get("result").cloned().unwrap_or(Value::Null);
    let state = result
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    if !matches!(state, "ready" | "degraded") {
        let code = result
            .get("diagnostic")
            .and_then(|diagnostic| diagnostic.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("provider_test_failed");
        return Err(BrokerError::PermissionDenied(format!(
            "provider connection test failed ({code})"
        )));
    }
    Ok(result)
}

fn configure_provider_response(
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
    for key in ["endpointId", "modelId", "displayName", "accountId"] {
        if let Some(value) = options.get(key).filter(|value| value.is_string()) {
            params.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = options
        .get("catalogModels")
        .filter(|value| value.is_array())
    {
        params.insert("catalogModels".into(), value.clone());
    }
    if let Some(value) = options
        .get("forceCatalogRefresh")
        .filter(|value| value.is_boolean())
    {
        params.insert("forceCatalogRefresh".into(), value.clone());
    }
    if let Some(value) = options
        .get("validateOnly")
        .filter(|value| value.is_boolean())
    {
        params.insert("validateOnly".into(), value.clone());
    }
    if let Some(value) = options
        .get("allowSelectedReplacement")
        .filter(|value| value.is_boolean())
    {
        params.insert("allowSelectedReplacement".into(), value.clone());
    }
    if let Some(value) = options
        .get("trustedHydration")
        .filter(|value| value.is_boolean())
    {
        params.insert("trustedHydration".into(), value.clone());
    }
    let request = object(json!({"method": "providers.configure", "params": params}));
    let messages = ensure_runtime(runtime)?.request(&request)?;
    let response = messages.last().map(|(_, payload)| payload).ok_or_else(|| {
        BrokerError::InvalidEnvelope("runtime provider response is missing".into())
    })?;
    Ok(Value::Object(response.clone()))
}

fn disconnect_provider_response(
    provider: &str,
    runtime: &mut Option<RuntimeChild>,
) -> Result<Value> {
    let request = object(json!({
        "method": "providers.disconnect",
        "params": {"provider": provider}
    }));
    let messages = ensure_runtime(runtime)?.request(&request)?;
    let response = messages.last().map(|(_, payload)| payload).ok_or_else(|| {
        BrokerError::InvalidEnvelope("runtime provider disconnect response is missing".into())
    })?;
    Ok(Value::Object(response.clone()))
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
        "groq",
        "openrouter",
        "cloudflare",
    ]
}

fn is_named_compatible_provider(provider: &str) -> bool {
    matches!(provider, "groq" | "openrouter" | "cloudflare")
}

fn named_compatible_model_allowed(provider: &str, model: &str) -> bool {
    match provider {
        // The runtime accepts only models returned by this account's bounded
        // `/models` response. Keep this string-only restore guard broad enough
        // for Groq's changing chat catalog while excluding its utility routes.
        "groq" => {
            let normalized = model.trim().to_ascii_lowercase();
            !normalized.is_empty()
                && normalized.len() <= 256
                && !["guard", "safeguard", "whisper", "orpheus", "speech", "tts"]
                    .iter()
                    .any(|marker| normalized.contains(marker))
        }
        "openrouter" => model == "openrouter/free" || model.ends_with(":free"),
        "cloudflare" => model == "@cf/meta/llama-3.1-8b-instruct-fp8",
        _ => false,
    }
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "groq" => "Groq",
        "openrouter" => "OpenRouter",
        "cloudflare" => "Cloudflare Workers AI",
        _ => provider,
    }
}

fn named_compatible_default_model(provider: &str) -> &str {
    match provider {
        "groq" => "openai/gpt-oss-20b",
        "openrouter" => "openrouter/free",
        "cloudflare" => "@cf/meta/llama-3.1-8b-instruct-fp8",
        _ => "",
    }
}

const MAX_SAVED_PROVIDER_MODELS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
struct NamedCompatibleCatalogModel {
    model_id: String,
    display_name: String,
}

fn named_compatible_model_was_saved(
    selected_model: &str,
    legacy_selected_model: Option<&str>,
    cached_models: &[NamedCompatibleCatalogModel],
) -> bool {
    if cached_models.is_empty() {
        return legacy_selected_model == Some(selected_model);
    }
    cached_models
        .iter()
        .any(|model| model.model_id == selected_model)
}

fn named_compatible_catalog_from_result(
    provider: &str,
    result: &Value,
) -> Result<Vec<NamedCompatibleCatalogModel>> {
    let models = result
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BrokerError::Integrity("provider result omitted its model catalog".into())
        })?;
    if models.len() > MAX_SAVED_PROVIDER_MODELS {
        return Err(BrokerError::Integrity(
            "provider result exceeded the saved catalog limit".into(),
        ));
    }
    let mut saved = Vec::with_capacity(models.len());
    for value in models {
        let object = value.as_object().ok_or_else(|| {
            BrokerError::Integrity("provider result contained invalid model metadata".into())
        })?;
        let model_id = object
            .get("model")
            .or_else(|| object.get("id"))
            .and_then(Value::as_str)
            .filter(|model| named_compatible_model_allowed(provider, model))
            .ok_or_else(|| {
                BrokerError::Integrity("provider result contained a disallowed model".into())
            })?;
        let display_name = object
            .get("display_name")
            .or_else(|| object.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or(model_id)
            .trim();
        if display_name.is_empty() || display_name.len() > 256 {
            return Err(BrokerError::Integrity(
                "provider result contained an invalid model label".into(),
            ));
        }
        saved.push(NamedCompatibleCatalogModel {
            model_id: model_id.to_owned(),
            display_name: display_name.to_owned(),
        });
    }
    Ok(saved)
}

fn provider_account(provider: &str) -> String {
    format!("provider.{provider}.api-key")
}

const NVIDIA_NIM_CATALOG_ACCOUNT: &str = "provider.nvidia-nim.catalog";

fn valid_saved_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'@' | b'.' | b'_' | b':' | b'+' | b'/' | b'-')
        })
}

fn nvidia_nim_catalog_from_result(result: &Value) -> Result<Vec<String>> {
    let models = result
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| BrokerError::Integrity("NVIDIA result omitted its model catalog".into()))?;
    if models.len() > MAX_SAVED_PROVIDER_MODELS {
        return Err(BrokerError::Integrity(
            "NVIDIA result exceeded the saved catalog limit".into(),
        ));
    }
    let mut ids = Vec::with_capacity(models.len());
    for model in models {
        let object = model.as_object().ok_or_else(|| {
            BrokerError::Integrity("NVIDIA result contained invalid model metadata".into())
        })?;
        let model_id = object
            .get("model")
            .or_else(|| object.get("id"))
            .and_then(Value::as_str)
            .filter(|value| valid_saved_model_id(value))
            .ok_or_else(|| {
                BrokerError::Integrity("NVIDIA result contained an invalid model id".into())
            })?;
        ids.push(model_id.to_owned());
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn store_nvidia_nim_catalog(vault: &SelectedVault, models: &[String]) -> Result<()> {
    if models.len() > MAX_SAVED_PROVIDER_MODELS
        || models.iter().any(|model| !valid_saved_model_id(model))
    {
        return Err(BrokerError::Integrity(
            "NVIDIA catalog cannot be persisted safely".into(),
        ));
    }
    let metadata = serde_json::to_vec(&json!({"models": models}))?;
    vault
        .inner()
        .store(NVIDIA_NIM_CATALOG_ACCOUNT, &SecretBytes::new(metadata)?)
}

fn load_nvidia_nim_catalog(vault: &SelectedVault) -> Result<Vec<String>> {
    let Some(metadata) = vault.inner().load(NVIDIA_NIM_CATALOG_ACCOUNT)? else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_slice(metadata.expose())
        .map_err(|_| BrokerError::Integrity("invalid saved NVIDIA catalog".into()))?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| BrokerError::Integrity("invalid saved NVIDIA catalog".into()))?;
    if models.len() > MAX_SAVED_PROVIDER_MODELS {
        return Err(BrokerError::Integrity(
            "saved NVIDIA catalog exceeds its model limit".into(),
        ));
    }
    models
        .iter()
        .map(|model| {
            model
                .as_str()
                .filter(|value| valid_saved_model_id(value))
                .map(str::to_owned)
                .ok_or_else(|| BrokerError::Integrity("invalid saved NVIDIA model id".into()))
        })
        .collect()
}

const OPENAI_COMPATIBLE_ENDPOINT_ACCOUNT: &str = "provider.openai-compatible.selected-endpoint";

#[derive(Debug)]
struct OpenAiCompatibleEndpoint {
    id: String,
    base_url: String,
    model_id: Option<String>,
}

fn named_compatible_endpoint(
    provider: &str,
    params: &Map<String, Value>,
) -> Result<OpenAiCompatibleEndpoint> {
    let base_url = match provider {
        "groq" => "https://api.groq.com/openai/v1".to_owned(),
        "openrouter" => "https://openrouter.ai/api/v1".to_owned(),
        "cloudflare" => {
            let account_id = params
                .get("accountId")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    BrokerError::InvalidConfig(
                        "Cloudflare Account ID must be a 32-character hexadecimal value".into(),
                    )
                })?;
            format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1")
        }
        _ => {
            return Err(BrokerError::InvalidConfig(
                "unknown named compatible provider".into(),
            ))
        }
    };
    if let Some(supplied) = params.get("baseUrl").and_then(Value::as_str) {
        if supplied.trim_end_matches('/') != base_url {
            return Err(BrokerError::InvalidConfig(
                "Named provider endpoint cannot be changed".into(),
            ));
        }
    }
    Ok(OpenAiCompatibleEndpoint {
        id: provider.to_owned(),
        base_url,
        model_id: params
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn named_compatible_endpoint_account(provider: &str) -> String {
    format!("provider.{provider}.endpoint")
}

fn store_named_compatible_endpoint(
    vault: &SelectedVault,
    provider: &str,
    endpoint: &OpenAiCompatibleEndpoint,
    models: &[NamedCompatibleCatalogModel],
) -> Result<()> {
    let metadata = serde_json::to_vec(&json!({
        "endpointId": endpoint.id,
        "baseUrl": endpoint.base_url,
        "modelId": endpoint.model_id,
        "models": models.iter().map(|model| json!({
            "modelId": model.model_id,
            "displayName": model.display_name
        })).collect::<Vec<_>>()
    }))?;
    vault.inner().store(
        &named_compatible_endpoint_account(provider),
        &SecretBytes::new(metadata)?,
    )
}

fn load_named_compatible_catalog(
    vault: &SelectedVault,
    provider: &str,
) -> Result<Vec<NamedCompatibleCatalogModel>> {
    let Some(metadata) = vault
        .inner()
        .load(&named_compatible_endpoint_account(provider))?
    else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_slice(metadata.expose())
        .map_err(|_| BrokerError::Integrity("invalid provider endpoint metadata".into()))?;
    let Some(models) = value.get("models") else {
        // Metadata written before catalog snapshots were introduced contains
        // only the selected model and is migrated by the next explicit refresh.
        return Ok(Vec::new());
    };
    let models = models
        .as_array()
        .ok_or_else(|| BrokerError::Integrity("invalid saved provider catalog".into()))?;
    if models.len() > MAX_SAVED_PROVIDER_MODELS {
        return Err(BrokerError::Integrity(
            "saved provider catalog exceeds its model limit".into(),
        ));
    }
    let mut result = Vec::with_capacity(models.len());
    for model in models {
        let object = model
            .as_object()
            .ok_or_else(|| BrokerError::Integrity("invalid saved provider model".into()))?;
        let model_id = object
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|value| named_compatible_model_allowed(provider, value))
            .ok_or_else(|| BrokerError::Integrity("invalid saved provider model id".into()))?;
        let display_name = object
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 256)
            .ok_or_else(|| BrokerError::Integrity("invalid saved provider model label".into()))?;
        result.push(NamedCompatibleCatalogModel {
            model_id: model_id.to_owned(),
            display_name: display_name.to_owned(),
        });
    }
    Ok(result)
}

fn load_named_compatible_endpoint(
    vault: &SelectedVault,
    provider: &str,
) -> Result<Option<OpenAiCompatibleEndpoint>> {
    if !is_named_compatible_provider(provider) {
        return Err(BrokerError::InvalidConfig(
            "unknown named compatible provider".into(),
        ));
    }
    let Some(metadata) = vault
        .inner()
        .load(&named_compatible_endpoint_account(provider))?
    else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(metadata.expose())
        .map_err(|_| BrokerError::Integrity("invalid provider endpoint metadata".into()))?;
    let base_url = value
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| BrokerError::Integrity("provider endpoint URL is missing".into()))?;
    let mut params = Map::new();
    params.insert("baseUrl".into(), Value::String(base_url.to_owned()));
    if provider == "cloudflare" {
        let account_id = base_url
            .strip_prefix("https://api.cloudflare.com/client/v4/accounts/")
            .and_then(|value| value.strip_suffix("/ai/v1"))
            .ok_or_else(|| BrokerError::Integrity("invalid Cloudflare endpoint metadata".into()))?;
        params.insert("accountId".into(), Value::String(account_id.to_owned()));
    }
    if let Some(model_id) = value.get("modelId").and_then(Value::as_str) {
        params.insert("modelId".into(), Value::String(model_id.to_owned()));
    }
    let validated = named_compatible_endpoint(provider, &params)?;
    if value.get("endpointId").and_then(Value::as_str) != Some(validated.id.as_str()) {
        return Err(BrokerError::Integrity(
            "provider endpoint identity mismatch".into(),
        ));
    }
    Ok(Some(validated))
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
        model_id: None,
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

#[cfg(test)]
fn complete_task_tool_response(
    desktop_request: &Map<String, Value>,
    runtime_response: Map<String, Value>,
    runtime: Option<&mut RuntimeChild>,
    integration: &mut BrokerIntegration,
) -> Map<String, Value> {
    complete_task_tool_response_with_dispatch(
        desktop_request,
        runtime_response,
        runtime,
        integration,
        &mut |request, integration| integration.dispatch(request),
    )
}

fn complete_task_tool_response_with_dispatch<F>(
    desktop_request: &Map<String, Value>,
    mut runtime_response: Map<String, Value>,
    runtime: Option<&mut RuntimeChild>,
    integration: &mut BrokerIntegration,
    execute_dispatch: &mut F,
) -> Map<String, Value>
where
    F: FnMut(RuntimeBrokerRequest, &mut BrokerIntegration) -> Map<String, Value>,
{
    let method = desktop_request.get("method").and_then(Value::as_str);
    if !matches!(
        method,
        Some("tasks.create" | "tasks.execute" | "tasks.resume")
    ) || runtime_response.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return runtime_response;
    }
    let Some(result) = runtime_response
        .get_mut("result")
        .and_then(Value::as_object_mut)
    else {
        return runtime_response;
    };
    let Some(continuation) = result
        .remove("continuation")
        .and_then(|value| value.as_object().cloned())
    else {
        return runtime_response;
    };
    let mut complete = || -> Result<(Value, Value)> {
        let request_value = continuation
            .get("request")
            .cloned()
            .ok_or_else(|| BrokerError::Integrity("task tool request is missing".into()))?;
        let request: RuntimeBrokerRequest = serde_json::from_value(request_value)?;
        request.validate()?;
        if request.request_type != RuntimeRequestType::ToolPreflight {
            return Err(BrokerError::Integrity(
                "task continuation is not a tool preflight".into(),
            ));
        }
        let intent = request
            .payload
            .get("intent")
            .cloned()
            .ok_or_else(|| BrokerError::Integrity("task tool intent is missing".into()))?;
        let parameters = desktop_request
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let supplied_preflight = parameters.get("brokerPreflight").cloned();
        let supplied_approval = parameters.get("brokerApproval").cloned();

        let preflight = if let (Some(preflight), Some(approval)) =
            (supplied_preflight, supplied_approval)
        {
            let verify = RuntimeBrokerRequest {
                protocol_version: PROTOCOL_VERSION,
                request_type: RuntimeRequestType::ToolApprovalVerify,
                payload: object(json!({"preflight": preflight, "approval": approval})),
            };
            let verified = integration.dispatch(verify);
            if verified.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(BrokerError::PermissionDenied(
                    "task tool approval was rejected".into(),
                ));
            }
            parameters
                .get("brokerPreflight")
                .cloned()
                .ok_or_else(|| BrokerError::Integrity("approved preflight is missing".into()))?
        } else {
            let preflight_response = integration.dispatch(request);
            if preflight_response.get("ok").and_then(Value::as_bool) != Some(true) {
                return Ok((
                    json!({
                        "status": "failed",
                        "invocation_id": task_invocation_id(&continuation)?,
                        "error_message": "The broker rejected the task tool preflight.",
                        "output": {"broker": preflight_response}
                    }),
                    Value::Null,
                ));
            }
            let broker_result = preflight_response
                .get("result")
                .and_then(Value::as_object)
                .ok_or_else(|| BrokerError::Integrity("tool preflight result is missing".into()))?;
            let preflight = broker_result
                .get("preflight")
                .cloned()
                .ok_or_else(|| BrokerError::Integrity("tool preflight is missing".into()))?;
            let decision = preflight
                .get("decision")
                .and_then(Value::as_str)
                .unwrap_or("deny");
            if decision == "ask"
                || preflight
                    .get("requires_fresh_approval")
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                return Ok((
                    Value::Null,
                    json!({
                        "status": "approval_required",
                        "invocationId": task_invocation_id(&continuation)?,
                        "preflight": preflight,
                        "approvalChallenge": broker_result.get("approvalChallenge")
                    }),
                ));
            }
            if decision != "allow" {
                return Ok((
                    json!({
                        "status": "denied",
                        "invocation_id": task_invocation_id(&continuation)?,
                        "error_message": "The broker policy denied this sandbox task.",
                        "output": {"preflight": preflight}
                    }),
                    Value::Null,
                ));
            }
            if method == Some("tasks.create") {
                return Ok((
                    Value::Null,
                    json!({
                        "status": "ready",
                        "invocationId": task_invocation_id(&continuation)?,
                        "preflight": preflight
                    }),
                ));
            }
            preflight
        };

        let execute = RuntimeBrokerRequest {
            protocol_version: PROTOCOL_VERSION,
            request_type: RuntimeRequestType::ToolExecute,
            payload: object(json!({
                "intent": intent,
                "preflight": preflight,
                "approval": null
            })),
        };
        let execution = execute_dispatch(execute, integration);
        let broker_result = if execution.get("ok").and_then(Value::as_bool) == Some(true) {
            execution.get("result").cloned().unwrap_or_else(|| {
                json!({
                    "status": "failed",
                    "invocation_id": task_invocation_id(&continuation).unwrap_or_default(),
                    "error_message": "The broker returned no task tool result.",
                    "output": {}
                })
            })
        } else {
            json!({
                "status": "failed",
                "invocation_id": task_invocation_id(&continuation)?,
                "error_message": "The broker could not execute the sandbox task.",
                "output": {"broker": execution}
            })
        };
        Ok((broker_result, Value::Null))
    };

    let (broker_result, approval) = match complete() {
        Ok(value) => value,
        Err(_) => {
            return failure(
                "TASK_TOOL_CONTINUATION_FAILED",
                "The task tool continuation could not be verified",
                true,
            )
        }
    };
    if !approval.is_null() {
        if let Some(result) = runtime_response
            .get_mut("result")
            .and_then(Value::as_object_mut)
        {
            result.insert("execution".into(), approval);
        }
        return runtime_response;
    }

    let Some(runtime) = runtime else {
        return failure(
            "TASK_TOOL_CONTINUATION_FAILED",
            "The packaged runtime is unavailable for task completion",
            true,
        );
    };
    let mut completion = match continuation
        .get("completion")
        .and_then(Value::as_object)
        .cloned()
    {
        Some(value) => value,
        None => {
            return failure(
                "TASK_TOOL_CONTINUATION_FAILED",
                "The task completion binding is missing",
                false,
            )
        }
    };
    completion.insert("brokerResult".into(), broker_result);
    let private_request = object(json!({
        "method": "tasks.tool.complete.private",
        "params": completion
    }));
    let private_response = match runtime.request_streaming(&private_request, |_| Ok(())) {
        Ok(response) if response.get("ok").and_then(Value::as_bool) == Some(true) => response,
        _ => {
            return failure(
                "TASK_TOOL_CONTINUATION_FAILED",
                "The runtime rejected the broker task result",
                true,
            )
        }
    };
    let Some(private_result) = private_response.get("result").and_then(Value::as_object) else {
        return failure(
            "TASK_TOOL_CONTINUATION_FAILED",
            "The runtime task completion receipt is missing",
            false,
        );
    };
    if let Some(result) = runtime_response
        .get_mut("result")
        .and_then(Value::as_object_mut)
    {
        for key in ["run", "toolEvidence"] {
            if let Some(value) = private_result.get(key) {
                result.insert(key.into(), value.clone());
            }
        }
        let execution_status = private_result
            .get("run")
            .and_then(Value::as_object)
            .and_then(|run| run.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("failed");
        result.insert(
            "execution".into(),
            json!({
                "status": execution_status,
                "invocationId": task_invocation_id(&continuation).unwrap_or_default()
            }),
        );
    }
    runtime_response
}

fn task_invocation_id(continuation: &Map<String, Value>) -> Result<String> {
    continuation
        .get("completion")
        .and_then(Value::as_object)
        .and_then(|value| value.get("invocationId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| BrokerError::Integrity("task invocation binding is missing".into()))
}

fn success(result: Value) -> Map<String, Value> {
    object(json!({"ok": true, "result": result}))
}

fn complete_artifact_export_response(
    desktop_request: &Map<String, Value>,
    runtime_response: Map<String, Value>,
    integration: &mut BrokerIntegration,
) -> Map<String, Value> {
    if desktop_request.get("method").and_then(Value::as_str) != Some("artifacts.export.intent")
        || runtime_response.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return runtime_response;
    }
    let mut extract = || -> std::result::Result<Value, &'static str> {
        let request_params = desktop_request
            .get("params")
            .and_then(Value::as_object)
            .ok_or("artifact export request parameters are missing")?;
        let result = runtime_response
            .get("result")
            .and_then(Value::as_object)
            .ok_or("artifact export intent is missing")?;
        if result.get("protocolVersion").and_then(Value::as_u64) != Some(1)
            || result.get("requestType").and_then(Value::as_str) != Some("artifact.export")
        {
            return Err("artifact export intent has an unsupported protocol");
        }
        let intent = result
            .get("payload")
            .and_then(Value::as_object)
            .ok_or("artifact export intent payload is missing")?;
        let desktop_handle_id = artifact_export_string(intent, "destinationHandle")?;
        let project_id = artifact_export_string(request_params, "projectId")?;
        let artifact_id = artifact_export_string(intent, "artifactId")?;
        let revision_id = artifact_export_string(intent, "revisionId")?;
        let object_digest = artifact_export_string(intent, "objectDigest")?;
        let content_base64 = artifact_export_string(intent, "contentBase64")?;
        let byte_size = intent
            .get("byteSize")
            .and_then(Value::as_u64)
            .ok_or("artifact export byte size is missing")?;
        if artifact_export_string(request_params, "destinationHandle")? != desktop_handle_id
            || artifact_export_string(request_params, "artifactId")? != artifact_id
            || artifact_export_string(intent, "projectId")? != project_id
            || intent.get("overwrite").and_then(Value::as_bool) != Some(false)
            || request_params
                .get("revisionId")
                .and_then(Value::as_str)
                .is_some_and(|requested| requested != revision_id)
        {
            return Err("artifact export intent does not match the desktop request");
        }
        integration
            .export_artifact_to_desktop_target(ArtifactExportRequest {
                desktop_handle_id,
                project_id,
                artifact_id,
                revision_id,
                object_digest,
                byte_size,
                content_base64,
            })
            .map_err(|_| "artifact export was rejected by the broker")
    };
    match extract() {
        Ok(receipt) => success(receipt),
        Err(message) => failure("ARTIFACT_EXPORT_FAILED", message, false),
    }
}

fn artifact_export_string<'a>(
    map: &'a Map<String, Value>,
    key: &str,
) -> std::result::Result<&'a str, &'static str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("artifact export intent is incomplete")
}

fn complete_backup_create_response(
    desktop_request: &Map<String, Value>,
    runtime_response: Map<String, Value>,
    runtime: Option<&mut RuntimeChild>,
    integration: &mut BrokerIntegration,
) -> Map<String, Value> {
    if desktop_request.get("method").and_then(Value::as_str) != Some("backup.create.intent")
        || runtime_response.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return runtime_response;
    }
    let complete = || -> Result<Value> {
        let request_params = desktop_request
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BrokerError::InvalidEnvelope("backup request parameters are missing".into())
            })?;
        let intent_result = runtime_response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(|| BrokerError::Integrity("runtime backup intent is missing".into()))?;
        if intent_result.get("protocolVersion").and_then(Value::as_u64) != Some(1)
            || intent_result.get("requestType").and_then(Value::as_str) != Some("backup.create")
        {
            return Err(BrokerError::Integrity(
                "runtime backup intent has an unsupported protocol".into(),
            ));
        }
        let intent = intent_result
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(|| BrokerError::Integrity("runtime backup intent is incomplete".into()))?;
        let request_handle = backup_intent_string(request_params, "destinationHandle")?;
        let intent_handle = backup_intent_string(intent, "destinationHandle")?;
        if request_handle != intent_handle {
            return Err(BrokerError::Integrity(
                "runtime backup destination binding does not match the desktop request".into(),
            ));
        }

        let profile_key = load_profile_master_key_for_backup()?;
        let prepared = integration.begin_backup_creation(intent_handle)?;
        let runtime_archive = prepared.runtime_archive().to_string_lossy().into_owned();
        let private_request = object(json!({
            "method": "backup.create.private",
            "params": {"destinationPath": runtime_archive}
        }));
        let Some(runtime) = runtime else {
            integration.abort_backup_creation(&prepared);
            return Err(BrokerError::InvalidConfig(
                "packaged Python runtime is unavailable".into(),
            ));
        };
        let private_response = match runtime.request_streaming(&private_request, |_| Ok(())) {
            Ok(response) => response,
            Err(error) => {
                integration.abort_backup_creation(&prepared);
                return Err(error);
            }
        };
        if private_response.get("ok").and_then(Value::as_bool) != Some(true) {
            integration.abort_backup_creation(&prepared);
            return Err(BrokerError::Integrity(
                "runtime rejected the private backup snapshot".into(),
            ));
        }
        let private_result = private_response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                integration.abort_backup_creation(&prepared);
                BrokerError::Integrity("runtime backup snapshot receipt is missing".into())
            })?;
        if private_result.get("archivePath").and_then(Value::as_str)
            != Some(runtime_archive.as_str())
        {
            integration.abort_backup_creation(&prepared);
            return Err(BrokerError::Integrity(
                "runtime backup snapshot path binding is invalid".into(),
            ));
        }
        let runtime_manifest = private_result.get("manifest").ok_or_else(|| {
            integration.abort_backup_creation(&prepared);
            BrokerError::Integrity("runtime backup manifest is missing".into())
        })?;
        integration.complete_backup_creation(prepared, runtime_manifest, &profile_key)
    };
    match complete() {
        Ok(receipt) => success(receipt),
        Err(_) => failure(
            "BACKUP_CREATE_FAILED",
            "The backup could not be created or verified",
            false,
        ),
    }
}

fn backup_intent_string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BrokerError::Integrity("runtime backup intent is incomplete".into()))
}

fn complete_backup_restore_response(
    desktop_request: &Map<String, Value>,
    runtime_response: Map<String, Value>,
    runtime: Option<&mut RuntimeChild>,
    integration: &mut BrokerIntegration,
    data_dir: &std::path::Path,
) -> Map<String, Value> {
    if desktop_request.get("method").and_then(Value::as_str) != Some("backup.restore.intent")
        || runtime_response.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return runtime_response;
    }
    let prepare = || -> Result<Value> {
        let request_params = desktop_request
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                BrokerError::InvalidEnvelope("backup restore parameters are missing".into())
            })?;
        let intent_result = runtime_response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(|| BrokerError::Integrity("runtime restore intent is missing".into()))?;
        if intent_result.get("protocolVersion").and_then(Value::as_u64) != Some(1)
            || intent_result.get("requestType").and_then(Value::as_str) != Some("backup.restore")
        {
            return Err(BrokerError::Integrity(
                "runtime restore intent has an unsupported protocol".into(),
            ));
        }
        let intent = intent_result
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(|| BrokerError::Integrity("runtime restore intent is incomplete".into()))?;
        let request_handle = backup_intent_string(request_params, "sourceHandle")?;
        let intent_handle = backup_intent_string(intent, "sourceHandle")?;
        if request_handle != intent_handle
            || intent.get("mode").and_then(Value::as_str) != Some("replace-after-restart")
            || intent.get("requiresFreshApproval").and_then(Value::as_bool) != Some(true)
        {
            return Err(BrokerError::Integrity(
                "runtime restore intent does not match the desktop request".into(),
            ));
        }

        let source = integration.resolve_backup_source(intent_handle)?;
        let manifest = read_restore_manifest(&source)?;
        let restored_key = resolve_restore_profile_key(&manifest)?;
        let staging_root = data_dir.join("broker-restore");
        let workspace = extract_restore_workspace(&source, &staging_root, &restored_key)?;
        let result = (|| -> Result<Value> {
            let Some(active_runtime) = runtime else {
                return Err(BrokerError::InvalidConfig(
                    "packaged Python runtime is unavailable".into(),
                ));
            };
            let prepare_request = object(json!({
                "method": "backup.restore.prepare_disposable.private",
                "params": {
                    "sourcePath": workspace.runtime_archive.to_string_lossy(),
                    "destinationRoot": workspace.profile_root.to_string_lossy(),
                }
            }));
            let prepare_response =
                active_runtime.request_streaming(&prepare_request, |_| Ok(()))?;
            if prepare_response.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(BrokerError::Integrity(
                    "runtime rejected the restored archive".into(),
                ));
            }
            let prepared = prepare_response
                .get("result")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    BrokerError::Integrity("runtime restore receipt is missing".into())
                })?;
            let mode = prepared
                .get("contentMode")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    BrokerError::Integrity("runtime restore content mode is missing".into())
                })?;
            let content_encrypted = match mode {
                "encrypted" => true,
                "plaintext" => false,
                _ => {
                    return Err(BrokerError::Integrity(
                        "runtime restore content mode is invalid".into(),
                    ))
                }
            };

            let executable = std::env::var_os("CUPCAKE_RUNTIME_PATH")
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .ok_or_else(|| {
                    BrokerError::InvalidConfig("packaged Python runtime is unavailable".into())
                })?;
            let mut verifier = RuntimeChild::launch_with_profile_key(
                &executable,
                &workspace.profile_root,
                &restored_key,
                content_encrypted,
            )?;
            let validate_request = object(json!({
                "method": "backup.restore.validate_disposable.private",
                "params": {}
            }));
            let verification = verifier.request_streaming(&validate_request, |_| Ok(()));
            verifier.shutdown();
            let verification = verification?;
            if verification.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(BrokerError::Integrity(
                    "restored profile could not be opened".into(),
                ));
            }
            let verified = verification.get("result").cloned().ok_or_else(|| {
                BrokerError::Integrity("restored profile verification is missing".into())
            })?;
            restore_security_snapshot(&workspace)?;
            let _ = std::fs::remove_dir_all(workspace.root.join("outer"));
            Ok(workspace.receipt(&verified))
        })();
        if result.is_err() {
            workspace.cleanup();
        }
        result
    };
    match prepare() {
        Ok(receipt) => success(receipt),
        Err(_) => failure(
            "BACKUP_RESTORE_FAILED",
            "The backup could not be authenticated and prepared",
            false,
        ),
    }
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
    fn named_compatible_endpoints_and_free_tier_policy_are_fixed() {
        let groq = named_compatible_endpoint(
            "groq",
            &object(json!({
                "modelId": "openai/gpt-oss-20b"
            })),
        )
        .unwrap();
        assert_eq!(groq.id, "groq");
        assert_eq!(groq.base_url, "https://api.groq.com/openai/v1");
        assert_eq!(groq.model_id.as_deref(), Some("openai/gpt-oss-20b"));

        let cloudflare = named_compatible_endpoint(
            "cloudflare",
            &object(json!({
                "accountId": "a".repeat(32),
                "modelId": "@cf/meta/llama-3.1-8b-instruct-fp8"
            })),
        )
        .unwrap();
        assert!(cloudflare
            .base_url
            .ends_with(&format!("/{}/ai/v1", "a".repeat(32))));
        assert!(named_compatible_endpoint(
            "cloudflare",
            &object(json!({"accountId": "not-an-account"}))
        )
        .is_err());

        assert!(named_compatible_model_allowed(
            "openrouter",
            "nvidia/nemotron-3.5-lightning:free"
        ));
        assert!(!named_compatible_model_allowed(
            "openrouter",
            "nvidia/nemotron-3.5-lightning"
        ));
        assert!(named_compatible_model_allowed("groq", "groq/compound"));
        assert!(named_compatible_model_allowed("groq", "allam-2-7b"));
        assert!(!named_compatible_model_allowed("groq", "whisper-large-v3"));
        assert!(!named_compatible_model_allowed(
            "groq",
            "openai/gpt-oss-safeguard-20b"
        ));
    }

    #[test]
    fn named_compatible_catalog_preserves_bounded_discovered_chat_models() {
        let result = json!({
            "models": [
                {"model": "allam-2-7b", "display_name": "ALLaM 2 7B"},
                {"model": "groq/compound-mini", "display_name": "Compound Mini"}
            ]
        });
        let models = named_compatible_catalog_from_result("groq", &result).unwrap();

        assert_eq!(
            models,
            vec![
                NamedCompatibleCatalogModel {
                    model_id: "allam-2-7b".into(),
                    display_name: "ALLaM 2 7B".into(),
                },
                NamedCompatibleCatalogModel {
                    model_id: "groq/compound-mini".into(),
                    display_name: "Compound Mini".into(),
                },
            ]
        );
        assert!(named_compatible_catalog_from_result(
            "groq",
            &json!({"models":[{"model":"whisper-large-v3"}]})
        )
        .is_err());
    }

    #[test]
    fn named_compatible_selection_requires_saved_account_membership() {
        let cached = vec![NamedCompatibleCatalogModel {
            model_id: "groq/compound".into(),
            display_name: "Compound".into(),
        }];

        assert!(named_compatible_model_was_saved(
            "groq/compound",
            Some("openai/gpt-oss-20b"),
            &cached,
        ));
        assert!(!named_compatible_model_was_saved(
            "vendor/guessed-chat-model",
            Some("openai/gpt-oss-20b"),
            &cached,
        ));
        assert!(named_compatible_model_was_saved(
            "openai/gpt-oss-20b",
            Some("openai/gpt-oss-20b"),
            &[],
        ));
        assert!(!named_compatible_model_was_saved(
            "vendor/guessed-chat-model",
            Some("openai/gpt-oss-20b"),
            &[],
        ));
    }

    #[test]
    fn nvidia_catalog_snapshot_keeps_only_bounded_model_ids() {
        let ids = nvidia_nim_catalog_from_result(&json!({
            "models": [
                {"model": "nvidia/nemotron-3.5-lightning"},
                {"model": "vendor/account-chat"},
                {"model": "vendor/account-chat"}
            ]
        }))
        .unwrap();

        assert_eq!(
            ids,
            vec![
                "nvidia/nemotron-3.5-lightning".to_owned(),
                "vendor/account-chat".to_owned(),
            ]
        );
        assert!(
            nvidia_nim_catalog_from_result(&json!({"models":[{"model":"invalid model id"}]}))
                .is_err()
        );
    }

    #[test]
    fn runtime_compatible_route_accepts_only_matching_trusted_boundaries() {
        let local = json!({
            "modelId": "openai-compatible:cupcake-local/local-model",
            "baseUrl": "http://127.0.0.1:1234/v1",
            "runtimeKind": "cupcake_llama_cpp",
            "privacyRoute": "local"
        });
        assert!(validate_runtime_compatible_route(
            "openai-compatible:cupcake-local/local-model",
            &local
        )
        .is_ok());

        for rejected in [
            json!({
                "modelId": "openai-compatible:cupcake-local/different-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "cupcake_llama_cpp",
                "privacyRoute": "local"
            }),
            json!({
                "modelId": "openai-compatible:cupcake-local/local-model",
                "baseUrl": "https://models.example.test/v1",
                "runtimeKind": "cupcake_llama_cpp",
                "privacyRoute": "local"
            }),
            json!({
                "modelId": "openai-compatible:cupcake-local/local-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "cupcake_llama_cpp",
                "privacyRoute": "self_hosted"
            }),
            json!({
                "modelId": "openai-compatible:cupcake-local/local-model",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "runtimeKind": "forged_runtime",
                "privacyRoute": "local"
            }),
        ] {
            assert!(validate_runtime_compatible_route(
                "openai-compatible:cupcake-local/local-model",
                &rejected
            )
            .is_err());
        }
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

    #[test]
    fn restore_route_rejects_an_intent_not_bound_to_the_desktop_handle() {
        let data = tempdir().unwrap();
        let mut integration = BrokerIntegration::open(data.path()).unwrap();
        let desktop = object(json!({
            "method": "backup.restore.intent",
            "params": {"sourceHandle": "desktop-handle"}
        }));
        let runtime = success(json!({
            "protocolVersion": 1,
            "requestType": "backup.restore",
            "payload": {
                "sourceHandle": "different-handle",
                "mode": "replace-after-restart",
                "requiresFreshApproval": true
            }
        }));
        let response = complete_backup_restore_response(
            &desktop,
            runtime,
            None,
            &mut integration,
            data.path(),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "BACKUP_RESTORE_FAILED");
        assert!(!data.path().join("broker-restore").exists());
    }

    #[test]
    fn task_tool_continuation_defaults_to_ready_and_guarded_mode_still_requires_approval() {
        let data = tempdir().unwrap();
        let mut integration = BrokerIntegration::open(data.path()).unwrap();
        let invocation_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        let desktop = object(json!({
            "method": "tasks.create",
            "params": {"prompt": "Run task.py", "workKind": "code_execution"}
        }));
        let runtime = success(json!({
            "run": {"run_id": "run-task-1", "status": "waiting_input"},
            "continuation": {
                "request": {
                    "protocol_version": 1,
                    "request_type": "tool.preflight",
                    "payload": {
                        "intent": {
                            "invocation_id": invocation_id,
                            "run_id": "run-task-1",
                            "tool_name": "python.run",
                            "tool_version": "1.0.0",
                            "arguments": {
                                "source": "print('private source')",
                                "input_files": [],
                                "execution_mode": "module_test",
                                "timeout_seconds": 30,
                                "memory_mb": 256
                            },
                            "project_id": "project-task-1",
                            "task_id": "task-task-1",
                            "requested_at": "2026-09-05T12:00:00Z"
                        },
                        "descriptor": {
                            "name": "python.run",
                            "version": "1.0.0",
                            "display_name": "Run Python",
                            "description": "Run a staged Python program in the offline sandbox.",
                            "input_schema": {"type": "object"},
                            "output_schema": {"type": "object"},
                            "effects": ["execute_code"],
                            "required_grants": ["sandbox.execute"],
                            "default_data_flows": [],
                            "timeout_seconds": 900,
                            "cancellable": true,
                            "category": "native"
                        }
                    }
                },
                "completion": {
                    "runId": "run-task-1",
                    "taskId": "task-task-1",
                    "stepIndex": 0,
                    "stepKey": "stage-1",
                    "inputDigest": "ab".repeat(32),
                    "invocationId": invocation_id,
                    "artifactId": "artifact-task-1",
                    "revisionId": "revision-task-1",
                    "objectDigest": "cd".repeat(32),
                    "sourceSha256": "ef".repeat(32)
                }
            }
        }));

        let guarded_runtime = runtime.clone();
        let ready = complete_task_tool_response(&desktop, runtime, None, &mut integration);

        assert_eq!(ready["ok"], true);
        assert_eq!(ready["result"]["execution"]["status"], "ready");
        assert_eq!(ready["result"]["execution"]["invocationId"], invocation_id);
        assert!(ready["result"].get("continuation").is_none());
        assert!(!Value::Object(ready).to_string().contains("private source"));

        let guarded_data = tempdir().unwrap();
        let mut guarded_integration = BrokerIntegration::open(guarded_data.path()).unwrap();
        guarded_integration.set_permission_mode("guarded").unwrap();
        let response =
            complete_task_tool_response(&desktop, guarded_runtime, None, &mut guarded_integration);

        assert_eq!(response["ok"], true, "{response:?}");
        assert_eq!(
            response["result"]["execution"]["status"],
            "approval_required"
        );
        assert_eq!(
            response["result"]["execution"]["preflight"]["invocation_id"],
            invocation_id
        );
        assert_eq!(
            response["result"]["execution"]["invocationId"],
            invocation_id
        );
        assert!(response["result"].get("continuation").is_none());
        assert!(!Value::Object(response)
            .to_string()
            .contains("private source"));
    }
}
