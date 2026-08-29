use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::credential_prompt::prompt_api_key;
use cupcake_tool_broker::framing::{read_frame, write_frame, DEFAULT_MAX_FRAME_BYTES};
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
use std::collections::{HashMap, VecDeque};
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
                let envelope: ProtocolEnvelope = read_frame(&mut input, DEFAULT_MAX_FRAME_BYTES)?;
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
    let attachments = match params.get("attachments").and_then(Value::as_array) {
        Some(values) if !values.is_empty() => values.clone(),
        _ => return Ok(()),
    };
    if attachments.len() > 32 {
        return Err(BrokerError::InvalidConfig(
            "a chat can attach at most 32 files".into(),
        ));
    }
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut product_attachments = Vec::with_capacity(attachments.len());
    let mut staged_ids = Vec::new();
    let result = (|| -> Result<()> {
        for attachment in attachments {
            let attachment = attachment.as_object().ok_or_else(|| {
                BrokerError::InvalidEnvelope("attachment must be an object".into())
            })?;
            let handle_id = attachment
                .get("handleId")
                .and_then(Value::as_str)
                .ok_or(BrokerError::InvalidGrant)?;
            let staged = integration.stage_attachment(handle_id)?;
            staged_ids.push(staged.staging_id.clone());
            let structured_document = integration.parse_staged_document(&staged)?;
            let request = object(json!({
                "method": "ingestion.ingest.private",
                "params": {
                    "projectId": project_id.clone(),
                    "sourceHandle": handle_id,
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
            product_attachments.push(json!({
                "fileId": ingested.get("fileId").cloned().unwrap_or(Value::Null),
                "sourceId": ingested.get("sourceId").cloned().unwrap_or(Value::Null),
                "name": staged.display_name,
                "destination": attachment.get("destination").cloned().unwrap_or(json!("local"))
            }));
        }
        Ok(())
    })();
    for staging_id in staged_ids {
        let _ = integration.cleanup_staged_attachment(&staging_id);
    }
    result?;
    params.insert(
        "attachments".into(),
        Value::Array(product_attachments.clone()),
    );
    params.insert(
        "attachmentHandles".into(),
        Value::Array(
            product_attachments
                .iter()
                .filter_map(|value| value.get("fileId").cloned())
                .filter(|value| !value.is_null())
                .collect(),
        ),
    );
    Ok(())
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
    write_frame(output, &response, DEFAULT_MAX_FRAME_BYTES)
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
}
