//! Windows-first native tool executors.
//!
//! This module deliberately exposes one typed service instead of a raw command
//! or filesystem API. Preflight resolves every opaque grant, binds the result
//! to the intent digest, evaluates broker policy, and records the prepared
//! operation. Execution consumes that record once and, when required, consumes
//! an HMAC-bound fresh approval before any side effect.

mod filesystem;
mod network;
mod process;

pub use filesystem::{
    apply_exact_write, list_bounded, read_bounded, validate_exact_write,
    validate_relative_windows_path, ExactWrite, FileEntry, FileEntryKind,
};
pub(crate) use filesystem::{atomic_replace, sync_directory};
pub use network::{
    validate_public_https_url, validate_public_ip, HttpsBackend, HttpsResponse, StrictHttpsClient,
};
pub use process::{FixedGitRunner, GitInspection, ProcessOutput};

use crate::approval::{ApprovalChallenge, ApprovalManager, ApprovalProof};
use crate::audit::{AuditEvent, AuditStore};
use crate::grants::{
    FilesystemGrantStore, FilesystemPermission, GrantId, GrantScope, ResolvedPath,
};
use crate::policy::{Effect, PolicyDecision, PolicySet, ScopeKey};
use crate::registry::{
    DataDestination, ResourceLimits, ToolIntent, ToolPreflight, ToolResult, ToolResultStatus,
};
use crate::sandbox::{NetworkPolicy, ProcessState, ResolvedProcessPlan, SandboxBackend};
use crate::{BrokerError, Result};
use base64::prelude::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use url::Url;
use uuid::Uuid;

const MAX_STAGED_BYTES: usize = 16 * 1024 * 1024;
const MAX_STAGED_PROPOSALS: usize = 256;
const MAX_PREPARED_OPERATIONS: usize = 1_024;
const MAX_CANCEL_TOMBSTONES: usize = 4_096;
const MAX_PATCH_FILES: usize = 128;
const MAX_WEB_BYTES: usize = 8 * 1024 * 1024;
const MAX_SANDBOX_SCRIPT_BYTES: usize = 1024 * 1024;
const MAX_SANDBOX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub trait LocalModelBackend: Send + Sync {
    fn execute(&self, operation: &LocalModelOperation, limits: &ResourceLimits) -> Result<Value>;
    fn cancel(&self, execution_id: &str) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct DisabledLocalModelBackend;

impl LocalModelBackend for DisabledLocalModelBackend {
    fn execute(&self, _operation: &LocalModelOperation, _limits: &ResourceLimits) -> Result<Value> {
        Err(BrokerError::InvalidConfig(
            "no local-model operation proxy is configured".into(),
        ))
    }

    fn cancel(&self, _execution_id: &str) -> Result<()> {
        Err(BrokerError::NotFound("local-model execution".into()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "operation")]
pub enum LocalModelOperation {
    Discover,
    Download {
        execution_id: String,
        catalog_id: String,
        source: Url,
        expected_sha256: String,
    },
    Load {
        execution_id: String,
        model_id: String,
        context_tokens: u32,
    },
    Unload {
        execution_id: String,
        model_id: String,
    },
    Remove {
        execution_id: String,
        model_id: String,
    },
}

impl LocalModelOperation {
    fn validate(&self) -> Result<()> {
        let validate_id = |value: &str| {
            if value.is_empty()
                || value.len() > 256
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
                })
            {
                Err(BrokerError::InvalidConfig(
                    "invalid local-model identifier".into(),
                ))
            } else {
                Ok(())
            }
        };
        match self {
            Self::Discover => Ok(()),
            Self::Download {
                execution_id,
                catalog_id,
                source,
                expected_sha256,
            } => {
                validate_id(execution_id)?;
                validate_id(catalog_id)?;
                validate_public_https_url(source)?;
                validate_sha256(expected_sha256)
            }
            Self::Load {
                execution_id,
                model_id,
                context_tokens,
            } => {
                validate_id(execution_id)?;
                validate_id(model_id)?;
                if !(256..=1_048_576).contains(context_tokens) {
                    return Err(BrokerError::InvalidConfig(
                        "local-model context is outside safe bounds".into(),
                    ));
                }
                Ok(())
            }
            Self::Unload {
                execution_id,
                model_id,
            }
            | Self::Remove {
                execution_id,
                model_id,
            } => {
                validate_id(execution_id)?;
                validate_id(model_id)
            }
        }
    }

    fn execution_id(&self) -> Option<&str> {
        match self {
            Self::Discover => None,
            Self::Download { execution_id, .. }
            | Self::Load { execution_id, .. }
            | Self::Unload { execution_id, .. }
            | Self::Remove { execution_id, .. } => Some(execution_id),
        }
    }
}

pub struct NativeToolExecutorService {
    grants: Mutex<FilesystemGrantStore>,
    known_grants: Mutex<HashMap<String, GrantId>>,
    policy: RwLock<PolicySet>,
    approvals: Mutex<ApprovalManager>,
    prepared: Mutex<HashMap<Uuid, PreparedOperation>>,
    proposals: Mutex<HashMap<String, StagedProposal>>,
    cancelled: Mutex<HashSet<Uuid>>,
    audit: AuditStore,
    git: Option<Arc<FixedGitRunner>>,
    https: Arc<dyn HttpsBackend>,
    sandbox: Arc<dyn SandboxBackend>,
    local_models: Arc<dyn LocalModelBackend>,
    packaged_runtime_executable: Option<PathBuf>,
    sandbox_stage_root: PathBuf,
}

impl NativeToolExecutorService {
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        data_dir: &Path,
        policy: PolicySet,
        git_executable: Option<&Path>,
        packaged_runtime_executable: Option<&Path>,
        https: Arc<dyn HttpsBackend>,
        sandbox: Arc<dyn SandboxBackend>,
        local_models: Arc<dyn LocalModelBackend>,
    ) -> Result<Self> {
        let git = git_executable
            .map(FixedGitRunner::new)
            .transpose()?
            .map(Arc::new);
        let packaged_runtime_executable = packaged_runtime_executable
            .map(Path::canonicalize)
            .transpose()?;
        if packaged_runtime_executable
            .as_ref()
            .is_some_and(|path| !path.is_file())
        {
            return Err(BrokerError::InvalidConfig(
                "packaged runtime worker executable is not a file".into(),
            ));
        }
        let sandbox_stage_root = data_dir.join("runtime").join("sandbox-stages");
        std::fs::create_dir_all(&sandbox_stage_root)?;
        Ok(Self {
            grants: Mutex::new(FilesystemGrantStore::default()),
            known_grants: Mutex::new(HashMap::new()),
            policy: RwLock::new(policy),
            approvals: Mutex::new(ApprovalManager::random()),
            prepared: Mutex::new(HashMap::new()),
            proposals: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            audit: AuditStore::open(data_dir.join("security").join("native-tools.jsonl"))?,
            git,
            https,
            sandbox,
            local_models,
            packaged_runtime_executable,
            sandbox_stage_root,
        })
    }

    pub fn replace_policy(&self, policy: PolicySet) -> Result<()> {
        *self.policy.write().map_err(poisoned)? = policy;
        Ok(())
    }

    pub fn issue_filesystem_grant(
        &self,
        root: &Path,
        permissions: BTreeSet<FilesystemPermission>,
        scope: GrantScope,
        expires_unix_ms: i64,
    ) -> Result<String> {
        reject_raw_root(root)?;
        let grant = self.grants.lock().map_err(poisoned)?.issue(
            root,
            permissions,
            scope,
            expires_unix_ms,
        )?;
        let opaque = grant.expose_opaque().to_owned();
        self.known_grants
            .lock()
            .map_err(poisoned)?
            .insert(opaque.clone(), grant);
        Ok(opaque)
    }

    pub fn revoke_filesystem_grant(&self, opaque: &str) -> Result<bool> {
        let grant = self
            .known_grants
            .lock()
            .map_err(poisoned)?
            .remove(opaque)
            .ok_or(BrokerError::InvalidGrant)?;
        Ok(self.grants.lock().map_err(poisoned)?.revoke(&grant))
    }

    pub fn preflight(&self, intent: &ToolIntent, now_unix_ms: i64) -> Result<ToolPreflight> {
        if intent.tool_version != "1.0.0"
            || intent.user_visible_summary.trim().is_empty()
            || intent.user_visible_summary.len() > 4_096
        {
            return Err(BrokerError::InvalidConfig(
                "native tool version or user-visible summary is invalid".into(),
            ));
        }
        validate_limits(&intent.limits)?;
        let intent_digest = intent.digest()?;
        let operation = self.prepare_operation(intent, now_unix_ms)?;
        if matches!(&operation, Operation::SandboxPython { .. })
            && (intent.limits.max_memory_bytes.is_none() || intent.limits.max_cpu_seconds.is_none())
        {
            return Err(BrokerError::InvalidConfig(
                "sandboxed Python requires explicit memory and CPU limits".into(),
            ));
        }
        let required_effects = operation.effects();
        if intent.effects != required_effects {
            return Err(BrokerError::PermissionDenied(
                "native intent effects do not exactly match the operation".into(),
            ));
        }
        operation.validate_destinations(&intent.data_destinations)?;
        let resource_ids = operation.resource_ids();
        if intent.grant_ids != resource_ids {
            return Err(BrokerError::PermissionDenied(
                "native intent grant IDs do not exactly match resolved resources".into(),
            ));
        }
        let policy = self.policy.read().map_err(poisoned)?;
        let mut requires_approval =
            !policy.full_freedom && operation.always_requires_fresh_approval();
        for effect in &required_effects {
            let policy_resources = if resource_ids.is_empty() {
                vec![None]
            } else {
                resource_ids.iter().cloned().map(Some).collect()
            };
            for resource_id in policy_resources {
                match policy.evaluate(&ScopeKey {
                    tool_id: intent.tool_id.clone(),
                    effect: *effect,
                    resource_id,
                }) {
                    PolicyDecision::Allow(_) => {}
                    PolicyDecision::Ask(_) => requires_approval = true,
                    PolicyDecision::Deny(_) => {
                        return Err(BrokerError::PermissionDenied(
                            "native tool policy denied this operation".into(),
                        ))
                    }
                }
            }
        }
        drop(policy);
        let preflight = ToolPreflight {
            preflight_id: Uuid::now_v7(),
            intent_digest,
            resolved_resource_ids: resource_ids,
            effective_effects: required_effects,
            effective_destinations: intent.data_destinations.clone(),
            limits: intent.limits.clone(),
            requires_approval,
            disclosure: operation.disclosure(),
        };
        let mut prepared = self.prepared.lock().map_err(poisoned)?;
        if prepared.len() >= MAX_PREPARED_OPERATIONS {
            return Err(BrokerError::InvalidConfig(
                "native preflight capacity reached".into(),
            ));
        }
        prepared.insert(
            preflight.preflight_id,
            PreparedOperation {
                intent_id: intent.intent_id,
                intent_digest: preflight.intent_digest.clone(),
                preflight_digest: preflight.digest()?,
                operation,
            },
        );
        drop(prepared);
        self.audit.append(AuditEvent {
            category: "native_tool".into(),
            action: "preflight".into(),
            outcome: if requires_approval {
                "approval_required"
            } else {
                "allowed"
            }
            .into(),
            fields: json!({
                "intentId": intent.intent_id,
                "toolId": intent.tool_id,
                "resourceIds": preflight.resolved_resource_ids,
                "effects": preflight.effective_effects,
            }),
        })?;
        Ok(preflight)
    }

    pub fn issue_approval(
        &self,
        intent: &ToolIntent,
        preflight: &ToolPreflight,
        expires_unix_ms: i64,
    ) -> Result<ApprovalChallenge> {
        self.validate_prepared(intent, preflight)?;
        if !preflight.requires_approval {
            return Err(BrokerError::InvalidConfig(
                "approval was requested for an operation already allowed by policy".into(),
            ));
        }
        Ok(self.approvals.lock().map_err(poisoned)?.issue(
            preflight.intent_digest.clone(),
            preflight.digest()?,
            expires_unix_ms,
        ))
    }

    pub fn execute(
        &self,
        intent: &ToolIntent,
        preflight: &ToolPreflight,
        approval: Option<&ApprovalProof>,
        now_unix_ms: i64,
    ) -> Result<ToolResult> {
        self.validate_prepared(intent, preflight)?;
        if preflight.requires_approval {
            let proof = approval.ok_or(BrokerError::InvalidApproval)?;
            self.approvals
                .lock()
                .map_err(poisoned)?
                .redeem(proof, now_unix_ms)?;
        } else if approval.is_some() {
            return Err(BrokerError::InvalidApproval);
        }
        let prepared = self
            .prepared
            .lock()
            .map_err(poisoned)?
            .remove(&preflight.preflight_id)
            .ok_or_else(|| {
                BrokerError::Integrity("prepared operation was already consumed".into())
            })?;
        self.check_cancelled(intent.intent_id)?;
        let started = Instant::now();
        let result = self.execute_operation(intent, prepared.operation, preflight);
        let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let outcome = if result.is_ok() {
            "completed"
        } else {
            "failed"
        };
        self.audit.append(AuditEvent {
            category: "native_tool".into(),
            action: "execute".into(),
            outcome: outcome.into(),
            fields: json!({
                "intentId": intent.intent_id,
                "toolId": intent.tool_id,
                "durationMs": duration_ms,
                "error": result.as_ref().err().map(|_| "redacted native tool failure"),
            }),
        })?;
        let mut result = result?;
        result.duration_ms = duration_ms;
        Ok(result)
    }

    pub fn cancel(&self, intent_id: Uuid) -> Result<()> {
        let mut cancelled = self.cancelled.lock().map_err(poisoned)?;
        if cancelled.len() >= MAX_CANCEL_TOMBSTONES && !cancelled.contains(&intent_id) {
            return Err(BrokerError::InvalidConfig(
                "native cancellation capacity reached".into(),
            ));
        }
        cancelled.insert(intent_id);
        drop(cancelled);
        let execution_id = intent_id.to_string();
        if let Some(git) = &self.git {
            let _ = git.cancel(&execution_id);
        }
        let _ = self.sandbox.cancel(&execution_id);
        let _ = self.local_models.cancel(&execution_id);
        self.audit.append(AuditEvent {
            category: "native_tool".into(),
            action: "cancel".into(),
            outcome: "requested".into(),
            fields: json!({"intentId": intent_id}),
        })?;
        Ok(())
    }

    fn validate_prepared(&self, intent: &ToolIntent, preflight: &ToolPreflight) -> Result<()> {
        if intent.digest()? != preflight.intent_digest {
            return Err(BrokerError::Integrity(
                "preflight is not bound to the supplied intent".into(),
            ));
        }
        let prepared = self.prepared.lock().map_err(poisoned)?;
        let prepared = prepared
            .get(&preflight.preflight_id)
            .ok_or_else(|| BrokerError::Integrity("prepared operation is missing".into()))?;
        if prepared.intent_id != intent.intent_id
            || prepared.intent_digest != preflight.intent_digest
            || prepared.preflight_digest != preflight.digest()?
        {
            return Err(BrokerError::Integrity(
                "prepared operation binding does not match".into(),
            ));
        }
        Ok(())
    }

    fn prepare_operation(&self, intent: &ToolIntent, now: i64) -> Result<Operation> {
        match intent.tool_id.as_str() {
            "native.files.read" => {
                let args: FilePathArgs = parse(&intent.arguments)?;
                let resource = self.resolve(
                    &args.grant_id,
                    &args.relative_path,
                    FilesystemPermission::Read,
                    now,
                    args.project_id.as_deref(),
                )?;
                Ok(Operation::ReadFile { resource })
            }
            "native.files.list" => {
                let args: ListArgs = parse(&intent.arguments)?;
                let resource = self.resolve(
                    &args.grant_id,
                    &args.relative_path,
                    FilesystemPermission::List,
                    now,
                    args.project_id.as_deref(),
                )?;
                Ok(Operation::ListDirectory {
                    resource,
                    maximum_entries: args.maximum_entries.unwrap_or(2_000).min(10_000),
                })
            }
            "native.files.write_staged" | "native.git.patch_proposal" => {
                let args: ProposalArgs = parse(&intent.arguments)?;
                let project_id = args.project_id.clone();
                Ok(Operation::ProposeWrites {
                    writes: self.resolve_proposed_writes(args, now)?,
                    project_id,
                })
            }
            "native.files.write_apply" | "native.git.patch_apply" => {
                let args: ApplyProposalArgs = parse(&intent.arguments)?;
                let proposal = self
                    .proposals
                    .lock()
                    .map_err(poisoned)?
                    .get(&args.proposal_id)
                    .cloned()
                    .ok_or_else(|| BrokerError::NotFound("staged patch proposal".into()))?;
                let writes = self.resolve_proposed_writes(
                    ProposalArgs {
                        edits: proposal.edits,
                        project_id: proposal.project_id,
                    },
                    now,
                )?;
                Ok(Operation::ApplyWrites {
                    proposal_id: args.proposal_id,
                    writes,
                })
            }
            "native.git.inspect" => {
                let args: GitInspectArgs = parse(&intent.arguments)?;
                let resource = self.resolve(
                    &args.grant_id,
                    &args.relative_path,
                    FilesystemPermission::List,
                    now,
                    args.project_id.as_deref(),
                )?;
                Ok(Operation::GitInspect {
                    repository: resource,
                    inspection: args.inspection,
                })
            }
            "native.web.fetch" => {
                let args: FetchArgs = parse(&intent.arguments)?;
                validate_public_https_url(&args.url)?;
                Ok(Operation::WebFetch { url: args.url })
            }
            "native.web.search" => {
                let args: SearchArgs = parse(&intent.arguments)?;
                if args.query.trim().is_empty()
                    || args.query.len() > 2_048
                    || args.query.contains('\0')
                {
                    return Err(BrokerError::InvalidConfig(
                        "invalid web search query".into(),
                    ));
                }
                let search_origin = self.https.search_origin().ok_or_else(|| {
                    BrokerError::InvalidConfig(
                        "no broker-approved search endpoint is configured".into(),
                    )
                })?;
                Ok(Operation::WebSearch {
                    query: args.query,
                    search_origin,
                })
            }
            "native.sandbox.python" => {
                let args: PythonArgs = parse(&intent.arguments)?;
                let script = self.resolve(
                    &args.grant_id,
                    &args.script_relative,
                    FilesystemPermission::Read,
                    now,
                    args.project_id.as_deref(),
                )?;
                Ok(Operation::SandboxPython { script })
            }
            "native.models.manage" => {
                let operation: LocalModelOperation = parse(&intent.arguments)?;
                operation.validate()?;
                if operation
                    .execution_id()
                    .is_some_and(|execution_id| execution_id != intent.intent_id.to_string())
                {
                    return Err(BrokerError::Integrity(
                        "local-model execution lineage does not match the native intent".into(),
                    ));
                }
                Ok(Operation::LocalModel { operation })
            }
            "native.artifacts.export" => {
                let args: ArtifactExportArgs = parse(&intent.arguments)?;
                validate_opaque_identifier(&args.artifact_id)?;
                let bytes = BASE64_STANDARD.decode(args.content_base64).map_err(|_| {
                    BrokerError::InvalidConfig("artifact content is not valid base64".into())
                })?;
                let permission = if args.expected_sha256.is_some() {
                    FilesystemPermission::Modify
                } else {
                    FilesystemPermission::Create
                };
                let resource = self.resolve(
                    &args.grant_id,
                    &args.relative_path,
                    permission,
                    now,
                    args.project_id.as_deref(),
                )?;
                Ok(Operation::ArtifactExport {
                    artifact_id: args.artifact_id,
                    write: ExactWrite {
                        resource,
                        bytes,
                        expected_sha256: args.expected_sha256,
                    },
                })
            }
            _ => Err(BrokerError::NotFound(intent.tool_id.clone())),
        }
    }

    fn resolve_proposed_writes(&self, args: ProposalArgs, now: i64) -> Result<Vec<ProposedWrite>> {
        if args.edits.is_empty() || args.edits.len() > MAX_PATCH_FILES {
            return Err(BrokerError::InvalidConfig(
                "patch file count is outside bounds".into(),
            ));
        }
        let mut total = 0usize;
        let mut unique = HashSet::new();
        let mut writes = Vec::with_capacity(args.edits.len());
        for edit in args.edits {
            if !unique.insert((edit.grant_id.clone(), edit.relative_path.clone())) {
                return Err(BrokerError::Duplicate("patch target".into()));
            }
            let bytes = BASE64_STANDARD.decode(&edit.content_base64).map_err(|_| {
                BrokerError::InvalidConfig("patch content is not valid base64".into())
            })?;
            total = total.saturating_add(bytes.len());
            if total > MAX_STAGED_BYTES {
                return Err(BrokerError::InvalidConfig(
                    "patch proposal exceeds staging bound".into(),
                ));
            }
            if let Some(hash) = &edit.expected_sha256 {
                validate_sha256(hash)?;
            }
            let permission = if edit.expected_sha256.is_some() {
                FilesystemPermission::Modify
            } else {
                FilesystemPermission::Create
            };
            let resource = self.resolve(
                &edit.grant_id,
                &edit.relative_path,
                permission,
                now,
                args.project_id.as_deref(),
            )?;
            writes.push(ProposedWrite {
                grant_id: edit.grant_id,
                relative_path: edit.relative_path,
                content_base64: edit.content_base64,
                expected_sha256: edit.expected_sha256,
                resource,
                bytes,
            });
        }
        Ok(writes)
    }

    fn resolve(
        &self,
        opaque: &str,
        relative: &Path,
        permission: FilesystemPermission,
        now: i64,
        project_id: Option<&str>,
    ) -> Result<ResolvedPath> {
        validate_relative_windows_path(relative)?;
        let grant = self
            .known_grants
            .lock()
            .map_err(poisoned)?
            .get(opaque)
            .cloned()
            .ok_or(BrokerError::InvalidGrant)?;
        self.grants
            .lock()
            .map_err(poisoned)?
            .resolve(&grant, relative, permission, now, project_id)
    }

    fn check_cancelled(&self, intent_id: Uuid) -> Result<()> {
        if self.cancelled.lock().map_err(poisoned)?.remove(&intent_id) {
            Err(BrokerError::InvalidTransition {
                from: "cancelled".into(),
                to: "running".into(),
            })
        } else {
            Ok(())
        }
    }

    fn execute_operation(
        &self,
        intent: &ToolIntent,
        operation: Operation,
        preflight: &ToolPreflight,
    ) -> Result<ToolResult> {
        let completed =
            |output: Value, resources: BTreeSet<String>, provenance: Vec<String>| ToolResult {
                intent_id: intent.intent_id,
                status: ToolResultStatus::Completed,
                output,
                generated_resource_ids: resources,
                duration_ms: 0,
                provenance,
                redacted_error: None,
            };
        match operation {
            Operation::ReadFile { resource } => {
                let bytes = read_bounded(&resource, preflight.limits.max_output_bytes)?;
                let digest = hex::encode(Sha256::digest(&bytes));
                Ok(completed(
                    json!({"contentBase64": BASE64_STANDARD.encode(bytes), "sha256": digest}),
                    BTreeSet::new(),
                    vec![format!(
                        "filesystem:{}",
                        resource.grant_id().expose_opaque()
                    )],
                ))
            }
            Operation::ListDirectory {
                resource,
                maximum_entries,
            } => {
                let entries = list_bounded(&resource, maximum_entries)?;
                Ok(completed(
                    json!({"entries": entries}),
                    BTreeSet::new(),
                    vec![format!(
                        "filesystem:{}",
                        resource.grant_id().expose_opaque()
                    )],
                ))
            }
            Operation::ProposeWrites { writes, project_id } => {
                let proposal_id = format!("patch_{}", Uuid::now_v7());
                let edits = writes.iter().map(ProposedWrite::wire).collect::<Vec<_>>();
                let summary = writes
                    .iter()
                    .map(|write| {
                        json!({
                            "resourceId": write.resource.grant_id().expose_opaque(),
                            "relativePath": write.relative_path,
                            "expectedSha256": write.expected_sha256,
                            "replacementSha256": hex::encode(Sha256::digest(&write.bytes)),
                            "replacementBytes": write.bytes.len(),
                        })
                    })
                    .collect::<Vec<_>>();
                let mut proposals = self.proposals.lock().map_err(poisoned)?;
                if proposals.len() >= MAX_STAGED_PROPOSALS {
                    return Err(BrokerError::InvalidConfig(
                        "staged patch capacity reached".into(),
                    ));
                }
                proposals.insert(proposal_id.clone(), StagedProposal { edits, project_id });
                Ok(completed(
                    json!({"proposalId": proposal_id, "edits": summary}),
                    [proposal_id.clone()].into_iter().collect(),
                    vec!["broker:immutable-staging".into()],
                ))
            }
            Operation::ApplyWrites {
                proposal_id,
                writes,
            } => {
                for write in &writes {
                    validate_exact_write(
                        &ExactWrite {
                            resource: write.resource.clone(),
                            bytes: write.bytes.clone(),
                            expected_sha256: write.expected_sha256.clone(),
                        },
                        preflight.limits.max_output_bytes.min(MAX_STAGED_BYTES),
                    )?;
                }
                for write in &writes {
                    apply_exact_write(
                        &ExactWrite {
                            resource: write.resource.clone(),
                            bytes: write.bytes.clone(),
                            expected_sha256: write.expected_sha256.clone(),
                        },
                        preflight.limits.max_output_bytes.min(MAX_STAGED_BYTES),
                    )?;
                }
                self.proposals
                    .lock()
                    .map_err(poisoned)?
                    .remove(&proposal_id);
                Ok(completed(
                    json!({"proposalId": proposal_id, "appliedFiles": writes.len()}),
                    BTreeSet::new(),
                    vec!["broker:exact-revision-apply".into()],
                ))
            }
            Operation::GitInspect {
                repository,
                inspection,
            } => {
                repository.revalidate()?;
                let runner = self.git.as_ref().ok_or_else(|| {
                    BrokerError::InvalidConfig("fixed Git executable is not configured".into())
                })?;
                let output = runner.inspect(
                    &intent.intent_id.to_string(),
                    repository.as_path(),
                    &inspection,
                    &preflight.limits,
                )?;
                let status = if output.timed_out {
                    ToolResultStatus::TimedOut
                } else if output.output_exceeded {
                    ToolResultStatus::OutputLimitExceeded
                } else if output.cancelled {
                    ToolResultStatus::Cancelled
                } else if output.exit_code == 0 {
                    ToolResultStatus::Completed
                } else {
                    ToolResultStatus::Failed
                };
                Ok(ToolResult {
                    intent_id: intent.intent_id,
                    status,
                    output: json!({"exitCode": output.exit_code, "stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr)}),
                    generated_resource_ids: BTreeSet::new(),
                    duration_ms: 0,
                    provenance: vec![
                        "git:fixed-binary-typed-arguments".into(),
                        format!("filesystem:{}", repository.grant_id().expose_opaque()),
                    ],
                    redacted_error: (output.exit_code != 0).then(|| "Git inspection failed".into()),
                })
            }
            Operation::WebFetch { url } => self.execute_web(
                intent,
                self.https.fetch(
                    &url,
                    preflight.limits.timeout_ms,
                    preflight.limits.max_output_bytes.min(MAX_WEB_BYTES),
                )?,
            ),
            Operation::WebSearch { query, .. } => self.execute_web(
                intent,
                self.https.search(
                    &query,
                    preflight.limits.timeout_ms,
                    preflight.limits.max_output_bytes.min(MAX_WEB_BYTES),
                )?,
            ),
            Operation::SandboxPython { script } => {
                self.execute_sandbox_worker(intent, preflight, &script)
            }
            Operation::LocalModel { operation } => {
                let output = self.local_models.execute(&operation, &preflight.limits)?;
                Ok(completed(
                    output,
                    BTreeSet::new(),
                    vec!["runtime:local-model-proxy".into()],
                ))
            }
            Operation::ArtifactExport { artifact_id, write } => {
                let sha256 = apply_exact_write(
                    &write,
                    preflight.limits.max_output_bytes.min(MAX_STAGED_BYTES),
                )?;
                Ok(completed(
                    json!({"artifactId": artifact_id, "sha256": sha256, "bytes": write.bytes.len()}),
                    BTreeSet::new(),
                    vec![
                        format!("artifact:{artifact_id}"),
                        format!("filesystem:{}", write.resource.grant_id().expose_opaque()),
                    ],
                ))
            }
        }
    }

    fn execute_web(&self, intent: &ToolIntent, response: HttpsResponse) -> Result<ToolResult> {
        let success = (200..300).contains(&response.status);
        let mut final_url = Url::parse(&response.final_url)?;
        validate_public_https_url(&final_url)?;
        final_url.set_query(None);
        final_url.set_fragment(None);
        Ok(ToolResult {
            intent_id: intent.intent_id,
            status: if success {
                ToolResultStatus::Completed
            } else {
                ToolResultStatus::Failed
            },
            output: json!({"url": final_url, "status": response.status, "contentType": response.content_type, "contentBase64": BASE64_STANDARD.encode(response.body)}),
            generated_resource_ids: BTreeSet::new(),
            duration_ms: 0,
            provenance: vec!["network:dns-pinned-public-https".into()],
            redacted_error: (!success).then(|| "HTTPS origin returned an error status".into()),
        })
    }

    fn execute_sandbox_worker(
        &self,
        intent: &ToolIntent,
        preflight: &ToolPreflight,
        script: &ResolvedPath,
    ) -> Result<ToolResult> {
        let runtime = self.packaged_runtime_executable.as_ref().ok_or_else(|| {
            BrokerError::SandboxUnavailable(
                "packaged sandbox Python worker is not configured".into(),
            )
        })?;
        let source = read_bounded(script, MAX_SANDBOX_SCRIPT_BYTES)?;
        let script_sha256 = hex::encode(Sha256::digest(&source));
        let leaf_token = Uuid::now_v7().to_string();
        let stage = self.sandbox_stage_root.join(&leaf_token);
        std::fs::create_dir(&stage)?;
        let _cleanup = StageCleanup(stage.clone());
        let script_name = format!("{leaf_token}.py.input");
        write_new_synced(&stage.join(&script_name), &source, true)?;

        let request_id = intent.intent_id.to_string();
        let stage_token = Uuid::now_v7().to_string();
        let request = json!({
            "version": 1,
            "kind": "python.execute",
            "request_id": request_id,
            "stage_token": stage_token,
            "payload": {
                "script": {
                    "staged_name": script_name,
                    "size": source.len(),
                    "sha256": script_sha256,
                },
                "inputs": [],
                "limits": {
                    "deadline_unix_ms": chrono::Utc::now().timestamp_millis()
                        .saturating_add(preflight.limits.timeout_ms as i64),
                    "max_script_bytes": MAX_SANDBOX_SCRIPT_BYTES,
                    "max_input_bytes": 1,
                    "max_output_bytes": preflight.limits.max_output_bytes,
                    "max_result_characters": preflight.limits.max_output_bytes,
                    "max_stdout_characters": preflight.limits.max_output_bytes,
                }
            }
        });
        let request_frame = encode_worker_frame(&serde_json::to_vec(&request)?)?;
        write_new_synced(&stage.join("python-request.frame"), &request_frame, true)?;
        write_new_synced(&stage.join("python-response.frame"), b"", false)?;

        let sandbox_output = self.sandbox.execute(&ResolvedProcessPlan {
            execution_id: intent.intent_id.to_string(),
            executable: runtime.clone(),
            arguments: vec![
                "--sandbox-python-worker".into(),
                "--stage-root".into(),
                ".".into(),
            ],
            working_directory: stage.clone(),
            environment: Default::default(),
            network: NetworkPolicy::Denied,
            network_origins: BTreeSet::new(),
            limits: preflight.limits.clone(),
            read_only_root: false,
        })?;
        let status = match sandbox_output.state {
            ProcessState::Completed => ToolResultStatus::Completed,
            ProcessState::Cancelled => ToolResultStatus::Cancelled,
            ProcessState::TimedOut => ToolResultStatus::TimedOut,
            ProcessState::OutputLimitExceeded => ToolResultStatus::OutputLimitExceeded,
            _ => ToolResultStatus::Failed,
        };
        if status != ToolResultStatus::Completed {
            return Ok(ToolResult {
                intent_id: intent.intent_id,
                status,
                output: json!({"exitCode": sandbox_output.exit_code}),
                generated_resource_ids: BTreeSet::new(),
                duration_ms: 0,
                provenance: vec!["sandbox:packaged-worker-appcontainer-job".into()],
                redacted_error: Some("sandbox worker did not complete".into()),
            });
        }

        let response_bytes = read_worker_frame(
            &stage.join("python-response.frame"),
            MAX_SANDBOX_FRAME_BYTES.min(preflight.limits.max_output_bytes),
        )?;
        let response: Value = serde_json::from_slice(&response_bytes)?;
        if response.get("version").and_then(Value::as_u64) != Some(1)
            || response.get("request_id").and_then(Value::as_str) != Some(request_id.as_str())
            || response.get("stage_token").and_then(Value::as_str) != Some(stage_token.as_str())
            || !matches!(
                response.get("kind").and_then(Value::as_str),
                Some("python.execute.complete" | "python.execute.failed")
            )
        {
            return Err(BrokerError::Integrity(
                "sandbox worker response binding is invalid".into(),
            ));
        }
        let completed =
            response.get("kind").and_then(Value::as_str) == Some("python.execute.complete");
        Ok(ToolResult {
            intent_id: intent.intent_id,
            status: if completed {
                ToolResultStatus::Completed
            } else {
                ToolResultStatus::Failed
            },
            output: response,
            generated_resource_ids: BTreeSet::new(),
            duration_ms: 0,
            provenance: vec!["sandbox:packaged-worker-appcontainer-job".into()],
            redacted_error: (!completed).then(|| "sandbox worker rejected execution".into()),
        })
    }
}

#[derive(Debug)]
struct PreparedOperation {
    intent_id: Uuid,
    intent_digest: String,
    preflight_digest: String,
    operation: Operation,
}

#[derive(Debug, Clone)]
struct StagedProposal {
    edits: Vec<ProposalEdit>,
    project_id: Option<String>,
}

#[derive(Debug)]
enum Operation {
    ReadFile {
        resource: ResolvedPath,
    },
    ListDirectory {
        resource: ResolvedPath,
        maximum_entries: usize,
    },
    ProposeWrites {
        writes: Vec<ProposedWrite>,
        project_id: Option<String>,
    },
    ApplyWrites {
        proposal_id: String,
        writes: Vec<ProposedWrite>,
    },
    GitInspect {
        repository: ResolvedPath,
        inspection: GitInspection,
    },
    WebFetch {
        url: Url,
    },
    WebSearch {
        query: String,
        search_origin: String,
    },
    SandboxPython {
        script: ResolvedPath,
    },
    LocalModel {
        operation: LocalModelOperation,
    },
    ArtifactExport {
        artifact_id: String,
        write: ExactWrite,
    },
}

impl Operation {
    fn effects(&self) -> BTreeSet<Effect> {
        match self {
            Self::ReadFile { .. }
            | Self::ListDirectory { .. }
            | Self::ProposeWrites { .. }
            | Self::GitInspect { .. } => [Effect::ReadFiles].into_iter().collect(),
            Self::ApplyWrites { .. } => [Effect::WriteFiles].into_iter().collect(),
            Self::WebFetch { .. } | Self::WebSearch { .. } => {
                [Effect::NetworkRead].into_iter().collect()
            }
            Self::SandboxPython { .. } => [Effect::ExecuteSandboxed].into_iter().collect(),
            Self::LocalModel {
                operation: LocalModelOperation::Download { .. },
            } => [Effect::ManageModels, Effect::NetworkRead]
                .into_iter()
                .collect(),
            Self::LocalModel { .. } => [Effect::ManageModels].into_iter().collect(),
            Self::ArtifactExport { .. } => [Effect::ManageArtifacts, Effect::WriteFiles]
                .into_iter()
                .collect(),
        }
    }

    fn resource_ids(&self) -> BTreeSet<String> {
        match self {
            Self::ReadFile { resource }
            | Self::ListDirectory { resource, .. }
            | Self::GitInspect {
                repository: resource,
                ..
            } => [resource.grant_id().expose_opaque().to_owned()]
                .into_iter()
                .collect(),
            Self::ProposeWrites { writes, .. } | Self::ApplyWrites { writes, .. } => {
                writes.iter().map(|write| write.grant_id.clone()).collect()
            }
            Self::SandboxPython { script } => [script.grant_id().expose_opaque().to_owned()]
                .into_iter()
                .collect(),
            Self::ArtifactExport { write, .. } => {
                [write.resource.grant_id().expose_opaque().to_owned()]
                    .into_iter()
                    .collect()
            }
            Self::WebFetch { .. } | Self::WebSearch { .. } | Self::LocalModel { .. } => {
                BTreeSet::new()
            }
        }
    }

    fn always_requires_fresh_approval(&self) -> bool {
        matches!(self, Self::ApplyWrites { .. })
    }

    fn disclosure(&self) -> String {
        match self {
            Self::ReadFile { .. } => "Read one exact file from an opaque local grant.".into(),
            Self::ListDirectory { .. } => "List one exact directory from an opaque local grant; links are omitted.".into(),
            Self::ProposeWrites { writes, .. } => format!("Stage {} exact file replacement(s) in broker memory without writing.", writes.len()),
            Self::ApplyWrites { writes, .. } => format!("Write {} exact staged file replacement(s) after policy authorization and revision checks.", writes.len()),
            Self::GitInspect { .. } => "Run one read-only typed Git inspection using the fixed Git executable.".into(),
            Self::WebFetch { url } => format!("Send a bounded HTTPS GET to {}.", origin(url)),
            Self::WebSearch { .. } => "Send a search query to the configured public HTTPS search origin.".into(),
            Self::SandboxPython { .. } => "Run staged Python with denied networking in the Windows AppContainer/Job sandbox.".into(),
            Self::LocalModel { operation: LocalModelOperation::Download { source, .. } } => format!("Download a checksummed local model from {} through the packaged runtime.", origin(source)),
            Self::LocalModel { .. } => "Forward one typed local-model management operation to the packaged runtime.".into(),
            Self::ArtifactExport { .. } => "Export one artifact revision to an exact opaque filesystem grant.".into(),
        }
    }

    fn validate_destinations(&self, destinations: &BTreeSet<DataDestination>) -> Result<()> {
        match self {
            Self::WebFetch { url } => {
                let expected = DataDestination::Origin(origin(url));
                if destinations != &[expected].into_iter().collect() {
                    return Err(BrokerError::PermissionDenied(
                        "web destination does not match the resolved HTTPS origin".into(),
                    ));
                }
            }
            Self::WebSearch { search_origin, .. } => {
                if destinations
                    != &[DataDestination::Origin(search_origin.clone())]
                        .into_iter()
                        .collect()
                {
                    return Err(BrokerError::PermissionDenied(
                        "search must disclose exactly one HTTPS origin".into(),
                    ));
                }
            }
            Self::LocalModel {
                operation: LocalModelOperation::Download { source, .. },
            } => {
                if destinations
                    != &[DataDestination::Origin(origin(source))]
                        .into_iter()
                        .collect()
                {
                    return Err(BrokerError::PermissionDenied(
                        "model download destination does not match its public HTTPS origin".into(),
                    ));
                }
            }
            _ => {
                if destinations != &[DataDestination::LocalOnly].into_iter().collect() {
                    return Err(BrokerError::PermissionDenied(
                        "local native operation disclosed a non-local destination".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct ProposedWrite {
    grant_id: String,
    relative_path: PathBuf,
    content_base64: String,
    expected_sha256: Option<String>,
    resource: ResolvedPath,
    bytes: Vec<u8>,
}

impl ProposedWrite {
    fn wire(&self) -> ProposalEdit {
        ProposalEdit {
            grant_id: self.grant_id.clone(),
            relative_path: self.relative_path.clone(),
            content_base64: self.content_base64.clone(),
            expected_sha256: self.expected_sha256.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilePathArgs {
    grant_id: String,
    relative_path: PathBuf,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    grant_id: String,
    relative_path: PathBuf,
    project_id: Option<String>,
    maximum_entries: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalEdit {
    grant_id: String,
    relative_path: PathBuf,
    content_base64: String,
    expected_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalArgs {
    edits: Vec<ProposalEdit>,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyProposalArgs {
    proposal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitInspectArgs {
    grant_id: String,
    relative_path: PathBuf,
    project_id: Option<String>,
    inspection: GitInspection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchArgs {
    url: Url,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchArgs {
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PythonArgs {
    grant_id: String,
    script_relative: PathBuf,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactExportArgs {
    grant_id: String,
    relative_path: PathBuf,
    project_id: Option<String>,
    artifact_id: String,
    content_base64: String,
    expected_sha256: Option<String>,
}

fn parse<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| {
        BrokerError::InvalidConfig("native tool arguments do not match the versioned schema".into())
    })
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(BrokerError::InvalidConfig("invalid SHA-256 digest".into()))
    }
}

fn validate_opaque_identifier(value: &str) -> Result<()> {
    if value.len() >= 16
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        Ok(())
    } else {
        Err(BrokerError::InvalidConfig(
            "invalid opaque native resource identifier".into(),
        ))
    }
}

fn validate_limits(limits: &ResourceLimits) -> Result<()> {
    if limits.timeout_ms == 0
        || limits.timeout_ms > 30 * 60 * 1000
        || limits.max_output_bytes == 0
        || limits.max_output_bytes > 16 * 1024 * 1024
    {
        Err(BrokerError::InvalidConfig(
            "native tool limits are outside hard bounds".into(),
        ))
    } else {
        Ok(())
    }
}

fn origin(url: &Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or("invalid"))
}

fn encode_worker_frame(payload: &[u8]) -> Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_SANDBOX_FRAME_BYTES {
        return Err(BrokerError::FrameTooLarge {
            actual: payload.len(),
            maximum: MAX_SANDBOX_FRAME_BYTES,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| BrokerError::FrameTooLarge {
        actual: payload.len(),
        maximum: MAX_SANDBOX_FRAME_BYTES,
    })?;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

fn read_worker_frame(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > (maximum as u64).saturating_add(4) {
        return Err(BrokerError::FrameTooLarge {
            actual: metadata.len() as usize,
            maximum,
        });
    }
    let mut header = [0u8; 4];
    file.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > maximum || metadata.len() != length as u64 + 4 {
        return Err(BrokerError::InvalidEnvelope(
            "sandbox worker frame length is invalid".into(),
        ));
    }
    let mut payload = vec![0u8; length];
    file.read_exact(&mut payload)?;
    Ok(payload)
}

fn write_new_synced(path: &Path, bytes: &[u8], read_only: bool) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if read_only {
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

struct StageCleanup(PathBuf);

impl Drop for StageCleanup {
    fn drop(&mut self) {
        if self.0.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&self.0) {
                for entry in entries.flatten() {
                    let _ = make_writable_for_cleanup(&entry.path());
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(windows)]
fn make_writable_for_cleanup(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_READONLY};
    let attributes = std::fs::metadata(path)?.file_attributes() & !FILE_ATTRIBUTE_READONLY;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe { SetFileAttributesW(wide.as_ptr(), attributes) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(unix)]
fn make_writable_for_cleanup(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o200);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

fn reject_raw_root(root: &Path) -> Result<()> {
    if !root.is_absolute() {
        return Err(BrokerError::PathEscape);
    }
    let text = root.to_string_lossy().to_ascii_lowercase();
    if text.starts_with("\\\\")
        || text.starts_with("//")
        || text.starts_with("\\\\.\\")
        || text.starts_with("\\\\?\\unc\\")
    {
        return Err(BrokerError::PermissionDenied(
            "UNC and device roots cannot receive grants".into(),
        ));
    }
    Ok(())
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> BrokerError {
    BrokerError::Integrity("native tool state lock was poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::CategoryDecision;
    use crate::sandbox::{DisabledSandbox, SandboxOutput};
    use tempfile::tempdir;

    #[derive(Debug)]
    struct NoNetwork;
    impl HttpsBackend for NoNetwork {
        fn fetch(&self, _url: &Url, _timeout_ms: u64, _maximum: usize) -> Result<HttpsResponse> {
            Err(BrokerError::PermissionDenied(
                "test network disabled".into(),
            ))
        }
        fn search(&self, _query: &str, _timeout_ms: u64, _maximum: usize) -> Result<HttpsResponse> {
            Err(BrokerError::PermissionDenied(
                "test network disabled".into(),
            ))
        }

        fn search_origin(&self) -> Option<String> {
            Some("https://search.example".into())
        }
    }

    #[derive(Debug, Default)]
    struct StaticNetwork {
        fetches: Mutex<Vec<String>>,
    }

    impl HttpsBackend for StaticNetwork {
        fn fetch(&self, url: &Url, _timeout_ms: u64, maximum: usize) -> Result<HttpsResponse> {
            self.fetches.lock().map_err(poisoned)?.push(url.to_string());
            let body = b"bounded".to_vec();
            assert!(body.len() <= maximum);
            Ok(HttpsResponse {
                final_url: "https://example.com/result?server-secret=redacted".into(),
                status: 200,
                content_type: Some("text/plain".into()),
                body,
            })
        }

        fn search(&self, _query: &str, _timeout_ms: u64, _maximum: usize) -> Result<HttpsResponse> {
            Err(BrokerError::PermissionDenied("search disabled".into()))
        }

        fn search_origin(&self) -> Option<String> {
            Some("https://search.example".into())
        }
    }

    #[derive(Debug, Default)]
    struct RecordingSandbox {
        requests: Mutex<Vec<Value>>,
    }

    impl SandboxBackend for RecordingSandbox {
        fn execute(&self, plan: &ResolvedProcessPlan) -> Result<SandboxOutput> {
            assert_eq!(
                plan.arguments,
                ["--sandbox-python-worker", "--stage-root", "."]
            );
            assert_eq!(plan.network, NetworkPolicy::Denied);
            assert!(plan.environment.is_empty());
            let request = serde_json::from_slice::<Value>(&read_worker_frame(
                &plan.working_directory.join("python-request.frame"),
                MAX_SANDBOX_FRAME_BYTES,
            )?)?;
            self.requests
                .lock()
                .map_err(poisoned)?
                .push(request.clone());
            let response = json!({
                "version": 1,
                "kind": "python.execute.complete",
                "request_id": request["request_id"],
                "stage_token": request["stage_token"],
                "result": {
                    "status": "complete",
                    "stdout": "six\n",
                    "value": 6,
                    "metadata": {"network_access": false}
                }
            });
            let destination = plan.working_directory.join("python-response.frame");
            make_writable_for_cleanup(&destination)?;
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(destination)?;
            file.write_all(&encode_worker_frame(&serde_json::to_vec(&response)?)?)?;
            file.sync_all()?;
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

    fn service(root: &Path) -> NativeToolExecutorService {
        let mut policy = PolicySet::default();
        for effect in [
            Effect::ReadFiles,
            Effect::WriteFiles,
            Effect::NetworkRead,
            Effect::ExecuteSandboxed,
            Effect::ManageModels,
            Effect::ManageArtifacts,
        ] {
            policy.category.insert(effect, CategoryDecision::Allow);
        }
        NativeToolExecutorService::open(
            root,
            policy,
            None,
            None,
            Arc::new(NoNetwork),
            Arc::new(DisabledSandbox),
            Arc::new(DisabledLocalModelBackend),
        )
        .unwrap()
    }

    fn intent(tool_id: &str, arguments: Value, effects: BTreeSet<Effect>) -> ToolIntent {
        fn collect_grants(value: &Value, grants: &mut BTreeSet<String>) {
            match value {
                Value::Object(object) => {
                    if let Some(grant) = object.get("grantId").and_then(Value::as_str) {
                        grants.insert(grant.to_owned());
                    }
                    for value in object.values() {
                        collect_grants(value, grants);
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        collect_grants(value, grants);
                    }
                }
                _ => {}
            }
        }
        let mut grant_ids = BTreeSet::new();
        collect_grants(&arguments, &mut grant_ids);
        ToolIntent {
            intent_id: Uuid::now_v7(),
            tool_id: tool_id.into(),
            tool_version: "1.0.0".into(),
            arguments,
            effects,
            grant_ids,
            data_destinations: [DataDestination::LocalOnly].into_iter().collect(),
            limits: ResourceLimits {
                timeout_ms: 2_000,
                max_output_bytes: 1024 * 1024,
                max_memory_bytes: Some(64 * 1024 * 1024),
                max_cpu_seconds: Some(2),
            },
            user_visible_summary: "test".into(),
        }
    }

    #[test]
    fn preflight_binds_opaque_grant_and_never_discloses_raw_path() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), b"hello").unwrap();
        let service = service(root.path());
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Read].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let intent = intent(
            "native.files.read",
            json!({"grantId": grant, "relativePath": "note.txt", "projectId": null}),
            [Effect::ReadFiles].into_iter().collect(),
        );
        let preflight = service.preflight(&intent, 1_000).unwrap();
        let encoded = serde_json::to_string(&preflight).unwrap();
        assert!(!encoded.contains(root.path().to_string_lossy().as_ref()));
        let result = service.execute(&intent, &preflight, None, 1_001).unwrap();
        assert_eq!(
            BASE64_STANDARD
                .decode(result.output["contentBase64"].as_str().unwrap())
                .unwrap(),
            b"hello"
        );
        assert!(service.execute(&intent, &preflight, None, 1_002).is_err());
    }

    #[test]
    fn patch_apply_always_requires_one_use_fresh_approval_and_exact_revision() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), b"before").unwrap();
        let service = service(root.path());
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Modify].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let proposal_intent = intent(
            "native.git.patch_proposal",
            json!({"edits": [{"grantId": grant, "relativePath": "a.txt", "contentBase64": BASE64_STANDARD.encode(b"after"), "expectedSha256": hex::encode(Sha256::digest(b"before"))}], "projectId": null}),
            [Effect::ReadFiles].into_iter().collect(),
        );
        let proposal_preflight = service.preflight(&proposal_intent, 1_000).unwrap();
        let proposal = service
            .execute(&proposal_intent, &proposal_preflight, None, 1_001)
            .unwrap();
        let proposal_id = proposal.output["proposalId"].as_str().unwrap();
        let mut apply_intent = intent(
            "native.git.patch_apply",
            json!({"proposalId": proposal_id}),
            [Effect::WriteFiles].into_iter().collect(),
        );
        apply_intent.grant_ids.insert(grant.clone());
        let apply_preflight = service.preflight(&apply_intent, 1_002).unwrap();
        assert!(apply_preflight.requires_approval);
        assert!(service
            .execute(&apply_intent, &apply_preflight, None, 1_003)
            .is_err());
        let challenge = service
            .issue_approval(&apply_intent, &apply_preflight, 2_000)
            .unwrap();
        let proof = ApprovalProof::from(&challenge);
        service
            .execute(&apply_intent, &apply_preflight, Some(&proof), 1_004)
            .unwrap();
        assert_eq!(std::fs::read(root.path().join("a.txt")).unwrap(), b"after");
        assert!(service
            .execute(&apply_intent, &apply_preflight, Some(&proof), 1_005)
            .is_err());
    }

    #[test]
    fn full_freedom_skips_patch_prompt_but_keeps_grant_and_revision_checks() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), b"before").unwrap();
        let service = service(root.path());
        service.policy.write().unwrap().full_freedom = true;
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Modify].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let proposal_intent = intent(
            "native.git.patch_proposal",
            json!({"edits": [{"grantId": grant, "relativePath": "a.txt", "contentBase64": BASE64_STANDARD.encode(b"after"), "expectedSha256": hex::encode(Sha256::digest(b"before"))}], "projectId": null}),
            [Effect::ReadFiles].into_iter().collect(),
        );
        let proposal_preflight = service.preflight(&proposal_intent, 1_000).unwrap();
        let proposal = service
            .execute(&proposal_intent, &proposal_preflight, None, 1_001)
            .unwrap();
        let mut apply_intent = intent(
            "native.git.patch_apply",
            json!({"proposalId": proposal.output["proposalId"]}),
            [Effect::WriteFiles].into_iter().collect(),
        );
        apply_intent.grant_ids.insert(grant);
        let apply_preflight = service.preflight(&apply_intent, 1_002).unwrap();
        assert!(!apply_preflight.requires_approval);
        service
            .execute(&apply_intent, &apply_preflight, None, 1_003)
            .unwrap();
        assert_eq!(std::fs::read(root.path().join("a.txt")).unwrap(), b"after");
    }

    #[test]
    fn intent_cannot_understate_or_add_effects_and_traversal_is_rejected() {
        let root = tempdir().unwrap();
        let service = service(root.path());
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Read].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let understated = intent(
            "native.files.read",
            json!({"grantId": grant, "relativePath": "../secret", "projectId": null}),
            BTreeSet::new(),
        );
        assert!(service.preflight(&understated, 1_000).is_err());
        let overstated = intent(
            "native.files.read",
            json!({"grantId": grant, "relativePath": "safe.txt", "projectId": null}),
            [Effect::ReadFiles, Effect::ExternalCommunication]
                .into_iter()
                .collect(),
        );
        assert!(service.preflight(&overstated, 1_000).is_err());
    }

    #[test]
    fn cancellation_prevents_a_prepared_operation_from_starting() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), b"hello").unwrap();
        let service = service(root.path());
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Read].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let intent = intent(
            "native.files.read",
            json!({"grantId": grant, "relativePath": "note.txt", "projectId": null}),
            [Effect::ReadFiles].into_iter().collect(),
        );
        let preflight = service.preflight(&intent, 1_000).unwrap();
        service.cancel(intent.intent_id).unwrap();
        assert!(service.execute(&intent, &preflight, None, 1_001).is_err());
    }

    #[test]
    fn sandbox_python_uses_packaged_worker_private_stage_and_bound_frame() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join("calculation.py"),
            b"print(2 + 4)\nresult = 6\n",
        )
        .unwrap();
        let packaged_runtime = root.path().join("cupcake-runtime.exe");
        std::fs::write(&packaged_runtime, b"test executable fixture").unwrap();
        let mut policy = PolicySet::default();
        policy
            .category
            .insert(Effect::ExecuteSandboxed, CategoryDecision::Allow);
        let sandbox = Arc::new(RecordingSandbox::default());
        let service = NativeToolExecutorService::open(
            root.path(),
            policy,
            None,
            Some(&packaged_runtime),
            Arc::new(NoNetwork),
            sandbox.clone(),
            Arc::new(DisabledLocalModelBackend),
        )
        .unwrap();
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Read].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let intent = intent(
            "native.sandbox.python",
            json!({"grantId": grant, "scriptRelative": "calculation.py", "projectId": null}),
            [Effect::ExecuteSandboxed].into_iter().collect(),
        );
        let preflight = service.preflight(&intent, 1_000).unwrap();
        let result = service.execute(&intent, &preflight, None, 1_001).unwrap();
        assert_eq!(result.status, ToolResultStatus::Completed);
        assert_eq!(result.output["result"]["value"], 6);
        let requests = sandbox.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["payload"]["inputs"], json!([]));
        assert_eq!(
            requests[0]["payload"]["script"]["sha256"],
            hex::encode(Sha256::digest(b"print(2 + 4)\nresult = 6\n"))
        );
        assert!(!root
            .path()
            .join("runtime")
            .join("sandbox-stages")
            .read_dir()
            .unwrap()
            .any(|_| true));
    }

    #[test]
    fn web_fetch_requires_exact_disclosure_and_redacts_response_query() {
        let root = tempdir().unwrap();
        let mut policy = PolicySet::default();
        policy
            .category
            .insert(Effect::NetworkRead, CategoryDecision::Allow);
        let network = Arc::new(StaticNetwork::default());
        let service = NativeToolExecutorService::open(
            root.path(),
            policy,
            None,
            None,
            network.clone(),
            Arc::new(DisabledSandbox),
            Arc::new(DisabledLocalModelBackend),
        )
        .unwrap();
        let mut intent = intent(
            "native.web.fetch",
            json!({"url": "https://example.com/input?user-secret=hidden"}),
            [Effect::NetworkRead].into_iter().collect(),
        );
        intent.data_destinations = [DataDestination::Origin("https://wrong.example".into())]
            .into_iter()
            .collect();
        assert!(service.preflight(&intent, 1_000).is_err());
        intent.data_destinations = [DataDestination::Origin("https://example.com".into())]
            .into_iter()
            .collect();
        let preflight = service.preflight(&intent, 1_000).unwrap();
        assert!(!preflight.disclosure.contains("user-secret"));
        let result = service.execute(&intent, &preflight, None, 1_001).unwrap();
        assert_eq!(result.output["url"], "https://example.com/result");
        assert_eq!(network.fetches.lock().unwrap().len(), 1);
    }

    #[test]
    fn artifact_export_is_bound_to_create_grant_and_refuses_overwrite() {
        let root = tempdir().unwrap();
        let service = service(root.path());
        let grant = service
            .issue_filesystem_grant(
                root.path(),
                [FilesystemPermission::Create].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        let export = intent(
            "native.artifacts.export",
            json!({
                "grantId": grant,
                "relativePath": "report.md",
                "projectId": null,
                "artifactId": "artifact-019d0000",
                "contentBase64": BASE64_STANDARD.encode(b"# Report\n"),
                "expectedSha256": null
            }),
            [Effect::ManageArtifacts, Effect::WriteFiles]
                .into_iter()
                .collect(),
        );
        let preflight = service.preflight(&export, 1_000).unwrap();
        service.execute(&export, &preflight, None, 1_001).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("report.md")).unwrap(),
            b"# Report\n"
        );

        let collision = intent(
            "native.artifacts.export",
            export.arguments.clone(),
            [Effect::ManageArtifacts, Effect::WriteFiles]
                .into_iter()
                .collect(),
        );
        let collision_preflight = service.preflight(&collision, 1_002).unwrap();
        assert!(service
            .execute(&collision, &collision_preflight, None, 1_003)
            .is_err());
    }

    #[test]
    fn local_model_operation_cannot_spoof_execution_lineage_or_hide_download_origin() {
        let root = tempdir().unwrap();
        let service = service(root.path());
        let mut download = intent(
            "native.models.manage",
            json!({
                "operation": "download",
                "execution_id": "different-execution-id",
                "catalog_id": "community/model-q4",
                "source": "https://models.example/model.gguf",
                "expected_sha256": "00".repeat(32)
            }),
            [Effect::ManageModels, Effect::NetworkRead]
                .into_iter()
                .collect(),
        );
        download.data_destinations = [DataDestination::Origin("https://models.example".into())]
            .into_iter()
            .collect();
        assert!(matches!(
            service.preflight(&download, 1_000),
            Err(BrokerError::Integrity(_))
        ));

        download.arguments["execution_id"] = json!(download.intent_id.to_string());
        download.effects = [Effect::ManageModels].into_iter().collect();
        assert!(service.preflight(&download, 1_001).is_err());
    }
}
