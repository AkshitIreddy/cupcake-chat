use base64::prelude::*;
use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::framing::{
    read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES,
};
use cupcake_tool_broker::protocol::{
    uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard,
};
use cupcake_tool_broker::PROTOCOL_VERSION;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;
use uuid::Uuid;

struct BrokerProcess {
    child: Child,
    input: BufReader<ChildStdout>,
    output: BufWriter<ChildStdin>,
    secret: Vec<u8>,
    session_id: Uuid,
    sequences: HashMap<Uuid, u64>,
    replay: ReplayGuard,
    _data: TempDir,
}

#[cfg(windows)]
#[test]
fn saved_native_provider_is_restored_before_group_readiness_without_a_solo_send() {
    let mut broker = BrokerProcess::launch();
    let mut request = |method: &str, params: Value| {
        broker.send(
            uuid_v7(),
            MessageType::Request,
            object(json!({"method":method,"params":params})),
        );
        let response = broker.read();
        assert_eq!(response.payload["ok"], true);
        response.payload
    };
    let connected = request(
        "providers.connect",
        json!({
            "provider":"cohere", "secret":"fixture-group-credential"
        }),
    );
    assert_eq!(connected["result"]["configured"], true);
    // Lose only runtime memory, retaining the real isolated Windows vault.
    request("test.clear_provider_memory", json!({}));
    let roster = request(
        "conversations.participants.list",
        json!({"conversationId":"fixture"}),
    );
    assert_eq!(roster["result"][0]["availability"]["status"], "ready");
    assert!(!Value::Object(roster)
        .to_string()
        .contains("fixture-group-credential"));
}

impl BrokerProcess {
    fn launch() -> Self {
        let data = tempfile::tempdir().unwrap();
        let secret = vec![42_u8; 32];
        let mut child = Command::new(env!("CARGO_BIN_EXE_cupcake-tool-broker"))
            .arg("--stdio")
            .env(
                "CUPCAKE_BROKER_AUTH",
                BASE64_URL_SAFE_NO_PAD.encode(&secret),
            )
            .env("CUPCAKE_PROTOCOL_VERSION", PROTOCOL_VERSION.to_string())
            .env("CUPCAKE_DATA_DIR", data.path())
            // DPAPI credentials are Windows-user scoped, not CUPCAKE_DATA_DIR
            // scoped. Tests must never read or replace the owner's vault.
            .env("LOCALAPPDATA", data.path().join("local-app-data"))
            .env(
                "CUPCAKE_RUNTIME_PATH",
                env!("CARGO_BIN_EXE_cupcake-fake-runtime"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufWriter::new(child.stdin.take().unwrap());
        let input = BufReader::new(child.stdout.take().unwrap());
        let mut process = Self {
            child,
            input,
            output,
            secret,
            session_id: uuid_v7(),
            sequences: HashMap::new(),
            replay: ReplayGuard::default(),
            _data: data,
        };
        let correlation = uuid_v7();
        process.send(
            correlation,
            MessageType::Handshake,
            object(json!({"product":"CUPCAKEAGI","protocolVersion":PROTOCOL_VERSION})),
        );
        let response = process.read();
        assert_eq!(response.message_type, MessageType::Handshake);
        process
    }

    fn send(&mut self, correlation: Uuid, message_type: MessageType, payload: Map<String, Value>) {
        let sequence = self
            .sequences
            .entry(correlation)
            .and_modify(|value| *value += 1)
            .or_insert(1);
        let envelope = ProtocolEnvelope::unsigned(
            uuid_v7(),
            correlation,
            self.session_id,
            *sequence,
            (Utc::now() + chrono::Duration::seconds(30))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            ProtocolLineage::default(),
            message_type,
            payload,
        )
        .sign(&self.secret)
        .unwrap();
        write_protocol_frame(&mut self.output, &envelope, DEFAULT_MAX_FRAME_BYTES).unwrap();
    }

    fn read(&mut self) -> ProtocolEnvelope {
        let envelope: ProtocolEnvelope =
            read_protocol_frame(&mut self.input, DEFAULT_MAX_FRAME_BYTES).unwrap();
        envelope.verify_auth(&self.secret).unwrap();
        self.replay.accept(&envelope, Utc::now()).unwrap();
        envelope
    }
}

impl Drop for BrokerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn authenticated_file_events_are_acknowledged_and_do_not_terminate_broker() {
    let selected = tempfile::tempdir().unwrap();
    let file = selected.path().join("note.txt");
    std::fs::write(&file, "cupcake").unwrap();
    let mut broker = BrokerProcess::launch();
    let event_correlation = uuid_v7();
    broker.send(
        event_correlation,
        MessageType::Event,
        object(json!({
            "type":"files.granted",
            "handle":{
                "id":"018f1e2d-3c4b-7a69-8def-0123456789ab",
                "kind":"file",
                "name":"note.txt",
                "absolutePath":file,
                "writable":false
            }
        })),
    );
    let acknowledgement = broker.read();
    assert_eq!(acknowledgement.message_type, MessageType::Response);
    assert_eq!(acknowledgement.payload["ok"], true);
    assert!(!Value::Object(acknowledgement.payload.clone())
        .to_string()
        .contains(selected.path().to_str().unwrap()));

    let ping_correlation = uuid_v7();
    broker.send(ping_correlation, MessageType::Ping, Map::new());
    assert_eq!(broker.read().message_type, MessageType::Pong);
}

#[test]
fn broker_dispatch_preflights_and_executes_a_bounded_file_read() {
    let selected = tempfile::tempdir().unwrap();
    let file = selected.path().join("note.txt");
    std::fs::write(&file, "frosting thread").unwrap();
    let mut broker = BrokerProcess::launch();
    let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
    let grant_correlation = uuid_v7();
    broker.send(
        grant_correlation,
        MessageType::Event,
        object(json!({"type":"files.granted","handle":{
            "id":handle_id,"kind":"file","name":"note.txt","absolutePath":file,"writable":false
        }})),
    );
    assert_eq!(broker.read().payload["ok"], true);

    let intent = json!({
        "invocation_id":"invoke-process-1","run_id":"run-process-1","tool_name":"files.read","tool_version":"1.0.0",
        "arguments":{"grant_id":handle_id,"relative_path":"note.txt","max_bytes":1024},
        "project_id":null,"task_id":null,"requested_at":"2026-08-28T12:00:00Z"
    });
    let preflight_correlation = uuid_v7();
    broker.send(
        preflight_correlation,
        MessageType::Request,
        object(json!({"method":"broker.dispatch","params":{
            "protocol_version":1,"request_type":"tool.preflight","payload":{
                "intent":intent,
                "descriptor":{
                    "name":"files.read","version":"1.0.0","display_name":"Read file","description":"Read approved text",
                    "input_schema":{"type":"object"},"output_schema":{"type":"object"},"effects":["read_files"],
                    "required_grants":["filesystem.read"],"default_data_flows":[],"timeout_seconds":60,
                    "cancellable":true,"category":"native"
                }
            }
        }})),
    );
    let preflight_response = broker.read();
    assert_eq!(preflight_response.payload["ok"], true);
    assert_eq!(
        preflight_response.payload["result"]["preflight"]["decision"],
        "allow"
    );
    assert!(!Value::Object(preflight_response.payload.clone())
        .to_string()
        .contains(selected.path().to_str().unwrap()));

    let execute_correlation = uuid_v7();
    broker.send(
        execute_correlation,
        MessageType::Request,
        object(json!({"method":"broker.dispatch","params":{
            "protocol_version":1,"request_type":"tool.execute","payload":{
                "intent":intent,
                "preflight":preflight_response.payload["result"]["preflight"].clone(),
                "approval":null
            }
        }})),
    );
    let execute_response = broker.read();
    assert_eq!(execute_response.payload["ok"], true);
    assert_eq!(
        execute_response.payload["result"]["output"]["text"],
        "frosting thread"
    );
    assert!(!Value::Object(execute_response.payload)
        .to_string()
        .contains(selected.path().to_str().unwrap()));
}

#[test]
fn runtime_event_is_forwarded_before_terminal_response() {
    let mut broker = BrokerProcess::launch();
    let correlation = uuid_v7();
    let started = Instant::now();
    broker.send(
        correlation,
        MessageType::Request,
        object(json!({"method":"chat.send","params":{"modelId":"mock:stream"}})),
    );
    let event = broker.read();
    let event_elapsed = started.elapsed();
    assert_eq!(event.correlation_id, correlation);
    assert_eq!(event.message_type, MessageType::Event);
    assert_eq!(event.sequence, 1);
    let response = broker.read();
    assert_eq!(response.correlation_id, correlation);
    assert_eq!(response.message_type, MessageType::Response);
    assert_eq!(response.sequence, 2);
    assert!(
        started.elapsed().saturating_sub(event_elapsed) >= Duration::from_millis(1_300),
        "event and terminal response were delivered together"
    );
}

#[test]
fn discovered_local_compatible_model_chats_without_a_cloud_credential() {
    let mut broker = BrokerProcess::launch();
    let discover_correlation = uuid_v7();
    broker.send(
        discover_correlation,
        MessageType::Request,
        object(json!({"method":"local_models.discover","params":{}})),
    );
    let discovered = broker.read();
    assert_eq!(discovered.payload["ok"], true);
    let model_id = discovered.payload["result"]["models"][0]["id"]
        .as_str()
        .expect("discovery returns a selectable local model")
        .to_owned();

    let chat_correlation = uuid_v7();
    broker.send(
        chat_correlation,
        MessageType::Request,
        object(json!({"method":"chat.send","params":{"modelId":model_id}})),
    );
    let response = broker.read();
    assert_eq!(response.correlation_id, chat_correlation);
    assert_eq!(response.message_type, MessageType::Response);
    assert_eq!(response.payload["ok"], true);
    assert_eq!(response.payload["result"]["method"], "chat.send");
}

#[test]
fn unloaded_cupcake_local_chat_forwards_to_runtime_for_lazy_load() {
    // A downloaded but not yet loaded local model has no registered loopback
    // route, so the fake runtime resolves Null. The broker must still forward
    // chat.send so Python can start weights instead of reporting a missing
    // cloud endpoint.
    let mut broker = BrokerProcess::launch();
    let correlation = uuid_v7();
    broker.send(
        correlation,
        MessageType::Request,
        object(json!({
            "method":"chat.send",
            "params":{"modelId":"openai-compatible:cupcake-local/qwen3-1-7b-q8-0"}
        })),
    );
    let response = broker.read();
    assert_eq!(response.correlation_id, correlation);
    assert_eq!(response.message_type, MessageType::Response);
    assert_eq!(response.payload["ok"], true);
    assert_eq!(response.payload["result"]["method"], "chat.send");
}

#[test]
fn undiscovered_remote_compatible_model_still_requires_a_connected_endpoint() {
    let mut broker = BrokerProcess::launch();
    let correlation = uuid_v7();
    broker.send(
        correlation,
        MessageType::Request,
        object(json!({
            "method":"chat.send",
            "params":{"modelId":"openai-compatible:remote/model"}
        })),
    );
    let response = broker.read();
    assert_eq!(response.message_type, MessageType::Response);
    assert_eq!(response.payload["ok"], false);
    assert_eq!(response.payload["error"]["code"], "RUNTIME_UNAVAILABLE");
    assert!(response.payload["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("endpoint is not connected"));
}

#[test]
fn cancel_is_processed_while_runtime_request_is_still_active() {
    let mut broker = BrokerProcess::launch();
    let chat_correlation = uuid_v7();
    broker.send(
        chat_correlation,
        MessageType::Request,
        object(json!({"method":"chat.send","params":{"modelId":"mock:stream"}})),
    );
    assert_eq!(broker.read().message_type, MessageType::Event);

    let cancel_correlation = uuid_v7();
    let started = Instant::now();
    broker.send(
        cancel_correlation,
        MessageType::Cancel,
        object(json!({"targetId":"run-active"})),
    );
    let cancelled = broker.read();
    assert_eq!(cancelled.correlation_id, cancel_correlation);
    assert_eq!(cancelled.message_type, MessageType::Response);
    assert_eq!(cancelled.payload["ok"], true);
    assert!(started.elapsed() < Duration::from_millis(500));

    let terminal = broker.read();
    assert_eq!(terminal.correlation_id, chat_correlation);
    assert_eq!(terminal.message_type, MessageType::Response);
}

#[test]
fn late_runtime_cancel_ack_does_not_poison_the_next_provider_request() {
    let mut broker = BrokerProcess::launch();
    let chat_correlation = uuid_v7();
    broker.send(
        chat_correlation,
        MessageType::Request,
        object(json!({"method":"chat.send","params":{"modelId":"mock:late-cancel-ack"}})),
    );
    assert_eq!(broker.read().message_type, MessageType::Event);

    let cancel_correlation = uuid_v7();
    broker.send(
        cancel_correlation,
        MessageType::Cancel,
        object(json!({"targetId":"run-late-ack"})),
    );
    let cancelled = broker.read();
    assert_eq!(cancelled.correlation_id, cancel_correlation);
    assert_eq!(cancelled.payload["ok"], true);

    let terminal = broker.read();
    assert_eq!(terminal.correlation_id, chat_correlation);
    assert_eq!(terminal.message_type, MessageType::Response);

    let provider_correlation = uuid_v7();
    broker.send(
        provider_correlation,
        MessageType::Request,
        object(json!({
            "method":"providers.test",
            "params":{"provider":"cohere","secret":"fixture-provider-credential"}
        })),
    );
    let provider = broker.read();
    assert_eq!(provider.correlation_id, provider_correlation);
    assert_eq!(provider.message_type, MessageType::Response);
    assert_eq!(provider.payload["ok"], true);
    assert_eq!(provider.payload["result"]["tested"], true);
}

#[test]
fn download_pause_bypasses_active_stream_queue_and_second_start_is_rejected() {
    let mut broker = BrokerProcess::launch();
    let download_correlation = uuid_v7();
    broker.send(
        download_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download",
            "params":{"artifactId":"fixture-slow-download","artifactKind":"model"}
        })),
    );
    let progress = broker.read();
    assert_eq!(progress.correlation_id, download_correlation);
    assert_eq!(progress.message_type, MessageType::Event);
    assert_eq!(
        progress.payload["payload"]["download"]["state"],
        "downloading"
    );

    let second_correlation = uuid_v7();
    broker.send(
        second_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download",
            "params":{"artifactId":"fixture-second-download","artifactKind":"model"}
        })),
    );
    let busy = broker.read();
    assert_eq!(busy.correlation_id, second_correlation);
    assert_eq!(busy.payload["ok"], false);
    assert_eq!(busy.payload["error"]["code"], "DOWNLOAD_BUSY");

    let pause_correlation = uuid_v7();
    let started = Instant::now();
    broker.send(
        pause_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download.pause",
            "params":{"artifactId":"fixture-slow-download"}
        })),
    );
    let paused = broker.read();
    assert_eq!(paused.correlation_id, pause_correlation);
    assert_eq!(paused.payload["ok"], true);
    assert_eq!(paused.payload["result"]["state"], "paused");
    assert!(started.elapsed() < Duration::from_millis(500));

    let terminal = broker.read();
    assert_eq!(terminal.correlation_id, download_correlation);
    assert_eq!(terminal.payload["result"]["download"]["state"], "paused");

    let provider_correlation = uuid_v7();
    broker.send(
        provider_correlation,
        MessageType::Request,
        object(json!({
            "method":"providers.test",
            "params":{"provider":"cohere","secret":"fixture-provider-credential"}
        })),
    );
    let provider = broker.read();
    assert_eq!(provider.correlation_id, provider_correlation);
    assert_eq!(provider.payload["ok"], true);
}

#[test]
fn download_cancel_bypasses_active_stream_queue() {
    let mut broker = BrokerProcess::launch();
    let download_correlation = uuid_v7();
    broker.send(
        download_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download",
            "params":{"artifactId":"fixture-slow-download","artifactKind":"model"}
        })),
    );
    assert_eq!(broker.read().message_type, MessageType::Event);

    let cancel_correlation = uuid_v7();
    broker.send(
        cancel_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download.cancel",
            "params":{"artifactId":"fixture-slow-download"}
        })),
    );
    let cancelled = broker.read();
    assert_eq!(cancelled.correlation_id, cancel_correlation);
    assert_eq!(cancelled.payload["ok"], true);
    assert_eq!(cancelled.payload["result"]["state"], "cancelled");

    let terminal = broker.read();
    assert_eq!(terminal.correlation_id, download_correlation);
    assert_eq!(terminal.payload["result"]["download"]["state"], "cancelled");
}

#[test]
fn download_control_ack_after_terminal_response_is_still_correlated() {
    let mut broker = BrokerProcess::launch();
    let download_correlation = uuid_v7();
    broker.send(
        download_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download",
            "params":{"artifactId":"fixture-terminal-first-download","artifactKind":"model"}
        })),
    );
    assert_eq!(broker.read().message_type, MessageType::Event);

    let pause_correlation = uuid_v7();
    broker.send(
        pause_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download.pause",
            "params":{"artifactId":"fixture-terminal-first-download"}
        })),
    );
    let paused = broker.read();
    assert_eq!(paused.correlation_id, pause_correlation);
    assert_eq!(paused.payload["result"]["state"], "paused");

    let terminal = broker.read();
    assert_eq!(terminal.correlation_id, download_correlation);
    assert_eq!(terminal.payload["result"]["download"]["state"], "paused");
}

#[test]
fn immediate_download_pause_is_ordered_after_the_runtime_start_frame() {
    let mut broker = BrokerProcess::launch();
    let download_correlation = uuid_v7();
    let pause_correlation = uuid_v7();
    broker.send(
        download_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download",
            "params":{"artifactId":"fixture-slow-download","artifactKind":"model"}
        })),
    );
    // Deliberately do not wait for a progress event before sending control.
    broker.send(
        pause_correlation,
        MessageType::Request,
        object(json!({
            "method":"local_models.cupcake.download.pause",
            "params":{"artifactId":"fixture-slow-download"}
        })),
    );

    let mut saw_progress = false;
    let mut saw_pause = false;
    let mut saw_terminal = false;
    for _ in 0..3 {
        let envelope = broker.read();
        if envelope.correlation_id == pause_correlation {
            saw_pause = envelope.payload["result"]["state"] == "paused";
        } else if envelope.correlation_id == download_correlation
            && envelope.message_type == MessageType::Event
        {
            saw_progress = true;
        } else if envelope.correlation_id == download_correlation
            && envelope.message_type == MessageType::Response
        {
            saw_terminal = envelope.payload["result"]["download"]["state"] == "paused";
        }
    }
    assert!(saw_progress);
    assert!(saw_pause);
    assert!(saw_terminal);
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
