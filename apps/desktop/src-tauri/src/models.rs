use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DESKTOP_API_VERSION: u16 = 1;
pub const RUNTIME_EVENT_NAME: &str = "cupcake://runtime-event";
pub const RUNTIME_STATUS_EVENT_NAME: &str = "cupcake://runtime-status";
pub const DESKTOP_COMMAND_EVENT_NAME: &str = "cupcake://command";
pub const WINDOW_STATE_EVENT_NAME: &str = "cupcake://window-state";
pub const DEEP_LINK_EVENT_NAME: &str = "cupcake://deep-link";
pub const WORKSPACE_LOCK_EVENT_NAME: &str = "cupcake://workspace-lock";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLockState {
    NeedsSetup,
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLockStatus {
    pub state: WorkspaceLockState,
    pub failed_attempts: u32,
    pub retry_after_ms: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Disabled,
    Starting,
    Ready,
    Degraded,
    Stopped,
    Crashed,
    Stopping,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    Broker,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub mode: RuntimeMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub restart_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            state: RuntimeState::Stopped,
            mode: RuntimeMode::Disabled,
            pid: None,
            restart_count: 0,
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub api_version: u16,
    pub app_version: String,
    pub platform: &'static str,
    pub packaged: bool,
    pub runtime: RuntimeState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RuntimeResponseError>,
}

impl RuntimeResponse {
    pub fn failure(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(RuntimeResponseError {
                code: code.into(),
                message: message.into(),
                retryable,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResponseError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogOpenOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub filters: Vec<DialogFilter>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpaqueFileHandle {
    pub id: String,
    pub kind: FileHandleKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub writable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileHandleKind {
    File,
    Directory,
    SaveTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePayload {
    pub maximized: bool,
    pub minimized: bool,
    pub fullscreen: bool,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkPayload {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConnectionInput {
    pub provider: String,
    pub secret: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub organization: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}
