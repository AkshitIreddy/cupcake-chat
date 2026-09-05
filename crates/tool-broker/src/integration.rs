//! Stateful translation between the desktop/runtime wire contracts and the
//! broker-owned grants, policy, approvals, registry, and audit components.
//!
//! Raw operating-system paths enter only in authenticated Tauri-host events and
//! are retained in this process. Responses expose newly generated broker grant
//! IDs; the Python runtime never receives a native path.

use crate::approval::{ApprovalChallenge, ApprovalManager, ApprovalProof};
use crate::audit::{AuditEvent, AuditStore};
use crate::backup_container::{create_coordinated_backup, BackupProtectionInput};
use crate::backup_envelope::BackupIdentity;
use crate::grants::{
    FilesystemGrantStore, FilesystemPermission, GrantId, GrantScope, ResolvedPath,
};
use crate::mcp::{ConnectionState, McpTransportConfig, OAuthPkceConfig};
use crate::mcp_transport::{McpConnectionSnapshot, McpTransportService};
use crate::native::{
    atomic_replace, sync_directory, DisabledLocalModelBackend, NativeSandboxCancellation,
    NativeToolExecutorService, StrictHttpsClient,
};
use crate::policy::{CategoryDecision, Effect, PolicyDecision, PolicySet, ScopeKey};
use crate::protocol::{canonical_json, RuntimeBrokerRequest, RuntimeRequestType};
use crate::registry::native_descriptor_catalog;
use crate::registry::{
    DataDestination as NativeDataDestination, ResourceLimits, ToolIntent, ToolPreflight,
    ToolResult as NativeToolResult, ToolResultStatus as NativeToolResultStatus,
};
use crate::sandbox::{NetworkPolicy, ProcessState, ResolvedProcessPlan, SandboxBackend};
use crate::security_db::{
    SecurityDatabase, SecurityGrant, SecurityGrantScope, StoredApprovalChallenge, StoredPolicy,
    StoredPolicyDecision, StoredPolicyScope,
};
use crate::vault::SecretBytes;
use crate::{BrokerError, Result};
use base64::prelude::*;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use url::Url;
use uuid::Uuid;

const MAX_FILE_READ_BYTES: usize = 4 * 1024 * 1024;
const MAX_STAGED_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ATTACHMENT_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_MIGRATION_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MIGRATION_SNAPSHOT_FILES: usize = 50_000;
const MAX_ARTIFACT_EXPORT_BYTES: usize = 5 * 1024 * 1024;
const MAX_PYTHON_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PYTHON_MEMORY_MIB: u64 = 4096;
const GRANT_LIFETIME_DAYS: i64 = 30;
const APPROVAL_LIFETIME_MINUTES: i64 = 5;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum DesktopEvent {
    #[serde(rename = "files.granted")]
    FileGranted { handle: DesktopFileHandle },
    #[serde(rename = "files.released")]
    FileReleased {
        #[serde(rename = "handleId")]
        handle_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopFileHandle {
    id: String,
    kind: DesktopFileKind,
    name: String,
    #[serde(rename = "absolutePath")]
    absolute_path: PathBuf,
    writable: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DesktopFileKind {
    File,
    Directory,
    SaveTarget,
}

#[derive(Debug, Clone)]
struct DesktopGrant {
    broker_id: GrantId,
    kind: DesktopFileKind,
    fixed_relative: Option<PathBuf>,
    exact_target: Option<PathBuf>,
    writable: bool,
    display_name: String,
    native_grant_id: Option<String>,
}

#[derive(Debug)]
pub struct PreparedBackupCreation {
    source_handle_id: String,
    destination: PathBuf,
    display_name: String,
    staging_root: PathBuf,
    runtime_archive: PathBuf,
    container_path: PathBuf,
}

impl PreparedBackupCreation {
    pub fn runtime_archive(&self) -> &Path {
        &self.runtime_archive
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ArtifactExportRequest<'a> {
    pub desktop_handle_id: &'a str,
    pub project_id: &'a str,
    pub artifact_id: &'a str,
    pub revision_id: &'a str,
    pub object_digest: &'a str,
    pub byte_size: u64,
    pub content_base64: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePreflightPayload {
    intent: WireToolIntent,
    descriptor: WireToolDescriptor,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireToolIntent {
    invocation_id: String,
    run_id: String,
    tool_name: String,
    tool_version: String,
    arguments: Map<String, Value>,
    project_id: Option<String>,
    task_id: Option<String>,
    requested_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireToolDescriptor {
    name: String,
    version: String,
    display_name: String,
    description: String,
    input_schema: Map<String, Value>,
    output_schema: Map<String, Value>,
    effects: BTreeSet<WireEffect>,
    required_grants: BTreeSet<String>,
    default_data_flows: Vec<Value>,
    timeout_seconds: u64,
    cancellable: bool,
    category: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum WireEffect {
    ReadFiles,
    WriteFiles,
    Network,
    ExecuteCode,
    Delete,
    ExternalCommunication,
    Money,
    Install,
    SystemChange,
    UnsandboxedExecution,
}

impl WireEffect {
    fn native(self) -> Effect {
        match self {
            Self::ReadFiles => Effect::ReadFiles,
            Self::WriteFiles => Effect::WriteFiles,
            Self::Network => Effect::NetworkRead,
            Self::ExecuteCode => Effect::ExecuteSandboxed,
            Self::Delete => Effect::Delete,
            Self::ExternalCommunication => Effect::ExternalCommunication,
            Self::Money => Effect::SpendMoney,
            Self::Install => Effect::InstallSoftware,
            Self::SystemChange => Effect::SystemChange,
            Self::UnsandboxedExecution => Effect::ExecuteUnsandboxed,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireApprovalPayload {
    preflight: Value,
    approval: ApprovalProof,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireExecutePayload {
    intent: WireToolIntent,
    preflight: Value,
    #[allow(dead_code)]
    approval: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCancelPayload {
    invocation_id: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePythonArguments {
    source: String,
    #[serde(default)]
    input_files: Vec<Value>,
    timeout_seconds: Option<u64>,
    memory_mb: Option<u64>,
    #[serde(default)]
    execution_mode: WirePythonExecutionMode,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum WirePythonExecutionMode {
    #[default]
    Expression,
    ModuleTest,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpConnectPayload {
    connection: WireMcpConnection,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpConnection {
    connection_id: String,
    #[allow(dead_code)]
    display_name: String,
    transport: String,
    #[allow(dead_code)]
    command: Vec<String>,
    endpoint: Option<String>,
    allowed_origins: Vec<String>,
    oauth: Option<WireMcpOAuth>,
    #[allow(dead_code)]
    credential_ref: Option<String>,
    allowed_tools: Vec<String>,
    allow_private_network: bool,
    #[allow(dead_code)]
    connect_timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpOAuth {
    authorization_endpoint: String,
    token_endpoint: String,
    client_id: String,
    redirect_uri: String,
    scopes: Vec<String>,
    pkce_method: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpListPayload {
    connection_id: String,
    expected_catalog_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpCallPayload {
    connection_id: String,
    invocation_id: String,
    tool_name: String,
    arguments: Map<String, Value>,
    catalog_digest: String,
    approval_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMcpDisconnectPayload {
    connection_id: String,
    reason: String,
}

#[derive(Debug, Clone)]
struct PreparedInvocation {
    intent: WireToolIntent,
    preflight: Value,
    preflight_digest: String,
    approval_id: Option<Uuid>,
    decision: String,
    resolved_handle: Option<String>,
    relative_path: Option<PathBuf>,
}

/// Process-lifetime broker authority. This object deliberately survives every
/// request in one authenticated desktop session.
pub struct BrokerIntegration {
    data_dir: PathBuf,
    grants: FilesystemGrantStore,
    desktop_grants: HashMap<String, DesktopGrant>,
    policy: PolicySet,
    approvals: ApprovalManager,
    prepared: HashMap<String, PreparedInvocation>,
    approved: HashSet<String>,
    cancelled: HashSet<String>,
    active_migration_staging: Option<String>,
    mcp: McpTransportService,
    pending_mcp_approvals: HashMap<String, ApprovalChallenge>,
    native: NativeToolExecutorService,
    document_sandbox: Arc<dyn SandboxBackend>,
    packaged_runtime: Option<PathBuf>,
    audit: AuditStore,
    security: SecurityDatabase,
    security_session_id: String,
}

impl BrokerIntegration {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let security = SecurityDatabase::open(data_dir.join("security").join("security.sqlite"))
            .map_err(security_error)?;
        security.verify_integrity().map_err(security_error)?;
        let security_session_id = Uuid::now_v7().to_string();
        let stored_policies = security
            .active_policies(
                Utc::now().timestamp_millis(),
                Some(&security_session_id),
                None,
            )
            .map_err(security_error)?;
        let mut policy = policy_from_security(stored_policies)?;
        policy.full_freedom = security.permission_mode().map_err(security_error)? == "full-freedom";
        // Search is an explicitly configured outbound capability. Keeping the
        // endpoint out of the renderer and broker defaults prevents a hidden
        // third-party search route; the desktop can opt in through this
        // process environment value after the user has chosen the service.
        let search_endpoint = std::env::var("CUPCAKE_WEB_SEARCH_ENDPOINT")
            .ok()
            .map(|value| {
                Url::parse(&value).map_err(|error| {
                    BrokerError::InvalidConfig(format!(
                        "CUPCAKE_WEB_SEARCH_ENDPOINT is not a valid URL: {error}"
                    ))
                })
            })
            .transpose()?;
        let https = Arc::new(StrictHttpsClient::new(search_endpoint)?);
        #[cfg(windows)]
        let sandbox: Arc<dyn SandboxBackend> = Arc::new(crate::sandbox::WindowsSandbox::default());
        #[cfg(not(windows))]
        let sandbox: Arc<dyn SandboxBackend> = Arc::new(crate::sandbox::DisabledSandbox);
        let packaged_runtime = std::env::var_os("CUPCAKE_RUNTIME_PATH").map(PathBuf::from);
        let native = NativeToolExecutorService::open(
            data_dir,
            policy.clone(),
            find_fixed_executable("git.exe").as_deref(),
            packaged_runtime.as_deref(),
            https,
            sandbox.clone(),
            Arc::new(DisabledLocalModelBackend),
        )?;
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            grants: FilesystemGrantStore::default(),
            desktop_grants: HashMap::new(),
            policy,
            approvals: ApprovalManager::random(),
            prepared: HashMap::new(),
            approved: HashSet::new(),
            cancelled: HashSet::new(),
            active_migration_staging: None,
            mcp: McpTransportService::platform(Default::default())?,
            pending_mcp_approvals: HashMap::new(),
            native,
            document_sandbox: sandbox,
            packaged_runtime,
            audit: AuditStore::open(data_dir.join("security").join("broker-audit.jsonl"))?,
            security,
            security_session_id,
        })
    }

    pub fn native_preflight(&self, value: Value) -> Map<String, Value> {
        let result = serde_json::from_value::<ToolIntent>(value)
            .map_err(BrokerError::from)
            .and_then(|intent| {
                self.native
                    .preflight(&intent, Utc::now().timestamp_millis())
            });
        integration_result(result)
    }

    pub fn native_issue_approval(&self, value: Value) -> Map<String, Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Request {
            intent: ToolIntent,
            preflight: ToolPreflight,
            expires_unix_ms: i64,
        }
        let result = serde_json::from_value::<Request>(value)
            .map_err(BrokerError::from)
            .and_then(|request| {
                self.native.issue_approval(
                    &request.intent,
                    &request.preflight,
                    request.expires_unix_ms,
                )
            });
        integration_result(result)
    }

    pub fn native_execute(&self, value: Value) -> Map<String, Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Request {
            intent: ToolIntent,
            preflight: ToolPreflight,
            approval: Option<ApprovalProof>,
        }
        let result = serde_json::from_value::<Request>(value)
            .map_err(BrokerError::from)
            .and_then(|request| {
                self.native.execute(
                    &request.intent,
                    &request.preflight,
                    request.approval.as_ref(),
                    Utc::now().timestamp_millis(),
                )
            });
        integration_result(result)
    }

    pub fn native_cancel(&self, value: Value) -> Map<String, Value> {
        let result = value
            .get("intentId")
            .and_then(Value::as_str)
            .ok_or_else(|| BrokerError::InvalidConfig("intentId is required".into()))
            .and_then(|value| {
                value
                    .parse()
                    .map_err(|_| BrokerError::InvalidConfig("invalid intentId".into()))
            })
            .and_then(|intent_id| {
                self.native
                    .cancel(intent_id)
                    .map(|()| json!({"cancelled":true}))
            });
        integration_result(result)
    }

    pub fn python_cancellation(&self) -> NativeSandboxCancellation {
        self.native.sandbox_cancellation()
    }

    pub fn permission_mode(&self) -> &'static str {
        if self.policy.full_freedom {
            "full-freedom"
        } else {
            "guarded"
        }
    }

    pub fn set_permission_mode(&mut self, mode: &str) -> Result<Value> {
        if mode != "guarded" && mode != "full-freedom" {
            return Err(BrokerError::InvalidConfig(
                "permission mode must be guarded or full-freedom".into(),
            ));
        }
        self.security
            .set_permission_mode(mode)
            .map_err(security_error)?;
        self.policy.full_freedom = mode == "full-freedom";
        self.native.replace_policy(self.policy.clone())?;
        self.audit.append(AuditEvent {
            category: "security".into(),
            action: "permission_mode_changed".into(),
            outcome: "success".into(),
            fields: json!({ "mode": mode }),
        })?;
        Ok(json!({ "mode": mode }))
    }

    fn persist_challenge(&self, challenge: &ApprovalChallenge, created_unix_ms: i64) -> Result<()> {
        self.security
            .store_pending_approval(&StoredApprovalChallenge {
                approval_id: challenge.approval_id.to_string(),
                nonce: challenge.nonce.clone(),
                intent_digest: challenge.intent_digest.clone(),
                preflight_digest: challenge.preflight_digest.clone(),
                token: challenge.token.clone(),
                created_unix_ms,
                expires_unix_ms: challenge.expires_unix_ms,
            })
            .map_err(security_error)
    }

    /// Consume a desktop-only file capability event. The event is acknowledged
    /// locally and is never forwarded to the Python runtime.
    pub fn handle_desktop_event(&mut self, payload: &Map<String, Value>) -> Result<Value> {
        let event: DesktopEvent = serde_json::from_value(Value::Object(payload.clone()))
            .map_err(|_| BrokerError::InvalidEnvelope("invalid desktop event".into()))?;
        match event {
            DesktopEvent::FileGranted { handle } => self.issue_desktop_grant(handle),
            DesktopEvent::FileReleased { handle_id } => self.release_desktop_grant(&handle_id),
        }
    }

    /// Route the closed set of privileged runtime requests. Unsupported
    /// adapters fail closed, while preflight/approval/cancel and the bounded
    /// native file-read adapter are complete broker-owned operations.
    pub fn dispatch(&mut self, request: RuntimeBrokerRequest) -> Map<String, Value> {
        let result = match request.request_type {
            RuntimeRequestType::ToolPreflight => self.preflight(request.payload),
            RuntimeRequestType::ToolApprovalVerify => self.verify_approval(request.payload),
            RuntimeRequestType::ToolExecute => self.execute(request.payload),
            RuntimeRequestType::ToolCancel => self.cancel(request.payload),
            RuntimeRequestType::McpConnect => self.mcp_connect(request.payload),
            RuntimeRequestType::McpToolsList => self.mcp_list(request.payload),
            RuntimeRequestType::McpToolCall => self.mcp_call(request.payload),
            RuntimeRequestType::McpDisconnect => self.mcp_disconnect(request.payload),
        };
        match result {
            Ok(value) => response_success(value),
            Err(error) => response_failure(error_code(&error), &safe_integration_error(&error)),
        }
    }

    /// Resolve one exact desktop-selected backup without exposing its path to
    /// either the renderer or the Python runtime. Container parsing performs a
    /// second regular-file check and authenticates all payload bytes.
    pub fn resolve_backup_source(&mut self, handle_id: &str) -> Result<PathBuf> {
        validate_handle_id(handle_id)?;
        let desktop = self
            .desktop_grants
            .get(handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::File || desktop.writable {
            return Err(BrokerError::InvalidGrant);
        }
        let relative = desktop
            .fixed_relative
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            relative,
            FilesystemPermission::Read,
            Utc::now().timestamp_millis(),
            None,
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        let metadata = std::fs::symlink_metadata(resolved.as_path())?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(BrokerError::InvalidConfig(
                "backup source is not a regular file".into(),
            ));
        }
        Ok(resolved.as_path().to_path_buf())
    }

    /// Copy one exact desktop file capability into a broker-private staging
    /// directory using bounded streaming I/O. The returned native path is only
    /// for the authenticated broker→runtime pipe and must never be serialized
    /// to the renderer.
    pub fn stage_attachment(&mut self, handle_id: &str) -> Result<StagedAttachment> {
        validate_handle_id(handle_id)?;
        let desktop = self
            .desktop_grants
            .get(handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::File {
            return Err(BrokerError::InvalidGrant);
        }
        let relative = desktop
            .fixed_relative
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            relative,
            FilesystemPermission::Read,
            Utc::now().timestamp_millis(),
            None,
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        let metadata = std::fs::metadata(resolved.as_path())?;
        if !metadata.is_file() || metadata.len() > MAX_STAGED_ATTACHMENT_BYTES {
            return Err(BrokerError::InvalidConfig(
                "attachment is not a bounded regular file".into(),
            ));
        }

        let staging_id = Uuid::now_v7().to_string();
        let directory = self.data_dir.join("broker-ingestion").join(&staging_id);
        std::fs::create_dir_all(&directory)?;
        let mut cleanup = AttachmentStageCleanup::new(directory.clone());
        let partial = directory.join("payload.partial");
        let destination = directory.join(format!("{staging_id}.input"));
        let mut source = File::open(resolved.as_path())?;
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        let mut digest = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        let copy_result = (|| -> Result<()> {
            loop {
                let count = source.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total = total
                    .checked_add(count as u64)
                    .ok_or_else(|| BrokerError::InvalidConfig("attachment is too large".into()))?;
                if total > MAX_STAGED_ATTACHMENT_BYTES {
                    return Err(BrokerError::InvalidConfig(
                        "attachment exceeds staging limit".into(),
                    ));
                }
                digest.update(&buffer[..count]);
                std::io::Write::write_all(&mut output, &buffer[..count])?;
            }
            std::io::Write::flush(&mut output)?;
            output.sync_all()?;
            std::fs::rename(&partial, &destination)?;
            Ok(())
        })();
        buffer.fill(0);
        if let Err(error) = copy_result {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
        if total != metadata.len() {
            return Err(BrokerError::Integrity(
                "attachment changed while it was staged".into(),
            ));
        }
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        let source_metadata = source.metadata()?;
        if !source_metadata.is_file() || source_metadata.len() != total {
            return Err(BrokerError::Integrity(
                "attachment changed while it was staged".into(),
            ));
        }
        let sha256 = hex::encode(digest.finalize());
        let manifest = json!({
            "version": 1,
            "stagingId": staging_id,
            "sourceHandle": handle_id,
            "brokerGrantId": desktop.broker_id.expose_opaque(),
            "byteSize": total,
            "sha256": sha256,
            "payload": destination.file_name().and_then(|value| value.to_str()).unwrap_or("staged.input")
        });
        let manifest_path = directory.join("manifest.json");
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
        self.audit.append(AuditEvent {
            category: "ingestion".into(),
            action: "stage".into(),
            outcome: "ready".into(),
            fields: json!({
                "stagingId": staging_id,
                "sourceHandle": handle_id,
                "byteSize": total,
                "sha256": sha256
            }),
        })?;
        cleanup.disarm();
        Ok(StagedAttachment {
            staging_id,
            payload_path: destination,
            manifest_path,
            byte_size: total,
            sha256,
            display_name: desktop.display_name.clone(),
            source_handle_id: handle_id.to_owned(),
            broker_grant_id: desktop.broker_id.expose_opaque().to_owned(),
        })
    }

    /// Re-bind a staged attachment to the still-live desktop capability and to
    /// both copies' exact digests immediately before it crosses the private
    /// broker/runtime pipe. The runtime independently verifies the staged copy
    /// again before consuming it.
    pub fn revalidate_staged_attachment(&mut self, staged: &StagedAttachment) -> Result<()> {
        validate_handle_id(&staged.staging_id)?;
        validate_handle_id(&staged.source_handle_id)?;
        let desktop = self
            .desktop_grants
            .get(&staged.source_handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::File
            || desktop.broker_id.expose_opaque() != staged.broker_grant_id
        {
            return Err(BrokerError::InvalidGrant);
        }
        let relative = desktop
            .fixed_relative
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            relative,
            FilesystemPermission::Read,
            Utc::now().timestamp_millis(),
            None,
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        verify_regular_file_digest(resolved.as_path(), staged.byte_size, &staged.sha256)?;
        verify_regular_file_digest(&staged.payload_path, staged.byte_size, &staged.sha256)?;

        let manifest_metadata = std::fs::symlink_metadata(&staged.manifest_path)?;
        if !manifest_metadata.is_file()
            || manifest_metadata.file_type().is_symlink()
            || manifest_metadata.len() > MAX_ATTACHMENT_MANIFEST_BYTES
        {
            return Err(BrokerError::Integrity(
                "attachment staging manifest changed".into(),
            ));
        }
        let manifest: Value = serde_json::from_slice(&std::fs::read(&staged.manifest_path)?)?;
        let payload_name = staged
            .payload_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(BrokerError::PathEscape)?;
        if manifest.get("version").and_then(Value::as_u64) != Some(1)
            || manifest.get("stagingId").and_then(Value::as_str) != Some(staged.staging_id.as_str())
            || manifest.get("sourceHandle").and_then(Value::as_str)
                != Some(staged.source_handle_id.as_str())
            || manifest.get("brokerGrantId").and_then(Value::as_str)
                != Some(staged.broker_grant_id.as_str())
            || manifest.get("byteSize").and_then(Value::as_u64) != Some(staged.byte_size)
            || manifest.get("sha256").and_then(Value::as_str) != Some(staged.sha256.as_str())
            || manifest.get("payload").and_then(Value::as_str) != Some(payload_name)
        {
            return Err(BrokerError::Integrity(
                "attachment staging manifest binding is invalid".into(),
            ));
        }
        Ok(())
    }

    pub fn cleanup_staged_attachment(&self, staging_id: &str) -> Result<()> {
        validate_handle_id(staging_id)?;
        let root = self.data_dir.join("broker-ingestion");
        let target = root.join(staging_id);
        if target.parent() != Some(root.as_path()) {
            return Err(BrokerError::PathEscape);
        }
        if target.exists() {
            std::fs::remove_dir_all(target)?;
        }
        Ok(())
    }

    pub fn parse_staged_document(&self, staged: &StagedAttachment) -> Result<Option<Value>> {
        let suffix = Path::new(&staged.display_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_ascii_lowercase()));
        let Some(suffix) = suffix else {
            return Ok(None);
        };
        if !matches!(
            suffix.as_str(),
            ".pdf" | ".docx" | ".odt" | ".pptx" | ".xlsx" | ".html" | ".xhtml"
        ) {
            return Ok(None);
        }
        let executable = self.packaged_runtime.as_deref().ok_or_else(|| {
            BrokerError::SandboxUnavailable("packaged document worker is unavailable".into())
        })?;
        let stage = staged
            .payload_path
            .parent()
            .ok_or(BrokerError::PathEscape)?;
        let output_name = format!("{}.json", staged.staging_id);
        let output_path = stage.join(&output_name);
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output_path)?
            .sync_all()?;
        let request_id = Uuid::now_v7().to_string();
        let deadline = (Utc::now() + Duration::seconds(180)).timestamp_millis();
        let request = json!({
            "version": 1,
            "kind": "document.parse",
            "request_id": request_id,
            "stage_token": staged.staging_id,
            "payload": {
                "input_name": staged.payload_path.file_name().and_then(|value| value.to_str()).ok_or(BrokerError::PathEscape)?,
                "output_name": output_name,
                "source_name": staged.display_name,
                "source_suffix": suffix,
                "input_size": staged.byte_size,
                "input_sha256": staged.sha256,
                "limits": {
                    "max_input_bytes": MAX_STAGED_ATTACHMENT_BYTES,
                    "max_output_bytes": 64 * 1024 * 1024,
                    "max_text_characters": 16 * 1024 * 1024,
                    "max_pages": 10_000,
                    "max_entries": 100_000,
                    "deadline_unix_ms": deadline
                }
            }
        });
        let request_body = canonical_json(&request)?.into_bytes();
        let mut request_frame = Vec::with_capacity(request_body.len() + 4);
        request_frame.extend_from_slice(&(request_body.len() as u32).to_be_bytes());
        request_frame.extend_from_slice(&request_body);
        std::fs::write(stage.join("document-request.frame"), request_frame)?;
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join("document-response.frame"))?
            .sync_all()?;
        let plan = ResolvedProcessPlan {
            execution_id: format!("document-{}", staged.staging_id),
            executable: executable.to_path_buf(),
            arguments: vec![
                "--document-worker".into(),
                "--stage-root".into(),
                ".".into(),
                "--worker-transport".into(),
                "staged".into(),
            ],
            working_directory: stage.to_path_buf(),
            environment: Default::default(),
            network: NetworkPolicy::Denied,
            network_origins: Default::default(),
            limits: ResourceLimits {
                timeout_ms: 180_000,
                max_output_bytes: 1024 * 1024,
                max_memory_bytes: Some(2 * 1024 * 1024 * 1024),
                max_cpu_seconds: Some(180),
            },
            read_only_root: false,
        };
        let process = self.document_sandbox.execute(&plan)?;
        if process.state != ProcessState::Completed || process.exit_code != Some(0) {
            return Err(BrokerError::SandboxUnavailable(
                "document worker did not complete successfully".into(),
            ));
        }
        let response_frame = std::fs::read(stage.join("document-response.frame"))?;
        let response = decode_single_json_frame(&response_frame, 1024 * 1024)?;
        if response.get("kind").and_then(Value::as_str) != Some("document.parse.complete")
            || response.get("request_id").and_then(Value::as_str) != Some(request_id.as_str())
            || response.get("stage_token").and_then(Value::as_str)
                != Some(staged.staging_id.as_str())
        {
            return Err(BrokerError::Integrity(
                "document worker response binding is invalid".into(),
            ));
        }
        let result = response
            .get("result")
            .and_then(Value::as_object)
            .ok_or_else(|| BrokerError::Integrity("document worker result is missing".into()))?;
        let declared_size = result
            .get("output_size")
            .and_then(Value::as_u64)
            .ok_or_else(|| BrokerError::Integrity("document output size is missing".into()))?;
        let output = std::fs::read(&output_path)?;
        let output_digest = hex::encode(Sha256::digest(&output));
        if output.len() as u64 != declared_size
            || result.get("output_sha256").and_then(Value::as_str) != Some(output_digest.as_str())
        {
            return Err(BrokerError::Integrity(
                "document worker output digest mismatch".into(),
            ));
        }
        let document: Value = serde_json::from_slice(&output)?;
        Ok(Some(document))
    }

    /// Snapshot a selected legacy directory into broker-private immutable
    /// staging. Renderer release may then revoke the original dialog handle;
    /// preview and execute continue from the snapshot only.
    pub fn stage_migration_snapshot(&mut self, handle_id: &str) -> Result<StagedMigration> {
        validate_handle_id(handle_id)?;
        if let Some(previous) = self.active_migration_staging.take() {
            let _ = self.remove_migration_staging(&previous);
        }
        let desktop = self
            .desktop_grants
            .get(handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::Directory {
            return Err(BrokerError::InvalidGrant);
        }
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            Path::new("."),
            FilesystemPermission::List,
            Utc::now().timestamp_millis(),
            None,
        )?;
        resolved.revalidate()?;
        let source_root = resolved.as_path().canonicalize()?;
        let staging_id = Uuid::now_v7().to_string();
        let staging_root = self.data_dir.join("broker-migration").join(&staging_id);
        let snapshot_root = staging_root.join("source");
        std::fs::create_dir_all(&snapshot_root)?;
        let mut entries = Vec::new();
        let mut total_bytes = 0_u64;
        let copy_result = copy_migration_tree(
            &source_root,
            &source_root,
            &snapshot_root,
            &mut entries,
            &mut total_bytes,
        );
        if let Err(error) = copy_result {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(error);
        }
        entries.sort_by(|left, right| {
            left.get("path")
                .and_then(Value::as_str)
                .cmp(&right.get("path").and_then(Value::as_str))
        });
        let manifest = json!({
            "version": 1,
            "stagingId": staging_id,
            "fileCount": entries.len(),
            "totalBytes": total_bytes,
            "entries": entries
        });
        let manifest_digest = digest_json(&manifest)?;
        let manifest_path = staging_root.join("manifest.json");
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
        self.active_migration_staging = Some(staging_id.clone());
        self.audit.append(AuditEvent {
            category: "migration".into(),
            action: "snapshot".into(),
            outcome: "ready".into(),
            fields: json!({
                "stagingId": staging_id,
                "fileCount": entries.len(),
                "totalBytes": total_bytes,
                "manifestSha256": manifest_digest
            }),
        })?;
        Ok(StagedMigration {
            staging_id,
            snapshot_path: snapshot_root,
            manifest_path,
            manifest_sha256: manifest_digest,
        })
    }

    pub fn cleanup_migration_snapshot(&mut self) -> Result<bool> {
        let Some(staging_id) = self.active_migration_staging.take() else {
            return Ok(false);
        };
        self.remove_migration_staging(&staging_id)?;
        Ok(true)
    }

    /// Complete an explicit artifact save through the exact opaque desktop
    /// capability. Artifact bytes come from the authenticated runtime response,
    /// never from renderer state, and are bound to its immutable object digest.
    pub fn export_artifact_to_desktop_target(
        &mut self,
        request: ArtifactExportRequest<'_>,
    ) -> Result<Value> {
        let ArtifactExportRequest {
            desktop_handle_id,
            project_id,
            artifact_id,
            revision_id,
            object_digest,
            byte_size,
            content_base64,
        } = request;
        validate_handle_id(desktop_handle_id)?;
        for (label, value) in [
            ("project", project_id),
            ("artifact", artifact_id),
            ("revision", revision_id),
        ] {
            if value.is_empty()
                || value.len() > 255
                || value.chars().any(|character| character.is_control())
            {
                return Err(BrokerError::InvalidConfig(format!(
                    "invalid {label} identifier"
                )));
            }
        }
        if object_digest.len() != 64 || !object_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(BrokerError::Integrity(
                "artifact object digest is invalid".into(),
            ));
        }
        let content = BASE64_STANDARD
            .decode(content_base64)
            .map_err(|_| BrokerError::Integrity("artifact content encoding is invalid".into()))?;
        if content.len() > MAX_ARTIFACT_EXPORT_BYTES || content.len() as u64 != byte_size {
            return Err(BrokerError::Integrity(
                "artifact content size does not match its immutable revision".into(),
            ));
        }
        let content_digest = hex::encode(Sha256::digest(&content));
        if !content_digest.eq_ignore_ascii_case(object_digest) {
            return Err(BrokerError::Integrity(
                "artifact content does not match its immutable revision".into(),
            ));
        }

        let desktop = self
            .desktop_grants
            .get(desktop_handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::SaveTarget || !desktop.writable {
            return Err(BrokerError::InvalidGrant);
        }
        let relative = desktop
            .fixed_relative
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            relative,
            FilesystemPermission::Create,
            Utc::now().timestamp_millis(),
            Some(project_id),
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;

        let mut created_target = false;
        let write_result = (|| -> Result<String> {
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(resolved.as_path())?;
            created_target = true;
            file.write_all(&content)?;
            file.flush()?;
            file.sync_all()?;
            file.seek(SeekFrom::Start(0))?;
            let mut written_digest = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                written_digest.update(&buffer[..count]);
            }
            buffer.fill(0);
            let written_digest = hex::encode(written_digest.finalize());
            if !written_digest.eq_ignore_ascii_case(object_digest) {
                return Err(BrokerError::Integrity(
                    "artifact export failed its post-write verification".into(),
                ));
            }
            Ok(written_digest)
        })();

        let (outcome, error) = match &write_result {
            Ok(_) => ("success", None),
            Err(_) => ("failed", Some("artifact export rejected")),
        };
        if write_result.is_err() && created_target {
            let _ = std::fs::remove_file(resolved.as_path());
        }
        self.audit.append(AuditEvent {
            category: "artifact".into(),
            action: "export".into(),
            outcome: outcome.into(),
            fields: json!({
                "artifactId": artifact_id,
                "revisionId": revision_id,
                "projectId": project_id,
                "brokerGrantId": desktop.broker_id.expose_opaque(),
                "byteSize": byte_size,
                "error": error
            }),
        })?;
        let verified_digest = write_result?;
        Ok(json!({
            "artifactId": artifact_id,
            "revisionId": revision_id,
            "fileName": desktop.display_name,
            "byteSize": byte_size,
            "sha256": verified_digest
        }))
    }

    /// Bind a backup operation to one exact renderer-selected save capability
    /// and allocate a private archive destination for the runtime. The selected
    /// native path never crosses the authenticated broker/runtime boundary.
    pub fn begin_backup_creation(
        &mut self,
        desktop_handle_id: &str,
    ) -> Result<PreparedBackupCreation> {
        validate_handle_id(desktop_handle_id)?;
        let desktop = self
            .desktop_grants
            .get(desktop_handle_id)
            .cloned()
            .ok_or(BrokerError::InvalidGrant)?;
        if desktop.kind != DesktopFileKind::SaveTarget || !desktop.writable {
            return Err(BrokerError::InvalidGrant);
        }
        let relative = desktop
            .fixed_relative
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let permission = if desktop.exact_target.as_deref().is_some_and(Path::exists) {
            FilesystemPermission::Modify
        } else {
            FilesystemPermission::Create
        };
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            relative,
            permission,
            Utc::now().timestamp_millis(),
            None,
        )?;
        resolved.revalidate()?;
        validate_exact_target(&desktop, &resolved)?;
        let data_root = self.data_dir.canonicalize()?;
        if resolved.as_path().starts_with(data_root) {
            return Err(BrokerError::PermissionDenied(
                "backup destination cannot be inside private application data".into(),
            ));
        }

        let staging_id = Uuid::now_v7().to_string();
        let staging_root = self.data_dir.join("broker-backup").join(&staging_id);
        std::fs::create_dir_all(&staging_root)?;
        Ok(PreparedBackupCreation {
            source_handle_id: desktop_handle_id.to_owned(),
            destination: resolved.as_path().to_path_buf(),
            display_name: desktop.display_name,
            runtime_archive: staging_root.join("runtime.cupcake-runtime.zip"),
            container_path: staging_root.join("verified.cupcakebak"),
            staging_root,
        })
    }

    /// Wrap the runtime snapshot and broker security database with the
    /// DPAPI-protected profile key, then copy and atomically replace the exact
    /// destination selected by the user. Only a path-free receipt is returned.
    pub fn complete_backup_creation(
        &mut self,
        prepared: PreparedBackupCreation,
        runtime_manifest: &Value,
        profile_key: &SecretBytes,
    ) -> Result<Value> {
        let result = (|| -> Result<Value> {
            let runtime_metadata = std::fs::symlink_metadata(&prepared.runtime_archive)?;
            if !runtime_metadata.is_file() || runtime_metadata.file_type().is_symlink() {
                return Err(BrokerError::Integrity(
                    "runtime backup archive is not a regular broker-staged file".into(),
                ));
            }
            let product_version = runtime_manifest
                .get("product_version")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    BrokerError::Integrity("runtime backup product version is missing".into())
                })?;
            let identity = BackupIdentity {
                backup_id: Uuid::now_v7(),
                product_version: product_version.to_owned(),
            };
            let created_at = Utc::now();
            let inspection = create_coordinated_backup(
                &prepared.container_path,
                &prepared.runtime_archive,
                runtime_manifest,
                &self.security,
                &prepared.staging_root,
                identity,
                created_at,
                profile_key,
                BackupProtectionInput::SameUserDpapi,
                None,
            )?;
            let (expected_digest, expected_size) = digest_regular_file(&prepared.container_path)?;

            let desktop = self
                .desktop_grants
                .get(&prepared.source_handle_id)
                .cloned()
                .ok_or(BrokerError::InvalidGrant)?;
            if desktop.kind != DesktopFileKind::SaveTarget || !desktop.writable {
                return Err(BrokerError::InvalidGrant);
            }
            let relative = desktop
                .fixed_relative
                .as_deref()
                .ok_or(BrokerError::InvalidGrant)?;
            let destination_exists = prepared.destination.exists();
            let permission = if destination_exists {
                FilesystemPermission::Modify
            } else {
                FilesystemPermission::Create
            };
            let resolved = self.grants.resolve(
                &desktop.broker_id,
                relative,
                permission,
                Utc::now().timestamp_millis(),
                None,
            )?;
            resolved.revalidate()?;
            validate_exact_target(&desktop, &resolved)?;
            if resolved.as_path() != prepared.destination {
                return Err(BrokerError::PathEscape);
            }
            atomic_install_verified_file(
                &prepared.container_path,
                resolved.as_path(),
                &expected_digest,
                expected_size,
                destination_exists,
            )?;
            let (installed_digest, installed_size) = digest_regular_file(resolved.as_path())?;
            if installed_size != expected_size || installed_digest != expected_digest {
                return Err(BrokerError::Integrity(
                    "installed backup failed its post-write verification".into(),
                ));
            }
            self.audit.append(AuditEvent {
                category: "backup".into(),
                action: "create".into(),
                outcome: "success".into(),
                fields: json!({
                    "backupId": inspection.manifest.backup.backup_id,
                    "brokerGrantId": desktop.broker_id.expose_opaque(),
                    "byteSize": installed_size,
                    "sha256": installed_digest,
                    "verifiedPayloads": inspection.verified_payloads
                }),
            })?;
            Ok(json!({
                "backupId": inspection.manifest.backup.backup_id,
                "fileName": prepared.display_name,
                "byteSize": installed_size,
                "sha256": installed_digest,
                "verifiedPayloads": inspection.verified_payloads,
                "totalPayloadBytes": inspection.total_payload_bytes,
                "protection": "windows-dpapi-current-user",
                "createdAt": created_at.to_rfc3339_opts(SecondsFormat::Millis, true)
            }))
        })();
        let _ = std::fs::remove_dir_all(&prepared.staging_root);
        result
    }

    pub fn abort_backup_creation(&self, prepared: &PreparedBackupCreation) {
        let _ = std::fs::remove_dir_all(&prepared.staging_root);
    }

    fn remove_migration_staging(&self, staging_id: &str) -> Result<()> {
        validate_handle_id(staging_id)?;
        let root = self.data_dir.join("broker-migration");
        let target = root.join(staging_id);
        if target.parent() != Some(root.as_path()) {
            return Err(BrokerError::PathEscape);
        }
        if target.exists() {
            std::fs::remove_dir_all(target)?;
        }
        Ok(())
    }

    fn issue_desktop_grant(&mut self, handle: DesktopFileHandle) -> Result<Value> {
        validate_handle_id(&handle.id)?;
        validate_display_name(&handle.name)?;
        if handle.kind == DesktopFileKind::SaveTarget && !handle.writable {
            return Err(BrokerError::InvalidConfig(
                "save target must be writable".into(),
            ));
        }

        let (root, fixed_relative, exact_target) = match handle.kind {
            DesktopFileKind::Directory => {
                if !handle.absolute_path.is_dir() {
                    return Err(BrokerError::InvalidConfig(
                        "directory grant target is not a directory".into(),
                    ));
                }
                (handle.absolute_path.clone(), None, None)
            }
            DesktopFileKind::File => {
                if !handle.absolute_path.is_file() {
                    return Err(BrokerError::InvalidConfig(
                        "file grant target is not a file".into(),
                    ));
                }
                let (parent, relative) = parent_and_name(&handle.absolute_path)?;
                let exact = handle.absolute_path.canonicalize()?;
                (parent, relative, Some(exact))
            }
            DesktopFileKind::SaveTarget => {
                if handle.absolute_path.exists() && !handle.absolute_path.is_file() {
                    return Err(BrokerError::InvalidConfig(
                        "save target has an invalid type".into(),
                    ));
                }
                let (parent, relative) = parent_and_name(&handle.absolute_path)?;
                let canonical_parent = parent.canonicalize()?;
                let exact =
                    canonical_parent.join(relative.as_deref().ok_or(BrokerError::PathEscape)?);
                (parent, relative, Some(exact))
            }
        };

        let mut permissions: BTreeSet<_> = [FilesystemPermission::Read, FilesystemPermission::List]
            .into_iter()
            .collect();
        if handle.writable {
            permissions.extend([
                FilesystemPermission::Create,
                FilesystemPermission::Modify,
                FilesystemPermission::Delete,
            ]);
        }
        let expires = (Utc::now() + Duration::days(GRANT_LIFETIME_DAYS)).timestamp_millis();
        let broker_id =
            self.grants
                .issue(&root, permissions.clone(), GrantScope::Session, expires)?;

        if let Some(previous) = self.desktop_grants.remove(&handle.id) {
            self.grants.revoke(&previous.broker_id);
            if let Some(native_id) = previous.native_grant_id {
                let _ = self.native.revoke_filesystem_grant(&native_id);
            }
        }
        let native_grant_id = if handle.kind == DesktopFileKind::Directory {
            Some(self.native.issue_filesystem_grant(
                &root,
                permissions.clone(),
                GrantScope::Session,
                expires,
            )?)
        } else {
            None
        };
        let public_id = broker_id.expose_opaque().to_owned();
        self.security
            .issue_grant(&SecurityGrant {
                id: public_id.clone(),
                resource_id: public_id.clone(),
                permissions: permissions
                    .iter()
                    .map(|permission| format!("{permission:?}").to_ascii_lowercase())
                    .collect(),
                scope: SecurityGrantScope::Session {
                    session_id: self.security_session_id.clone(),
                },
                created_unix_ms: Utc::now().timestamp_millis(),
                expires_unix_ms: Some(expires),
            })
            .map_err(security_error)?;
        self.desktop_grants.insert(
            handle.id.clone(),
            DesktopGrant {
                broker_id,
                kind: handle.kind,
                fixed_relative,
                exact_target,
                writable: handle.writable,
                display_name: handle.name,
                native_grant_id: native_grant_id.clone(),
            },
        );
        self.audit.append(AuditEvent {
            category: "grant".into(),
            action: "filesystem.issue".into(),
            outcome: "allowed".into(),
            fields: json!({
                "desktopHandleId": handle.id,
                "brokerGrantId": public_id,
                "kind": format!("{:?}", handle.kind).to_ascii_lowercase(),
                "writable": handle.writable
            }),
        })?;
        Ok(json!({"accepted": true, "grantId": public_id, "nativeGrantId": native_grant_id}))
    }

    fn release_desktop_grant(&mut self, handle_id: &str) -> Result<Value> {
        validate_handle_id(handle_id)?;
        let durable_id = self
            .desktop_grants
            .get(handle_id)
            .map(|grant| grant.broker_id.expose_opaque().to_owned());
        let revoked = self
            .desktop_grants
            .remove(handle_id)
            .map(|grant| {
                if let Some(native_id) = grant.native_grant_id {
                    let _ = self.native.revoke_filesystem_grant(&native_id);
                }
                self.grants.revoke(&grant.broker_id)
            })
            .unwrap_or(false);
        if let Some(durable_id) = durable_id {
            self.security
                .revoke_grant(&durable_id, Utc::now().timestamp_millis())
                .map_err(security_error)?;
        }
        self.audit.append(AuditEvent {
            category: "grant".into(),
            action: "filesystem.revoke".into(),
            outcome: if revoked { "revoked" } else { "not_found" }.into(),
            fields: json!({"desktopHandleId": handle_id}),
        })?;
        Ok(json!({"released": revoked}))
    }

    fn preflight(&mut self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WirePreflightPayload = serde_json::from_value(Value::Object(payload))?;
        validate_intent_and_descriptor(&parsed.intent, &parsed.descriptor)?;
        if parsed.intent.tool_name == "python.run" {
            parse_python_arguments(&parsed.intent.arguments)?;
        }
        let native_descriptor = catalog_descriptor(&parsed.descriptor.name)
            .ok_or_else(|| BrokerError::NotFound(format!("tool {}", parsed.descriptor.name)))?;
        let declared_effects: BTreeSet<_> = parsed
            .descriptor
            .effects
            .iter()
            .copied()
            .map(WireEffect::native)
            .collect();
        if declared_effects != native_descriptor.effects {
            return Err(BrokerError::PermissionDenied(
                "tool effects differ from the broker registry".into(),
            ));
        }

        let (resolved_resources, resolved_handle, relative_path) =
            self.resolve_preflight_resources(&parsed.intent, &parsed.descriptor)?;
        let mut overall = "allow";
        for effect in &declared_effects {
            let resources: Vec<Option<String>> = if resolved_resources.is_empty() {
                vec![None]
            } else {
                resolved_resources.iter().cloned().map(Some).collect()
            };
            for resource_id in resources {
                let key = ScopeKey {
                    tool_id: parsed.descriptor.name.clone(),
                    effect: *effect,
                    resource_id,
                };
                match self.policy.evaluate(&key) {
                    PolicyDecision::Deny(_) => overall = "deny",
                    PolicyDecision::Ask(_) if overall != "deny" => overall = "ask",
                    PolicyDecision::Allow(_) => {}
                    PolicyDecision::Ask(_) => {}
                }
            }
        }

        let schema_digest = digest_json(&json!({
            "input": parsed.descriptor.input_schema,
            "output": parsed.descriptor.output_schema
        }))?;
        let mut effects: Vec<_> = parsed
            .descriptor
            .effects
            .iter()
            .map(|effect| serde_json::to_value(effect).unwrap_or(Value::Null))
            .collect();
        effects.sort_by_key(|value| value.as_str().unwrap_or_default().to_owned());
        let intent_digest = digest_json(&json!({
            "invocation_id": parsed.intent.invocation_id,
            "run_id": parsed.intent.run_id,
            "task_id": parsed.intent.task_id,
            "project_id": parsed.intent.project_id,
            "tool": format!("{}@{}", parsed.descriptor.name, parsed.descriptor.version),
            "schema_digest": schema_digest,
            "arguments": parsed.intent.arguments,
            "resolved_resources": resolved_resources,
            "effects": effects,
            "disclosures": parsed.descriptor.default_data_flows,
        }))?;
        let now = Utc::now();
        let requires_fresh = !self.policy.full_freedom
            && declared_effects
                .iter()
                .any(|effect| effect.requires_fresh_approval());
        let preflight = json!({
            "invocation_id": parsed.intent.invocation_id,
            "descriptor_identity": format!("{}@{}", parsed.descriptor.name, parsed.descriptor.version),
            "schema_digest": schema_digest,
            "resolved_resources": resolved_resources,
            "effects": effects,
            "disclosures": parsed.descriptor.default_data_flows,
            "decision": overall,
            "requires_fresh_approval": requires_fresh,
            "intent_digest": intent_digest,
            "created_at": now.to_rfc3339_opts(SecondsFormat::Millis, true),
        });
        let preflight_digest = digest_json(&preflight)?;
        let challenge = if overall == "ask" || requires_fresh {
            let challenge = self.approvals.issue(
                intent_digest.clone(),
                preflight_digest.clone(),
                (now + Duration::minutes(APPROVAL_LIFETIME_MINUTES)).timestamp_millis(),
            );
            self.persist_challenge(&challenge, now.timestamp_millis())?;
            Some(challenge)
        } else {
            None
        };
        let approval_id = challenge.as_ref().map(|value| value.approval_id);
        self.prepared.insert(
            parsed.intent.invocation_id.clone(),
            PreparedInvocation {
                intent: parsed.intent.clone(),
                preflight: preflight.clone(),
                preflight_digest,
                approval_id,
                decision: overall.into(),
                resolved_handle,
                relative_path,
            },
        );
        self.audit.append(AuditEvent {
            category: "tool".into(),
            action: "preflight".into(),
            outcome: overall.into(),
            fields: json!({
                "invocationId": parsed.intent.invocation_id,
                "runId": parsed.intent.run_id,
                "taskId": parsed.intent.task_id,
                "tool": parsed.descriptor.name,
                "intentDigest": intent_digest,
                "resources": resolved_resources,
                "effects": effects,
            }),
        })?;
        Ok(json!({"preflight": preflight, "approvalChallenge": challenge}))
    }

    fn verify_approval(&mut self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireApprovalPayload = serde_json::from_value(Value::Object(payload))?;
        let invocation_id = parsed
            .preflight
            .get("invocation_id")
            .and_then(Value::as_str)
            .ok_or(BrokerError::InvalidApproval)?;
        let prepared = self
            .prepared
            .get(invocation_id)
            .ok_or(BrokerError::InvalidApproval)?;
        if parsed.preflight != prepared.preflight
            || parsed.approval.intent_digest
                != prepared
                    .preflight
                    .get("intent_digest")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            || parsed.approval.preflight_digest != prepared.preflight_digest
        {
            return Err(BrokerError::InvalidApproval);
        }
        self.approvals
            .redeem(&parsed.approval, Utc::now().timestamp_millis())?;
        self.security
            .consume_approval(
                &parsed.approval.approval_id.to_string(),
                &parsed.approval.nonce,
                &parsed.approval.intent_digest,
                &parsed.approval.preflight_digest,
                &parsed.approval.token,
                Utc::now().timestamp_millis(),
            )
            .map_err(security_error)?;
        self.approved.insert(invocation_id.to_owned());
        self.audit.append(AuditEvent {
            category: "approval".into(),
            action: "consume".into(),
            outcome: "approved".into(),
            fields: json!({"invocationId": invocation_id, "approvalId": parsed.approval.approval_id}),
        })?;
        Ok(json!({"approved": true, "invocationId": invocation_id}))
    }

    fn execute(&mut self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireExecutePayload = serde_json::from_value(Value::Object(payload))?;
        if self.cancelled.contains(&parsed.intent.invocation_id) {
            return Ok(tool_result(
                &parsed.intent.invocation_id,
                "cancelled",
                Value::Null,
                None,
            ));
        }
        let prepared = self
            .prepared
            .get(&parsed.intent.invocation_id)
            .ok_or_else(|| BrokerError::InvalidConfig("tool has not been preflighted".into()))?
            .clone();
        if parsed.preflight != prepared.preflight || !same_intent(&parsed.intent, &prepared.intent)?
        {
            return Err(BrokerError::Integrity(
                "execution differs from its preflight".into(),
            ));
        }
        if prepared.decision == "deny" {
            return Err(BrokerError::PermissionDenied(
                "tool policy denied this invocation".into(),
            ));
        }
        let outer_approval_consumed = if prepared.decision == "ask" {
            if !self.approved.remove(&parsed.intent.invocation_id) {
                return Err(BrokerError::InvalidApproval);
            }
            true
        } else {
            false
        };

        let result = match parsed.intent.tool_name.as_str() {
            "files.read" => tool_result(
                &parsed.intent.invocation_id,
                "succeeded",
                self.execute_file_read(&prepared)?,
                None,
            ),
            "python.run" => self.execute_python_continuation(&prepared, outer_approval_consumed)?,
            _ => {
                return Err(BrokerError::InvalidConfig(
                    "privileged execution adapter is not connected for this tool".into(),
                ))
            }
        };
        let outcome = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("failed");
        self.audit.append(AuditEvent {
            category: "tool".into(),
            action: "execute".into(),
            outcome: outcome.into(),
            fields: json!({
                "invocationId": parsed.intent.invocation_id,
                "runId": parsed.intent.run_id,
                "tool": parsed.intent.tool_name
            }),
        })?;
        self.prepared.remove(&parsed.intent.invocation_id);
        Ok(result)
    }

    fn execute_python_continuation(
        &self,
        prepared: &PreparedInvocation,
        outer_approval_consumed: bool,
    ) -> Result<Value> {
        let arguments = parse_python_arguments(&prepared.intent.arguments)?;
        let started_at = Utc::now();
        let continuation_id = Uuid::parse_str(&prepared.intent.invocation_id).map_err(|_| {
            BrokerError::InvalidConfig("python.run invocation ID must be a UUID".into())
        })?;
        let stage_root = self.data_dir.join("runtime").join("task-continuations");
        std::fs::create_dir_all(&stage_root)?;
        let stage = stage_root.join(continuation_id.to_string());
        std::fs::create_dir(&stage)?;
        let cleanup = IntegrationStageCleanup(stage.clone());
        let script_relative = PathBuf::from("task.py");
        let script_path = stage.join(&script_relative);
        let mut script = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&script_path)?;
        script.write_all(arguments.source.as_bytes())?;
        script.sync_all()?;
        drop(script);
        sync_directory(&stage)?;

        let now_unix_ms = Utc::now().timestamp_millis();
        let grant_id = self.native.issue_filesystem_grant(
            &stage,
            [FilesystemPermission::Read].into_iter().collect(),
            GrantScope::Once,
            now_unix_ms.saturating_add(
                i64::try_from(
                    arguments
                        .timeout_seconds
                        .saturating_add(60)
                        .saturating_mul(1_000),
                )
                .unwrap_or(i64::MAX),
            ),
        )?;
        let grant_cleanup = NativeGrantCleanup {
            native: &self.native,
            grant_id: grant_id.clone(),
        };
        let limits = ResourceLimits {
            timeout_ms: arguments.timeout_seconds.saturating_mul(1_000),
            max_output_bytes: 1024 * 1024,
            max_memory_bytes: Some(arguments.memory_mb.saturating_mul(1024 * 1024)),
            max_cpu_seconds: Some(arguments.timeout_seconds),
        };
        let native_intent = ToolIntent {
            intent_id: continuation_id,
            tool_id: "native.sandbox.python".into(),
            tool_version: "1.0.0".into(),
            arguments: json!({
                "grantId": grant_id,
                "scriptRelative": script_relative,
                "projectId": prepared.intent.project_id,
                "executionMode": arguments.execution_mode,
            }),
            effects: [Effect::ExecuteSandboxed].into_iter().collect(),
            grant_ids: [grant_cleanup.grant_id.clone()].into_iter().collect(),
            data_destinations: [NativeDataDestination::LocalOnly].into_iter().collect(),
            limits,
            user_visible_summary: "Run the approved task code in the offline Python sandbox".into(),
        };
        match self.policy.evaluate(&ScopeKey {
            tool_id: native_intent.tool_id.clone(),
            effect: Effect::ExecuteSandboxed,
            resource_id: Some(grant_cleanup.grant_id.clone()),
        }) {
            PolicyDecision::Deny(_) => {
                return Err(BrokerError::PermissionDenied(
                    "native tool policy denied this operation".into(),
                ))
            }
            PolicyDecision::Ask(_) if !outer_approval_consumed => {
                return Err(BrokerError::InvalidApproval)
            }
            PolicyDecision::Allow(_) | PolicyDecision::Ask(_) => {}
        }
        let native_preflight = self.native.preflight(&native_intent, now_unix_ms)?;
        let native_approval = if native_preflight.requires_approval {
            if !outer_approval_consumed {
                return Err(BrokerError::InvalidApproval);
            }
            let challenge = self.native.issue_approval(
                &native_intent,
                &native_preflight,
                now_unix_ms.saturating_add(
                    i64::try_from(
                        arguments
                            .timeout_seconds
                            .saturating_add(60)
                            .saturating_mul(1_000),
                    )
                    .unwrap_or(i64::MAX),
                ),
            )?;
            Some(ApprovalProof::from(&challenge))
        } else {
            None
        };
        let native_result = self.native.execute(
            &native_intent,
            &native_preflight,
            native_approval.as_ref(),
            Utc::now().timestamp_millis(),
        )?;
        let output = python_continuation_result(
            &prepared.intent,
            continuation_id,
            started_at,
            native_result,
        );
        drop(grant_cleanup);
        drop(cleanup);
        Ok(output)
    }

    fn cancel(&mut self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireCancelPayload = serde_json::from_value(Value::Object(payload))?;
        if parsed.invocation_id.is_empty() || parsed.reason.trim().is_empty() {
            return Err(BrokerError::InvalidConfig(
                "cancellation identity and reason are required".into(),
            ));
        }
        self.cancelled.insert(parsed.invocation_id.clone());
        if let Some(prepared) = self.prepared.remove(&parsed.invocation_id) {
            if let Some(challenge_id) = prepared.approval_id {
                self.approvals.revoke(challenge_id);
            }
        }
        self.audit.append(AuditEvent {
            category: "tool".into(),
            action: "cancel".into(),
            outcome: "cancelled".into(),
            fields: json!({"invocationId": parsed.invocation_id}),
        })?;
        Ok(json!({"cancelled": true, "invocationId": parsed.invocation_id}))
    }

    fn mcp_connect(&self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireMcpConnectPayload = serde_json::from_value(Value::Object(payload))?;
        let connection = parsed.connection;
        let config = match connection.transport.as_str() {
            "stdio" => {
                // A model/runtime cannot nominate an arbitrary executable.
                // Local packages must first be installed into broker-owned
                // metadata; that install route is intentionally separate.
                return Err(BrokerError::PermissionDenied(
                    "local MCP requires a broker-installed package grant".into(),
                ));
            }
            "streamable_http" => {
                if connection.allow_private_network {
                    return Err(BrokerError::PermissionDenied(
                        "private-network MCP requires an exact interactive grant".into(),
                    ));
                }
                let endpoint =
                    Url::parse(connection.endpoint.as_deref().ok_or_else(|| {
                        BrokerError::InvalidConfig("MCP endpoint missing".into())
                    })?)?;
                let origins = connection.allowed_origins.into_iter().collect();
                let oauth = connection
                    .oauth
                    .map(|value| {
                        if value.pkce_method != "S256" {
                            return Err(BrokerError::InvalidConfig(
                                "MCP OAuth requires PKCE S256".into(),
                            ));
                        }
                        Ok(Box::new(OAuthPkceConfig {
                            client_id: value.client_id,
                            authorization_endpoint: Url::parse(&value.authorization_endpoint)?,
                            token_endpoint: Url::parse(&value.token_endpoint)?,
                            redirect_uri: Url::parse(&value.redirect_uri)?,
                            scopes: value.scopes.into_iter().collect(),
                        }))
                    })
                    .transpose()?;
                McpTransportConfig::StreamableHttp {
                    endpoint,
                    allowed_origins: origins,
                    oauth,
                }
            }
            _ => {
                return Err(BrokerError::InvalidConfig(
                    "unsupported MCP transport".into(),
                ))
            }
        };
        match self.mcp.register(&connection.connection_id, config) {
            Ok(()) | Err(BrokerError::Duplicate(_)) => {}
            Err(error) => return Err(error),
        }
        let snapshot = self.mcp.connect(&connection.connection_id)?;
        for tool in connection.allowed_tools {
            self.mcp.allow_tool(&connection.connection_id, &tool)?;
        }
        self.audit.append(AuditEvent {
            category: "mcp".into(),
            action: "connect".into(),
            outcome: "connected".into(),
            fields: json!({
                "connectionId": connection.connection_id,
                "schemaDigest": snapshot.schema_digest,
                "toolCount": snapshot.tools.len()
            }),
        })?;
        Ok(mcp_snapshot(snapshot))
    }

    fn mcp_list(&self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireMcpListPayload = serde_json::from_value(Value::Object(payload))?;
        let snapshot = self.mcp.snapshot(&parsed.connection_id)?;
        if let Some(expected) = parsed.expected_catalog_digest {
            if snapshot.schema_digest.as_deref() != Some(expected.as_str()) {
                return Err(BrokerError::Integrity("MCP catalog digest changed".into()));
            }
        }
        Ok(mcp_snapshot(snapshot))
    }

    fn mcp_call(&mut self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireMcpCallPayload = serde_json::from_value(Value::Object(payload))?;
        let snapshot = self.mcp.snapshot(&parsed.connection_id)?;
        if snapshot.schema_digest.as_deref() != Some(parsed.catalog_digest.as_str()) {
            return Err(BrokerError::Integrity("MCP catalog digest changed".into()));
        }
        let call_digest = digest_json(&json!({
            "connectionId": parsed.connection_id,
            "invocationId": parsed.invocation_id,
            "toolName": parsed.tool_name,
            "arguments": parsed.arguments,
            "catalogDigest": parsed.catalog_digest
        }))?;
        let Some(token) = parsed.approval_digest else {
            let challenge = self.approvals.issue(
                call_digest.clone(),
                call_digest,
                (Utc::now() + Duration::minutes(APPROVAL_LIFETIME_MINUTES)).timestamp_millis(),
            );
            self.persist_challenge(&challenge, Utc::now().timestamp_millis())?;
            self.pending_mcp_approvals
                .insert(parsed.invocation_id.clone(), challenge.clone());
            return Ok(json!({
                "status": "approval_required",
                "invocationId": parsed.invocation_id,
                "approvalChallenge": challenge,
                "disclosure": "Send the exact shown arguments to the selected MCP server"
            }));
        };
        let challenge = self
            .pending_mcp_approvals
            .remove(&parsed.invocation_id)
            .ok_or(BrokerError::InvalidApproval)?;
        let expected_approval_digest = hex::encode(Sha256::digest(challenge.token.as_bytes()));
        if token != expected_approval_digest {
            return Err(BrokerError::InvalidApproval);
        }
        let proof = ApprovalProof::from(&challenge);
        self.approvals
            .redeem(&proof, Utc::now().timestamp_millis())?;
        self.security
            .consume_approval(
                &proof.approval_id.to_string(),
                &proof.nonce,
                &proof.intent_digest,
                &proof.preflight_digest,
                &proof.token,
                Utc::now().timestamp_millis(),
            )
            .map_err(security_error)?;
        let request_digest = Sha256::digest(parsed.invocation_id.as_bytes());
        let mut request_bytes = [0_u8; 8];
        request_bytes.copy_from_slice(&request_digest[..8]);
        let request_id = u64::from_be_bytes(request_bytes).max(1);
        let result = self.mcp.call_tool_with_request_id(
            &parsed.connection_id,
            request_id,
            &parsed.tool_name,
            Value::Object(parsed.arguments),
        )?;
        self.audit.append(AuditEvent {
            category: "mcp".into(),
            action: "tool.call".into(),
            outcome: "completed".into(),
            fields: json!({
                "connectionId": parsed.connection_id,
                "invocationId": parsed.invocation_id,
                "toolName": parsed.tool_name,
                "catalogDigest": parsed.catalog_digest
            }),
        })?;
        Ok(json!({"status":"succeeded","output":result}))
    }

    fn mcp_disconnect(&self, payload: Map<String, Value>) -> Result<Value> {
        let parsed: WireMcpDisconnectPayload = serde_json::from_value(Value::Object(payload))?;
        self.mcp.disconnect(&parsed.connection_id)?;
        self.audit.append(AuditEvent {
            category: "mcp".into(),
            action: "disconnect".into(),
            outcome: "disconnected".into(),
            fields: json!({"connectionId": parsed.connection_id, "reason": parsed.reason}),
        })?;
        Ok(json!({"disconnected": true, "connectionId": parsed.connection_id}))
    }

    fn resolve_preflight_resources(
        &mut self,
        intent: &WireToolIntent,
        descriptor: &WireToolDescriptor,
    ) -> Result<(Vec<String>, Option<String>, Option<PathBuf>)> {
        if descriptor.required_grants.is_empty() {
            return Ok((Vec::new(), None, None));
        }
        if intent.tool_name == "python.run"
            && descriptor.required_grants.len() == 1
            && descriptor.required_grants.contains("sandbox.execute")
        {
            // The runtime supplies code, not a native path. After this exact
            // intent is authorized, the broker creates a one-use private stage
            // and read grant for the native sandbox adapter.
            return Ok((Vec::new(), None, None));
        }
        if !descriptor
            .required_grants
            .iter()
            .all(|grant| grant.starts_with("filesystem.") || grant.starts_with("repository."))
        {
            return Err(BrokerError::InvalidGrant);
        }
        let handle_id = intent
            .arguments
            .get("grant_id")
            .or_else(|| intent.arguments.get("destination_grant_id"))
            .and_then(Value::as_str)
            .ok_or(BrokerError::InvalidGrant)?
            .to_owned();
        let desktop = self
            .desktop_grants
            .get(&handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        let requested_relative = intent
            .arguments
            .get("relative_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| desktop.fixed_relative.clone())
            .unwrap_or_else(|| PathBuf::from("."));
        let relative = if let Some(fixed) = &desktop.fixed_relative {
            if &requested_relative != fixed {
                return Err(BrokerError::PathEscape);
            }
            fixed.clone()
        } else {
            requested_relative
        };
        let permission = if descriptor.effects.contains(&WireEffect::Delete) {
            FilesystemPermission::Delete
        } else if descriptor.effects.contains(&WireEffect::WriteFiles) {
            if desktop.kind == DesktopFileKind::SaveTarget {
                FilesystemPermission::Create
            } else {
                FilesystemPermission::Modify
            }
        } else if intent.tool_name == "files.search" {
            FilesystemPermission::List
        } else {
            FilesystemPermission::Read
        };
        if matches!(
            permission,
            FilesystemPermission::Create
                | FilesystemPermission::Modify
                | FilesystemPermission::Delete
        ) && !desktop.writable
        {
            return Err(BrokerError::InvalidGrant);
        }
        let resolved = self.grants.resolve(
            &desktop.broker_id,
            &relative,
            permission,
            Utc::now().timestamp_millis(),
            intent.project_id.as_deref(),
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        let opaque = desktop.broker_id.expose_opaque().to_owned();
        // A deliberate file/folder selection is the exact capability grant for
        // non-consequential local access. Mandatory-fresh effects still ask.
        for effect in descriptor.effects.iter().copied().map(WireEffect::native) {
            self.policy.exact_grants.insert(ScopeKey {
                tool_id: descriptor.name.clone(),
                effect,
                resource_id: Some(opaque.clone()),
            });
        }
        Ok((vec![opaque], Some(handle_id), Some(relative)))
    }

    fn execute_file_read(&mut self, prepared: &PreparedInvocation) -> Result<Value> {
        let handle_id = prepared
            .resolved_handle
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let relative = prepared
            .relative_path
            .as_deref()
            .ok_or(BrokerError::InvalidGrant)?;
        let desktop = self
            .desktop_grants
            .get(handle_id)
            .ok_or(BrokerError::InvalidGrant)?;
        let resolved: ResolvedPath = self.grants.resolve(
            &desktop.broker_id,
            relative,
            FilesystemPermission::Read,
            Utc::now().timestamp_millis(),
            prepared.intent.project_id.as_deref(),
        )?;
        resolved.revalidate()?;
        validate_exact_target(desktop, &resolved)?;
        let max_bytes = prepared
            .intent
            .arguments
            .get("max_bytes")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(MAX_FILE_READ_BYTES)
            .clamp(1, MAX_FILE_READ_BYTES);
        let metadata = std::fs::metadata(resolved.as_path())?;
        if !metadata.is_file() {
            return Err(BrokerError::InvalidConfig(
                "file read target is not a regular file".into(),
            ));
        }
        let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
        File::open(resolved.as_path())?
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)?;
        let truncated = bytes.len() > max_bytes;
        bytes.truncate(max_bytes);
        let text = String::from_utf8(bytes)
            .map_err(|_| BrokerError::InvalidConfig("file is not valid UTF-8 text".into()))?;
        Ok(json!({
            "text": text,
            "bytes": text.len(),
            "truncated": truncated,
            "resourceId": desktop.broker_id.expose_opaque()
        }))
    }
}

#[derive(Debug)]
pub struct StagedAttachment {
    pub staging_id: String,
    pub payload_path: PathBuf,
    pub manifest_path: PathBuf,
    pub byte_size: u64,
    pub sha256: String,
    pub display_name: String,
    pub source_handle_id: String,
    pub broker_grant_id: String,
}

#[derive(Debug)]
struct AttachmentStageCleanup {
    directory: Option<PathBuf>,
}

impl AttachmentStageCleanup {
    fn new(directory: PathBuf) -> Self {
        Self {
            directory: Some(directory),
        }
    }

    fn disarm(&mut self) {
        self.directory = None;
    }
}

impl Drop for AttachmentStageCleanup {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

fn digest_regular_file(path: &Path) -> Result<(String, u64)> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(BrokerError::Integrity(
            "backup payload is not a regular file".into(),
        ));
    }
    let mut input = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| BrokerError::Integrity("backup size overflow".into()))?;
        digest.update(&buffer[..count]);
    }
    buffer.fill(0);
    if total != metadata.len() {
        return Err(BrokerError::Integrity(
            "backup changed while it was verified".into(),
        ));
    }
    Ok((hex::encode(digest.finalize()), total))
}

fn atomic_install_verified_file(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    expected_size: u64,
    replace: bool,
) -> Result<()> {
    let parent = destination.parent().ok_or(BrokerError::PathEscape)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(BrokerError::PathEscape)?;
    let temporary = parent.join(format!(".{file_name}.{}.partial", Uuid::now_v7()));
    let result = (|| -> Result<()> {
        let mut input = File::open(source)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut copied = 0_u64;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .ok_or_else(|| BrokerError::Integrity("backup size overflow".into()))?;
            if copied > expected_size {
                return Err(BrokerError::Integrity(
                    "backup changed while it was installed".into(),
                ));
            }
            output.write_all(&buffer[..count])?;
        }
        buffer.fill(0);
        output.flush()?;
        output.sync_all()?;
        drop(output);
        let (temporary_digest, temporary_size) = digest_regular_file(&temporary)?;
        if temporary_size != expected_size || temporary_digest != expected_sha256 {
            return Err(BrokerError::Integrity(
                "backup staging copy failed verification".into(),
            ));
        }
        atomic_replace(&temporary, destination, replace)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn verify_regular_file_digest(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != expected_size {
        return Err(BrokerError::Integrity(
            "attachment staging file binding changed".into(),
        ));
    }
    let mut input = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| BrokerError::Integrity("attachment size overflow".into()))?;
        if total > MAX_STAGED_ATTACHMENT_BYTES {
            return Err(BrokerError::Integrity(
                "attachment exceeds staging limit".into(),
            ));
        }
        digest.update(&buffer[..count]);
    }
    buffer.fill(0);
    if total != expected_size || hex::encode(digest.finalize()) != expected_sha256 {
        return Err(BrokerError::Integrity(
            "attachment staging digest changed".into(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct StagedMigration {
    pub staging_id: String,
    pub snapshot_path: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest_sha256: String,
}

fn copy_migration_tree(
    source_root: &Path,
    current: &Path,
    destination_root: &Path,
    entries: &mut Vec<Value>,
    total_bytes: &mut u64,
) -> Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let source = entry.path();
        let metadata = std::fs::symlink_metadata(&source)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let canonical = source.canonicalize()?;
        if !canonical.starts_with(source_root) {
            return Err(BrokerError::PathEscape);
        }
        let relative = source
            .strip_prefix(source_root)
            .map_err(|_| BrokerError::PathEscape)?;
        let destination = destination_root.join(relative);
        if metadata.is_dir() {
            if !migration_directory_may_contain_allowed(relative) {
                continue;
            }
            copy_migration_tree(source_root, &source, destination_root, entries, total_bytes)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if !migration_source_is_allowed(relative) {
            continue;
        }
        if entries.len() >= MAX_MIGRATION_SNAPSHOT_FILES {
            return Err(BrokerError::InvalidConfig(
                "legacy snapshot contains too many files".into(),
            ));
        }
        *total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| BrokerError::InvalidConfig("legacy snapshot is too large".into()))?;
        if *total_bytes > MAX_MIGRATION_SNAPSHOT_BYTES {
            return Err(BrokerError::InvalidConfig(
                "legacy snapshot exceeds the size limit".into(),
            ));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut input = File::open(&source)?;
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)?;
        let mut digest = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            std::io::Write::write_all(&mut output, &buffer[..count])?;
            copied += count as u64;
        }
        buffer.fill(0);
        output.sync_all()?;
        if copied != metadata.len() {
            return Err(BrokerError::Integrity(
                "legacy source changed during snapshot".into(),
            ));
        }
        let relative_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        entries.push(json!({
            "path": relative_path,
            "byteSize": copied,
            "sha256": hex::encode(digest.finalize())
        }));
    }
    Ok(())
}

fn migration_directory_may_contain_allowed(relative: &Path) -> bool {
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return true;
    }
    if parts.iter().any(|part| {
        matches!(
            part.as_str(),
            ".git" | ".venv" | "venv" | "__pycache__" | "build" | "dist" | "generated"
        )
    }) {
        return false;
    }
    parts
        .first()
        .is_some_and(|part| part == "memory" || (part == "state_of_mind" && parts.len() == 1))
}

fn migration_source_is_allowed(relative: &Path) -> bool {
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if parts.is_empty()
        || parts.iter().any(|part| {
            matches!(
                part.as_str(),
                ".git"
                    | ".venv"
                    | "venv"
                    | "__pycache__"
                    | "build"
                    | "dist"
                    | "generated"
                    | ".env"
                    | ".env.local"
                    | ".env.development"
                    | ".env.production"
                    | "secrets.json"
                    | "credentials.json"
                    | "api_keys.json"
                    | "apikeys.json"
                    | "tokens.json"
            ) || part.contains("credential")
                || part.contains("api_key")
                || part.contains("apikey")
                || part.contains("access_token")
                || part.contains("auth_token")
        })
    {
        return false;
    }

    const STATE_FILES: &[&str] = &[
        "conversation.json",
        "task_list.json",
        "personality.txt",
        "thought_bubble.txt",
        "happiness.txt",
        "sadness.txt",
        "anger.txt",
        "fear.txt",
        "creativity.txt",
        "curiosity.txt",
        "smell.txt",
        "taste.txt",
        "touch.txt",
    ];
    let is_state_file = |name: &str| STATE_FILES.contains(&name);
    if parts.len() == 1 {
        return is_state_file(&parts[0]);
    }
    if parts.len() == 2 && parts[0] == "state_of_mind" {
        return is_state_file(&parts[1]);
    }
    if parts.first().map(String::as_str) != Some("memory") {
        return false;
    }
    matches!(
        parts.last().map(String::as_str),
        Some(
            "documents.json"
                | "chroma_documents.json"
                | "chroma.sqlite3"
                | "chroma.sqlite"
                | "chroma.db"
        )
    )
}

fn validate_handle_id(value: &str) -> Result<()> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(BrokerError::InvalidConfig(
            "invalid desktop handle ID".into(),
        ))
    }
}

fn validate_display_name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 255
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        Err(BrokerError::InvalidConfig(
            "invalid desktop file display name".into(),
        ))
    } else {
        Ok(())
    }
}

#[derive(Debug)]
struct ValidatedPythonArguments {
    source: String,
    timeout_seconds: u64,
    memory_mb: u64,
    execution_mode: WirePythonExecutionMode,
}

fn parse_python_arguments(arguments: &Map<String, Value>) -> Result<ValidatedPythonArguments> {
    let parsed: WirePythonArguments = serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|_| {
            BrokerError::InvalidConfig(
                "python.run arguments do not match the versioned tool schema".into(),
            )
        })?;
    if parsed.source.is_empty()
        || parsed.source.len() > MAX_PYTHON_SOURCE_BYTES
        || parsed.source.contains('\0')
    {
        return Err(BrokerError::InvalidConfig(
            "python.run source is empty or exceeds the sandbox bound".into(),
        ));
    }
    if !parsed.input_files.is_empty() {
        return Err(BrokerError::InvalidGrant);
    }
    let timeout_seconds = parsed.timeout_seconds.unwrap_or(30);
    if !(1..=900).contains(&timeout_seconds) {
        return Err(BrokerError::InvalidConfig(
            "python.run timeout is outside the 1 to 900 second bound".into(),
        ));
    }
    let memory_mb = parsed.memory_mb.unwrap_or(512);
    if !(64..=MAX_PYTHON_MEMORY_MIB).contains(&memory_mb) {
        return Err(BrokerError::InvalidConfig(
            "python.run memory is outside the 64 to 4096 MiB bound".into(),
        ));
    }
    Ok(ValidatedPythonArguments {
        source: parsed.source,
        timeout_seconds,
        memory_mb,
        execution_mode: parsed.execution_mode,
    })
}

struct IntegrationStageCleanup(PathBuf);

impl Drop for IntegrationStageCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct NativeGrantCleanup<'a> {
    native: &'a NativeToolExecutorService,
    grant_id: String,
}

impl Drop for NativeGrantCleanup<'_> {
    fn drop(&mut self) {
        let _ = self.native.revoke_filesystem_grant(&self.grant_id);
    }
}

fn python_continuation_result(
    outer: &WireToolIntent,
    native_intent_id: Uuid,
    started_at: DateTime<Utc>,
    native: NativeToolResult,
) -> Value {
    let (status, error_code) = match native.status {
        NativeToolResultStatus::Completed => ("succeeded", None),
        NativeToolResultStatus::Cancelled => ("cancelled", None),
        NativeToolResultStatus::Denied => ("denied", None),
        NativeToolResultStatus::TimedOut => ("failed", Some("SANDBOX_TIMED_OUT")),
        NativeToolResultStatus::OutputLimitExceeded => {
            ("failed", Some("SANDBOX_OUTPUT_LIMIT_EXCEEDED"))
        }
        NativeToolResultStatus::Failed => ("failed", Some("SANDBOX_EXECUTION_FAILED")),
    };
    json!({
        "invocation_id": outer.invocation_id,
        "status": status,
        "output": {
            "continuation": {
                "runId": outer.run_id,
                "taskId": outer.task_id,
                "projectId": outer.project_id,
                "runtimeTool": "python.run",
                "nativeTool": "native.sandbox.python",
                "nativeIntentId": native_intent_id,
            },
            "native": {
                "status": native.status,
                "output": native.output,
                "generatedResourceIds": native.generated_resource_ids,
                "durationMs": native.duration_ms,
                "provenance": native.provenance,
                "redactedError": native.redacted_error,
            }
        },
        "error_code": error_code,
        "error_message": native.redacted_error,
        "artifacts": native.generated_resource_ids,
        "started_at": started_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "finished_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn parent_and_name(path: &Path) -> Result<(PathBuf, Option<PathBuf>)> {
    let parent = path.parent().ok_or(BrokerError::PathEscape)?.to_path_buf();
    let name = path.file_name().ok_or(BrokerError::PathEscape)?;
    Ok((parent, Some(PathBuf::from(name))))
}

fn validate_exact_target(desktop: &DesktopGrant, resolved: &ResolvedPath) -> Result<()> {
    if let Some(expected) = &desktop.exact_target {
        if resolved.as_path() != expected {
            return Err(BrokerError::PathEscape);
        }
    }
    Ok(())
}

fn validate_intent_and_descriptor(
    intent: &WireToolIntent,
    descriptor: &WireToolDescriptor,
) -> Result<()> {
    if intent.invocation_id.is_empty()
        || intent.run_id.is_empty()
        || intent.tool_name != descriptor.name
        || intent.tool_version != descriptor.version
        || descriptor.display_name.trim().is_empty()
        || descriptor.description.trim().is_empty()
        || descriptor.category.trim().is_empty()
        || descriptor.timeout_seconds == 0
        || descriptor.timeout_seconds > 86_400
    {
        return Err(BrokerError::InvalidConfig(
            "invalid tool intent or descriptor identity".into(),
        ));
    }
    Version::parse(&descriptor.version)
        .map_err(|_| BrokerError::InvalidConfig("invalid tool version".into()))?;
    if descriptor.input_schema.get("type").and_then(Value::as_str) != Some("object")
        || descriptor.output_schema.get("type").and_then(Value::as_str) != Some("object")
    {
        return Err(BrokerError::InvalidConfig(
            "tool schemas must describe objects".into(),
        ));
    }
    DateTime::parse_from_rfc3339(&intent.requested_at)
        .map_err(|_| BrokerError::InvalidConfig("invalid tool request timestamp".into()))?;
    // Read the fields so accidental removal from the generated contract is
    // visible to lint/builds even though capability execution does not use them.
    let _ = (descriptor.cancellable, &intent.task_id);
    Ok(())
}

fn catalog_descriptor(name: &str) -> Option<crate::registry::ToolDescriptor> {
    let catalog_id = match name {
        "files.read" | "files.search" => "native.files.read",
        "repository.inspect" => "native.git.inspect",
        "repository.propose_patch" => "native.git.patch_proposal",
        "web.search" => "native.web.search",
        "web.fetch" => "native.web.fetch",
        "python.run" => "native.sandbox.python",
        "models.manage" => "native.models.manage",
        "artifacts.create" | "artifacts.update" | "artifacts.export" => "native.artifacts.manage",
        _ => return None,
    };
    native_descriptor_catalog()
        .into_iter()
        .find(|descriptor| descriptor.id == catalog_id)
}

fn same_intent(left: &WireToolIntent, right: &WireToolIntent) -> Result<bool> {
    Ok(digest_json(&serde_json::to_value(left)?)? == digest_json(&serde_json::to_value(right)?)?)
}

fn digest_json(value: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(
        canonical_json(value)?.as_bytes(),
    )))
}

fn decode_single_json_frame(bytes: &[u8], maximum: usize) -> Result<Value> {
    if bytes.len() < 4 {
        return Err(BrokerError::TruncatedFrame);
    }
    let size = u32::from_be_bytes(bytes[..4].try_into().expect("four-byte frame header")) as usize;
    if size == 0 || size > maximum || bytes.len() != size + 4 {
        return Err(BrokerError::InvalidEnvelope(
            "document worker emitted an invalid control frame".into(),
        ));
    }
    let value: Value = serde_json::from_slice(&bytes[4..])?;
    if !value.is_object() {
        return Err(BrokerError::InvalidEnvelope(
            "document worker control frame must be an object".into(),
        ));
    }
    Ok(value)
}

fn tool_result(
    invocation_id: &str,
    status: &str,
    output: Value,
    error: Option<(&str, &str)>,
) -> Value {
    let (error_code, error_message) = error
        .map(|(code, message)| (json!(code), json!(message)))
        .unwrap_or((Value::Null, Value::Null));
    json!({
        "invocation_id": invocation_id,
        "status": status,
        "output": output,
        "error_code": error_code,
        "error_message": error_message,
        "artifacts": [],
        "started_at": null,
        "finished_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn mcp_snapshot(snapshot: McpConnectionSnapshot) -> Value {
    let state = match snapshot.state {
        ConnectionState::Disconnected => "disconnected",
        ConnectionState::Connecting => "connecting",
        ConnectionState::Connected => "connected",
        ConnectionState::SchemaApprovalRequired => "schema_approval_required",
        ConnectionState::Faulted => "faulted",
        ConnectionState::Disabled => "disabled",
    };
    json!({
        "connection_id": snapshot.id,
        "state": state,
        "schema_digest": snapshot.schema_digest,
        "pending_schema_digest": snapshot.pending_schema_digest,
        "tools": snapshot.tools.into_iter().map(|tool| json!({
            "id": tool.id,
            "description": tool.description,
            "input_schema": tool.input_schema,
            "output_schema": tool.output_schema
        })).collect::<Vec<_>>()
    })
}

fn response_success(result: Value) -> Map<String, Value> {
    json!({"ok": true, "result": result})
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn response_failure(code: &str, message: &str) -> Map<String, Value> {
    json!({"ok": false, "error": {"code": code, "message": message, "retryable": false}})
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn integration_result<T: Serialize>(result: Result<T>) -> Map<String, Value> {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => response_success(value),
            Err(error) => response_failure("INVALID_RESPONSE", &error.to_string()),
        },
        Err(error) => response_failure(error_code(&error), &safe_integration_error(&error)),
    }
}

fn find_fixed_executable(name: &str) -> Option<PathBuf> {
    if !name.eq_ignore_ascii_case("git.exe") {
        return None;
    }
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(&root).join("Git").join("cmd").join("git.exe"));
            candidates.push(PathBuf::from(&root).join("Git").join("bin").join("git.exe"));
        }
    }
    candidates
        .into_iter()
        .find_map(|path| path.is_file().then(|| path.canonicalize().ok()).flatten())
}

fn error_code(error: &BrokerError) -> &'static str {
    match error {
        BrokerError::InvalidApproval => "INVALID_APPROVAL",
        BrokerError::InvalidGrant | BrokerError::PathEscape => "INVALID_GRANT",
        BrokerError::PermissionDenied(_) => "PERMISSION_DENIED",
        BrokerError::Integrity(_) => "INTEGRITY_CHECK_FAILED",
        BrokerError::NotFound(_) => "TOOL_NOT_FOUND",
        BrokerError::InvalidConfig(message) if message.contains("adapter") => {
            "ADAPTER_NOT_CONNECTED"
        }
        BrokerError::InvalidConfig(message) if message.contains("MCP") => "MCP_NOT_CONNECTED",
        _ => "INVALID_REQUEST",
    }
}

fn safe_integration_error(error: &BrokerError) -> String {
    match error {
        BrokerError::Io(_) => "broker could not complete the local operation".into(),
        BrokerError::Json(_) | BrokerError::InvalidEnvelope(_) => {
            "broker rejected malformed tool data".into()
        }
        _ => error.to_string(),
    }
}

fn security_error(error: crate::security_db::SecurityDbError) -> BrokerError {
    use crate::security_db::SecurityDbError;
    match error {
        SecurityDbError::ApprovalRejected => BrokerError::InvalidApproval,
        SecurityDbError::GrantRejected => BrokerError::InvalidGrant,
        SecurityDbError::WrongApplication
        | SecurityDbError::UnsupportedVersion { .. }
        | SecurityDbError::Corrupt(_) => BrokerError::Integrity(error.to_string()),
        _ => BrokerError::InvalidConfig("security database operation failed".into()),
    }
}

fn policy_from_security(records: Vec<StoredPolicy>) -> Result<PolicySet> {
    let mut policy = PolicySet::default();
    for record in records {
        let effect: Effect =
            serde_json::from_value(Value::String(record.effect.clone())).map_err(|_| {
                BrokerError::Integrity(format!("unknown security policy effect: {}", record.effect))
            })?;
        let scope = record.scope;
        let decision = record.decision;
        if matches!(scope, StoredPolicyScope::Global) && record.resource_id.is_none() {
            let category = match decision {
                StoredPolicyDecision::Allow => CategoryDecision::Allow,
                StoredPolicyDecision::Deny => CategoryDecision::Deny,
                StoredPolicyDecision::Ask => CategoryDecision::Ask,
            };
            policy.category.insert(effect, category);
            continue;
        }
        let key = ScopeKey {
            tool_id: record.tool_id,
            effect,
            resource_id: record.resource_id,
        };
        match decision {
            StoredPolicyDecision::Allow => match scope {
                StoredPolicyScope::Global => {
                    policy.exact_grants.insert(key);
                }
                StoredPolicyScope::Session { .. } => {
                    policy.session_grants.insert(key);
                }
                StoredPolicyScope::Project { .. } => {
                    policy.project_grants.insert(key);
                }
            },
            StoredPolicyDecision::Deny => {
                policy.denied.insert(key);
            }
            StoredPolicyDecision::Ask => {
                // Absence of an allow is the fail-closed default ask.
            }
        }
    }
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RuntimeRequestType;
    use crate::sandbox::SandboxOutput;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Default)]
    struct RecordingPythonSandbox {
        sources: Mutex<Vec<Vec<u8>>>,
    }

    impl SandboxBackend for RecordingPythonSandbox {
        fn execute(&self, plan: &ResolvedProcessPlan) -> Result<SandboxOutput> {
            assert_eq!(plan.network, NetworkPolicy::Denied);
            let frame = std::fs::read(plan.working_directory.join("python-request.frame"))?;
            let declared = u32::from_be_bytes(
                frame[..4]
                    .try_into()
                    .map_err(|_| BrokerError::InvalidEnvelope("short test frame".into()))?,
            ) as usize;
            if frame.len() != declared + 4 {
                return Err(BrokerError::InvalidEnvelope(
                    "invalid test request frame".into(),
                ));
            }
            let request: Value = serde_json::from_slice(&frame[4..])?;
            let staged_name = request["payload"]["script"]["staged_name"]
                .as_str()
                .ok_or_else(|| BrokerError::InvalidEnvelope("staged script missing".into()))?;
            self.sources
                .lock()
                .unwrap()
                .push(std::fs::read(plan.working_directory.join(staged_name))?);
            let response = json!({
                "version": 1,
                "kind": "python.execute.complete",
                "request_id": request["request_id"],
                "stage_token": request["stage_token"],
                "result": {"value": 6},
                "stdout": "6\n",
                "stderr": ""
            });
            let body = serde_json::to_vec(&response)?;
            let mut response_frame = Vec::with_capacity(body.len() + 4);
            response_frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
            response_frame.extend_from_slice(&body);
            std::fs::write(
                plan.working_directory.join("python-response.frame"),
                response_frame,
            )?;
            Ok(SandboxOutput {
                state: ProcessState::Completed,
                exit_code: Some(0),
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }

        fn cancel(&self, _execution_id: &str) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn permission_mode_is_persisted_in_the_security_store() {
        let data = tempdir().unwrap();
        {
            let mut broker = BrokerIntegration::open(data.path()).unwrap();
            assert_eq!(broker.permission_mode(), "guarded");
            broker.set_permission_mode("full-freedom").unwrap();
            assert_eq!(broker.permission_mode(), "full-freedom");
        }
        let reopened = BrokerIntegration::open(data.path()).unwrap();
        assert_eq!(reopened.permission_mode(), "full-freedom");
    }

    #[test]
    fn desktop_path_stays_private_and_release_revokes_grant() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("note.txt");
        std::fs::write(&path, "hello").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        let event = json!({
            "type": "files.granted",
            "handle": {"id": handle_id, "kind": "file", "name": "note.txt", "absolutePath": path, "writable": false}
        });
        let accepted = broker
            .handle_desktop_event(event.as_object().unwrap())
            .unwrap();
        assert!(!accepted
            .to_string()
            .contains(selected.path().to_str().unwrap()));
        let released = broker
            .handle_desktop_event(
                json!({"type": "files.released", "handleId": handle_id})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(released["released"], true);
    }

    #[test]
    fn backup_source_requires_an_exact_read_only_file_capability() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("owner-backup.cupcakebak");
        std::fs::write(&path, "backup bytes").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ac";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"owner-backup.cupcakebak","absolutePath":path,"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();

        assert_eq!(
            broker.resolve_backup_source(handle_id).unwrap(),
            path.canonicalize().unwrap()
        );
        broker
            .handle_desktop_event(
                json!({"type":"files.released","handleId":handle_id})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        assert!(broker.resolve_backup_source(handle_id).is_err());
    }

    #[test]
    fn selected_file_can_be_preflighted_and_read_without_returning_a_path() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("note.txt");
        std::fs::write(&path, "cupcake").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"note.txt","absolutePath":path,"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();
        let preflight_request = file_request(handle_id, RuntimeRequestType::ToolPreflight, None);
        let preflight_response = broker.dispatch(preflight_request);
        assert_eq!(preflight_response["ok"], true);
        assert_eq!(
            preflight_response["result"]["preflight"]["decision"],
            "allow"
        );
        assert!(!Value::Object(preflight_response.clone())
            .to_string()
            .contains(selected.path().to_str().unwrap()));
        let preflight = preflight_response["result"]["preflight"].clone();
        let execute = file_request(handle_id, RuntimeRequestType::ToolExecute, Some(preflight));
        let execute_response = broker.dispatch(execute);
        assert_eq!(execute_response["ok"], true);
        assert_eq!(execute_response["result"]["output"]["text"], "cupcake");
        assert!(!Value::Object(execute_response)
            .to_string()
            .contains(selected.path().to_str().unwrap()));
    }

    #[test]
    fn authorized_python_continuation_reaches_native_sandbox_and_preserves_lineage() {
        let data = tempdir().unwrap();
        let runtime = data.path().join("cupcake-runtime.exe");
        std::fs::write(&runtime, b"test packaged runtime").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let sandbox = Arc::new(RecordingPythonSandbox::default());
        broker.native = NativeToolExecutorService::open(
            data.path(),
            broker.policy.clone(),
            None,
            Some(&runtime),
            Arc::new(StrictHttpsClient::new(None).unwrap()),
            sandbox.clone(),
            Arc::new(DisabledLocalModelBackend),
        )
        .unwrap();

        let source = "print(2 + 4)\nresult = 6\n";
        let invocation_id = "018f1e2d-3c4b-7a69-8def-111111111111";
        let preflight_response = broker.dispatch(python_request(
            invocation_id,
            source,
            json!([]),
            RuntimeRequestType::ToolPreflight,
            None,
        ));
        assert_eq!(preflight_response["ok"], true);
        assert_eq!(preflight_response["result"]["preflight"]["decision"], "ask");
        let preflight = preflight_response["result"]["preflight"].clone();
        let challenge: ApprovalChallenge =
            serde_json::from_value(preflight_response["result"]["approvalChallenge"].clone())
                .unwrap();

        let changed_execution = broker.dispatch(python_request(
            invocation_id,
            "print('different')\n",
            json!([]),
            RuntimeRequestType::ToolExecute,
            Some(preflight.clone()),
        ));
        assert_eq!(changed_execution["ok"], false);
        assert_eq!(changed_execution["error"]["code"], "INTEGRITY_CHECK_FAILED");
        assert!(sandbox.sources.lock().unwrap().is_empty());

        let missing_approval = broker.dispatch(python_request(
            invocation_id,
            source,
            json!([]),
            RuntimeRequestType::ToolExecute,
            Some(preflight.clone()),
        ));
        assert_eq!(missing_approval["ok"], false);
        assert_eq!(missing_approval["error"]["code"], "INVALID_APPROVAL");
        assert!(sandbox.sources.lock().unwrap().is_empty());

        let approval = ApprovalProof::from(&challenge);
        let approval_response = broker.dispatch(RuntimeBrokerRequest {
            protocol_version: crate::PROTOCOL_VERSION,
            request_type: RuntimeRequestType::ToolApprovalVerify,
            payload: json!({"preflight": preflight, "approval": approval})
                .as_object()
                .unwrap()
                .clone(),
        });
        assert_eq!(approval_response["ok"], true, "{approval_response:?}");

        let execute_response = broker.dispatch(python_request(
            invocation_id,
            source,
            json!([]),
            RuntimeRequestType::ToolExecute,
            Some(preflight_response["result"]["preflight"].clone()),
        ));
        assert_eq!(execute_response["ok"], true, "{execute_response:?}");
        let result = &execute_response["result"];
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["output"]["native"]["status"], "completed");
        assert_eq!(result["output"]["native"]["output"]["result"]["value"], 6);
        assert_eq!(result["output"]["native"]["output"]["stdout"], "6\n");
        assert_eq!(result["output"]["native"]["output"]["stderr"], "");
        assert_eq!(
            result["output"]["continuation"]["runtimeTool"],
            "python.run"
        );
        assert_eq!(
            result["output"]["continuation"]["nativeTool"],
            "native.sandbox.python"
        );
        assert_eq!(result["output"]["continuation"]["runId"], "run-python-1");
        assert_eq!(result["output"]["continuation"]["taskId"], "task-python-1");
        assert_eq!(
            result["output"]["native"]["provenance"],
            json!(["sandbox:packaged-worker-appcontainer-job"])
        );
        assert_eq!(
            sandbox.sources.lock().unwrap().as_slice(),
            [source.as_bytes()]
        );
        assert!(!Value::Object(execute_response)
            .to_string()
            .contains(data.path().to_str().unwrap()));
        assert!(!data
            .path()
            .join("runtime")
            .join("task-continuations")
            .read_dir()
            .unwrap()
            .any(|_| true));
    }

    #[test]
    fn python_continuation_rejects_unmapped_input_files_before_authorization() {
        let data = tempdir().unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let response = broker.dispatch(python_request(
            "invoke-python-input",
            "print('no input mapping')\n",
            json!([{"artifactId": "artifact-1"}]),
            RuntimeRequestType::ToolPreflight,
            None,
        ));
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "INVALID_GRANT");
    }

    #[test]
    fn failed_native_python_result_cannot_be_reported_as_outer_success() {
        let outer = WireToolIntent {
            invocation_id: "invoke-python-failed".into(),
            run_id: "run-python-failed".into(),
            tool_name: "python.run".into(),
            tool_version: "1.0.0".into(),
            arguments: Map::new(),
            project_id: Some("project-python-1".into()),
            task_id: Some("task-python-1".into()),
            requested_at: "2026-09-05T12:00:00Z".into(),
        };
        let native = NativeToolResult {
            intent_id: Uuid::now_v7(),
            status: NativeToolResultStatus::Failed,
            output: json!({
                "kind": "python.execute.failed",
                "result": {"status": "failed", "stdout": "before failure\n", "stderr": "boom\n"}
            }),
            generated_resource_ids: BTreeSet::new(),
            duration_ms: 17,
            provenance: vec!["sandbox:packaged-worker-appcontainer-job".into()],
            redacted_error: Some("sandbox worker rejected execution".into()),
        };
        let result = python_continuation_result(&outer, native.intent_id, Utc::now(), native);

        assert_eq!(result["status"], "failed");
        assert_eq!(result["error_code"], "SANDBOX_EXECUTION_FAILED");
        assert_eq!(
            result["output"]["native"]["output"]["result"]["stdout"],
            "before failure\n"
        );
        assert_eq!(
            result["output"]["native"]["output"]["result"]["stderr"],
            "boom\n"
        );
        assert_eq!(
            result["output"]["native"]["provenance"],
            json!(["sandbox:packaged-worker-appcontainer-job"])
        );
    }

    #[test]
    fn directory_grant_rejects_parent_traversal_but_allows_a_child() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        std::fs::write(selected.path().join("inside.txt"), "inside").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"directory","name":"selected","absolutePath":selected.path(),"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();

        let mut escaped = file_request(handle_id, RuntimeRequestType::ToolPreflight, None);
        escaped.payload.get_mut("intent").unwrap()["arguments"]["relative_path"] =
            json!("../outside.txt");
        let denied = broker.dispatch(escaped);
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["error"]["code"], "INVALID_GRANT");

        let mut allowed = file_request(handle_id, RuntimeRequestType::ToolPreflight, None);
        allowed.payload.get_mut("intent").unwrap()["arguments"]["relative_path"] =
            json!("inside.txt");
        let response = broker.dispatch(allowed);
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn nonexistent_save_target_is_exact_and_never_disclosed() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let target = selected.path().join("new-report.md");
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        let accepted = broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"save-target","name":"new-report.md","absolutePath":target,"writable":true}})
                    .as_object().unwrap(),
            )
            .unwrap();
        assert_eq!(accepted["accepted"], true);
        assert!(!accepted
            .to_string()
            .contains(selected.path().to_str().unwrap()));
        assert!(!target.exists());
    }

    #[test]
    fn artifact_export_consumes_exact_save_target_and_verifies_revision_bytes() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let target = selected.path().join("project-note.md");
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"save-target","name":"project-note.md","absolutePath":target,"writable":true}})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        let content = b"# Verified artifact\n";
        let digest = hex::encode(Sha256::digest(content));
        let content_base64 = BASE64_STANDARD.encode(content);
        let request = ArtifactExportRequest {
            desktop_handle_id: handle_id,
            project_id: "project-019d0000",
            artifact_id: "artifact-019d0000",
            revision_id: "revision-019d0000",
            object_digest: &digest,
            byte_size: content.len() as u64,
            content_base64: &content_base64,
        };
        let receipt = broker.export_artifact_to_desktop_target(request).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(receipt["fileName"], "project-note.md");
        assert_eq!(receipt["sha256"], digest);

        let collision = broker.export_artifact_to_desktop_target(request);
        assert!(collision.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), content);
    }

    #[test]
    fn backup_creation_uses_exact_save_target_and_returns_path_free_verified_receipt() {
        let root = tempdir().unwrap();
        let data = root.path().join("profile");
        let selected = root.path().join("exports");
        std::fs::create_dir_all(&selected).unwrap();
        let target = selected.join("owner-backup.cupcakebak");
        std::fs::write(&target, b"old backup").unwrap();
        let mut broker = BrokerIntegration::open(&data).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"save-target","name":"owner-backup.cupcakebak","absolutePath":target,"writable":true}})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        let prepared = broker.begin_backup_creation(handle_id).unwrap();
        let staging_root = prepared.staging_root.clone();
        std::fs::write(prepared.runtime_archive(), b"trusted runtime archive").unwrap();
        let manifest = json!({
            "format_version": 1,
            "product_version": "2.0.0-rc.1",
            "created_at": "2026-09-05T00:00:00Z",
            "schema_version": 1,
            "entries": [
                {"path":"database/product.sqlite","sha256":"00".repeat(32),"byte_size":1},
                {"path":"database/dbos.sqlite","sha256":"11".repeat(32),"byte_size":1}
            ]
        });
        let key = SecretBytes::new(vec![7_u8; 32]).unwrap();
        let receipt = broker
            .complete_backup_creation(prepared, &manifest, &key)
            .unwrap();

        assert_eq!(receipt["fileName"], "owner-backup.cupcakebak");
        assert_eq!(receipt["protection"], "windows-dpapi-current-user");
        assert_eq!(receipt["verifiedPayloads"], 2);
        assert_eq!(
            receipt["byteSize"],
            std::fs::metadata(&target).unwrap().len()
        );
        assert_eq!(
            receipt["sha256"],
            hex::encode(Sha256::digest(std::fs::read(&target).unwrap()))
        );
        assert!(!receipt.to_string().contains(selected.to_str().unwrap()));
        assert!(!staging_root.exists());
        let inspection =
            crate::backup_container::inspect_backup_container_with_key(&target, &key).unwrap();
        assert_eq!(inspection.verified_payloads, 2);
        assert_eq!(
            inspection.manifest.backup.backup_id.to_string(),
            receipt["backupId"].as_str().unwrap()
        );
    }

    #[test]
    fn failed_backup_manifest_cleans_private_staging_and_preserves_existing_target() {
        let root = tempdir().unwrap();
        let data = root.path().join("profile");
        let selected = root.path().join("exports");
        std::fs::create_dir_all(&selected).unwrap();
        let target = selected.join("owner-backup.cupcakebak");
        std::fs::write(&target, b"known good backup").unwrap();
        let mut broker = BrokerIntegration::open(&data).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"save-target","name":"owner-backup.cupcakebak","absolutePath":target,"writable":true}})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        let prepared = broker.begin_backup_creation(handle_id).unwrap();
        let staging_root = prepared.staging_root.clone();
        std::fs::write(prepared.runtime_archive(), b"invalid runtime archive").unwrap();
        let key = SecretBytes::new(vec![9_u8; 32]).unwrap();
        assert!(broker
            .complete_backup_creation(prepared, &json!({"format_version": 1}), &key)
            .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"known good backup");
        assert!(!staging_root.exists());
    }

    #[test]
    fn attachment_staging_streams_to_private_manifest_and_cleans_up() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("source.txt");
        std::fs::write(&path, "private attachment").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"source.txt","absolutePath":path,"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();
        let staged = broker.stage_attachment(handle_id).unwrap();
        assert_eq!(
            std::fs::read(&staged.payload_path).unwrap(),
            b"private attachment"
        );
        assert_eq!(staged.byte_size, 18);
        broker.revalidate_staged_attachment(&staged).unwrap();
        let manifest = std::fs::read_to_string(&staged.manifest_path).unwrap();
        assert!(!manifest.contains(selected.path().to_str().unwrap()));
        let staging_id = staged.staging_id.clone();
        let staging_root = staged.payload_path.parent().unwrap().to_path_buf();
        broker.cleanup_staged_attachment(&staging_id).unwrap();
        assert!(!staging_root.exists());
    }

    #[test]
    fn attachment_revalidation_rejects_source_stage_and_grant_changes() {
        for mutation in ["source", "stage", "grant"] {
            let data = tempdir().unwrap();
            let selected = tempdir().unwrap();
            let path = selected.path().join("source.txt");
            std::fs::write(&path, "bound attachment").unwrap();
            let mut broker = BrokerIntegration::open(data.path()).unwrap();
            let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
            broker
                .handle_desktop_event(
                    json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"source.txt","absolutePath":path,"writable":false}})
                        .as_object().unwrap(),
                )
                .unwrap();
            let staged = broker.stage_attachment(handle_id).unwrap();
            match mutation {
                "source" => std::fs::write(&path, "other attachment").unwrap(),
                "stage" => std::fs::write(&staged.payload_path, "other attachment").unwrap(),
                "grant" => {
                    broker
                        .handle_desktop_event(
                            json!({"type":"files.released","handleId":handle_id})
                                .as_object()
                                .unwrap(),
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(broker.revalidate_staged_attachment(&staged).is_err());
            broker
                .cleanup_staged_attachment(&staged.staging_id)
                .unwrap();
        }
    }

    #[test]
    fn attachment_revalidation_rejects_manifest_tampering() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        let path = selected.path().join("source.txt");
        std::fs::write(&path, "bound attachment").unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"file","name":"source.txt","absolutePath":path,"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();
        let staged = broker.stage_attachment(handle_id).unwrap();
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&staged.manifest_path).unwrap()).unwrap();
        manifest["sha256"] = json!("00".repeat(32));
        std::fs::write(
            &staged.manifest_path,
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            broker.revalidate_staged_attachment(&staged),
            Err(BrokerError::Integrity(_))
        ));
        broker
            .cleanup_staged_attachment(&staged.staging_id)
            .unwrap();
    }

    #[test]
    fn migration_snapshot_survives_renderer_handle_release() {
        let data = tempdir().unwrap();
        let selected = tempdir().unwrap();
        std::fs::create_dir(selected.path().join("memory")).unwrap();
        std::fs::write(selected.path().join("memory").join("documents.json"), "[]").unwrap();
        std::fs::create_dir(selected.path().join("state_of_mind")).unwrap();
        std::fs::write(
            selected
                .path()
                .join("state_of_mind")
                .join("conversation.json"),
            r#"{"conversation":[]}"#,
        )
        .unwrap();
        std::fs::write(selected.path().join(".env"), "excluded").unwrap();
        std::fs::write(
            selected.path().join("memory").join("api_keys.json"),
            r#"{"excluded":true}"#,
        )
        .unwrap();
        std::fs::write(
            selected.path().join("memory").join("rebuild_memory.py"),
            "# excluded",
        )
        .unwrap();
        let mut broker = BrokerIntegration::open(data.path()).unwrap();
        let handle_id = "018f1e2d-3c4b-7a69-8def-0123456789ab";
        broker
            .handle_desktop_event(
                json!({"type":"files.granted","handle":{"id":handle_id,"kind":"directory","name":"legacy","absolutePath":selected.path(),"writable":false}})
                    .as_object().unwrap(),
            )
            .unwrap();
        let staged = broker.stage_migration_snapshot(handle_id).unwrap();
        broker
            .handle_desktop_event(
                json!({"type":"files.released","handleId":handle_id})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(staged.snapshot_path.join("memory").join("documents.json"),)
                .unwrap(),
            "[]"
        );
        assert_eq!(
            staged
                .snapshot_path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|value| value.to_str()),
            Some("broker-migration")
        );
        assert!(!staged.snapshot_path.join(".env").exists());
        assert!(!staged
            .snapshot_path
            .join("memory")
            .join("api_keys.json")
            .exists());
        assert!(!staged
            .snapshot_path
            .join("memory")
            .join("rebuild_memory.py")
            .exists());
        assert!(!std::fs::read_to_string(&staged.manifest_path)
            .unwrap()
            .contains(selected.path().to_str().unwrap()));
        broker.cleanup_migration_snapshot().unwrap();
        assert!(!staged.snapshot_path.exists());
    }

    fn file_request(
        handle_id: &str,
        request_type: RuntimeRequestType,
        preflight: Option<Value>,
    ) -> RuntimeBrokerRequest {
        let intent = json!({
            "invocation_id":"invoke-1","run_id":"run-1","tool_name":"files.read","tool_version":"1.0.0",
            "arguments":{"grant_id":handle_id,"relative_path":"note.txt"},"project_id":null,"task_id":null,
            "requested_at":"2026-08-28T12:00:00Z"
        });
        let payload = if request_type == RuntimeRequestType::ToolPreflight {
            json!({"intent":intent,"descriptor":{
                "name":"files.read","version":"1.0.0","display_name":"Read file","description":"Read an approved file",
                "input_schema":{"type":"object"},"output_schema":{"type":"object"},"effects":["read_files"],
                "required_grants":["filesystem.read"],"default_data_flows":[],"timeout_seconds":60,"cancellable":true,"category":"native"
            }})
        } else {
            json!({"intent":intent,"preflight":preflight.unwrap(),"approval":null})
        };
        RuntimeBrokerRequest {
            protocol_version: crate::PROTOCOL_VERSION,
            request_type,
            payload: payload.as_object().unwrap().clone(),
        }
    }

    fn python_request(
        invocation_id: &str,
        source: &str,
        input_files: Value,
        request_type: RuntimeRequestType,
        preflight: Option<Value>,
    ) -> RuntimeBrokerRequest {
        let intent = json!({
            "invocation_id": invocation_id,
            "run_id": "run-python-1",
            "tool_name": "python.run",
            "tool_version": "1.0.0",
            "arguments": {
                "source": source,
                "input_files": input_files,
                "timeout_seconds": 45,
                "memory_mb": 256,
                "execution_mode": "module_test"
            },
            "project_id": "project-python-1",
            "task_id": "task-python-1",
            "requested_at": "2026-09-05T12:00:00Z"
        });
        let payload = if request_type == RuntimeRequestType::ToolPreflight {
            json!({"intent": intent, "descriptor": {
                "name": "python.run",
                "version": "1.0.0",
                "display_name": "Run Python",
                "description": "Run a staged Python program in the offline sandbox",
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
                "effects": ["execute_code"],
                "required_grants": ["sandbox.execute"],
                "default_data_flows": [],
                "timeout_seconds": 900,
                "cancellable": true,
                "category": "native"
            }})
        } else {
            json!({"intent": intent, "preflight": preflight.unwrap(), "approval": null})
        };
        RuntimeBrokerRequest {
            protocol_version: crate::PROTOCOL_VERSION,
            request_type,
            payload: payload.as_object().unwrap().clone(),
        }
    }
}
