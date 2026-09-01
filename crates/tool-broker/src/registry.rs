use crate::policy::Effect;
use crate::{BrokerError, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    Filesystem,
    Credential,
    NetworkOrigin,
    McpConnection,
    Sandbox,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum DataDestination {
    LocalOnly,
    Provider(String),
    Origin(String),
    McpServer(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimits {
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_memory_bytes: Option<u64>,
    pub max_cpu_seconds: Option<u64>,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            max_output_bytes: 1024 * 1024,
            max_memory_bytes: Some(512 * 1024 * 1024),
            max_cpu_seconds: Some(30),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolDescriptor {
    pub id: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub effects: BTreeSet<Effect>,
    pub required_grants: BTreeSet<GrantKind>,
    pub data_destinations: BTreeSet<DataDestination>,
    pub input_schema: Value,
    pub output_schema: Value,
}

impl ToolDescriptor {
    pub fn validate(&self) -> Result<()> {
        validate_identifier(&self.id)?;
        Version::parse(&self.version).map_err(|error| {
            BrokerError::InvalidConfig(format!("invalid tool version: {error}"))
        })?;
        validate_schema("input_schema", &self.input_schema)?;
        validate_schema("output_schema", &self.output_schema)?;
        if self.title.trim().is_empty() || self.description.trim().is_empty() {
            return Err(BrokerError::InvalidConfig(
                "tool title and description are required".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIntent {
    pub intent_id: Uuid,
    pub tool_id: String,
    pub tool_version: String,
    pub arguments: Value,
    pub effects: BTreeSet<Effect>,
    pub grant_ids: BTreeSet<String>,
    pub data_destinations: BTreeSet<DataDestination>,
    pub limits: ResourceLimits,
    pub user_visible_summary: String,
}

impl ToolIntent {
    pub fn digest(&self) -> Result<String> {
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(self)?)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolPreflight {
    pub preflight_id: Uuid,
    pub intent_digest: String,
    pub resolved_resource_ids: BTreeSet<String>,
    pub effective_effects: BTreeSet<Effect>,
    pub effective_destinations: BTreeSet<DataDestination>,
    pub limits: ResourceLimits,
    pub requires_approval: bool,
    pub disclosure: String,
}

impl ToolPreflight {
    pub fn digest(&self) -> Result<String> {
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(self)?)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Completed,
    Cancelled,
    Denied,
    Failed,
    TimedOut,
    OutputLimitExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResult {
    pub intent_id: Uuid,
    pub status: ToolResultStatus,
    pub output: Value,
    pub generated_resource_ids: BTreeSet<String>,
    pub duration_ms: u64,
    pub provenance: Vec<String>,
    pub redacted_error: Option<String>,
}

pub trait NativeTool: Send + Sync {
    fn descriptor(&self) -> &ToolDescriptor;
    fn preflight(&self, intent: &ToolIntent) -> Result<ToolPreflight>;
    fn execute(&self, intent: &ToolIntent, preflight: &ToolPreflight) -> Result<ToolResult>;
}

#[derive(Default)]
pub struct NativeToolRegistry {
    tools: BTreeMap<String, Arc<dyn NativeTool>>,
}

impl NativeToolRegistry {
    pub fn register(&mut self, tool: Arc<dyn NativeTool>) -> Result<()> {
        tool.descriptor().validate()?;
        let id = tool.descriptor().id.clone();
        if self.tools.insert(id.clone(), tool).is_some() {
            return Err(BrokerError::Duplicate(id));
        }
        Ok(())
    }

    pub fn descriptor(&self, id: &str) -> Option<&ToolDescriptor> {
        self.tools.get(id).map(|tool| tool.descriptor())
    }

    pub fn descriptors(&self) -> Vec<&ToolDescriptor> {
        self.tools.values().map(|tool| tool.descriptor()).collect()
    }

    pub fn preflight(&self, intent: &ToolIntent) -> Result<ToolPreflight> {
        let tool = self
            .tools
            .get(&intent.tool_id)
            .ok_or_else(|| BrokerError::NotFound(intent.tool_id.clone()))?;
        let descriptor = tool.descriptor();
        if descriptor.version != intent.tool_version {
            return Err(BrokerError::InvalidConfig("tool version mismatch".into()));
        }
        if !intent.effects.is_subset(&descriptor.effects) {
            return Err(BrokerError::PermissionDenied(
                "intent claims effects outside the descriptor".into(),
            ));
        }
        if !intent
            .data_destinations
            .is_subset(&descriptor.data_destinations)
        {
            return Err(BrokerError::PermissionDenied(
                "intent adds an undisclosed data destination".into(),
            ));
        }
        tool.preflight(intent)
    }

    pub fn execute(&self, intent: &ToolIntent, preflight: &ToolPreflight) -> Result<ToolResult> {
        if intent.digest()? != preflight.intent_digest {
            return Err(BrokerError::Integrity(
                "preflight is not bound to this intent".into(),
            ));
        }
        self.tools
            .get(&intent.tool_id)
            .ok_or_else(|| BrokerError::NotFound(intent.tool_id.clone()))?
            .execute(intent, preflight)
    }
}

/// Stable descriptors for native capabilities. Adapters register handlers for
/// these IDs; having one source of truth prevents a handler from understating
/// its effects during approval.
pub fn native_descriptor_catalog() -> Vec<ToolDescriptor> {
    let schema = serde_json::json!({"type": "object", "additionalProperties": true});
    let definitions = [
        (
            "native.files.read",
            "Read scoped files",
            [Effect::ReadFiles].as_slice(),
        ),
        (
            "native.files.patch_proposal",
            "Propose a file patch",
            [Effect::ReadFiles].as_slice(),
        ),
        (
            "native.git.inspect",
            "Inspect a Git repository",
            [Effect::ReadFiles].as_slice(),
        ),
        (
            "native.git.patch_proposal",
            "Propose a Git patch",
            [Effect::ReadFiles].as_slice(),
        ),
        (
            "native.web.fetch",
            "Fetch a web resource",
            [Effect::NetworkRead].as_slice(),
        ),
        (
            "native.web.search",
            "Search the web",
            [Effect::NetworkRead].as_slice(),
        ),
        (
            "native.sandbox.python",
            "Run bounded Python",
            [Effect::ExecuteSandboxed].as_slice(),
        ),
        (
            "native.models.manage",
            "Manage a local model",
            [Effect::ManageModels].as_slice(),
        ),
        (
            "native.artifacts.manage",
            "Manage an artifact",
            [Effect::ManageArtifacts].as_slice(),
        ),
    ];
    definitions
        .into_iter()
        .map(|(id, title, effects)| ToolDescriptor {
            id: id.into(),
            version: "1.0.0".into(),
            title: title.into(),
            description: format!("CupcakeAI native capability: {title}"),
            effects: effects.iter().copied().collect(),
            required_grants: if id.contains("files") || id.contains("git") {
                [GrantKind::Filesystem].into_iter().collect()
            } else if id.contains("sandbox") {
                [GrantKind::Sandbox].into_iter().collect()
            } else {
                BTreeSet::new()
            },
            data_destinations: if id.contains("web") {
                [DataDestination::Origin("https".into())]
                    .into_iter()
                    .collect()
            } else {
                [DataDestination::LocalOnly].into_iter().collect()
            },
            input_schema: schema.clone(),
            output_schema: schema.clone(),
        })
        .collect()
}

pub(crate) fn validate_identifier(identifier: &str) -> Result<()> {
    let valid = !identifier.is_empty()
        && identifier.len() <= 128
        && identifier.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(BrokerError::InvalidConfig(format!(
            "invalid identifier {identifier:?}"
        )))
    }
}

pub(crate) fn validate_schema(name: &str, schema: &Value) -> Result<()> {
    let object = schema
        .as_object()
        .ok_or_else(|| BrokerError::InvalidConfig(format!("{name} must be a JSON object")))?;
    if !matches!(object.get("type"), Some(Value::String(_))) {
        return Err(BrokerError::InvalidConfig(format!(
            "{name} must declare a type"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_valid_and_ids_are_unique() {
        let mut ids = BTreeSet::new();
        for descriptor in native_descriptor_catalog() {
            descriptor.validate().unwrap();
            assert!(ids.insert(descriptor.id));
        }
    }

    #[test]
    fn intent_digest_changes_when_destination_changes() {
        let mut intent = ToolIntent {
            intent_id: Uuid::now_v7(),
            tool_id: "native.web.fetch".into(),
            tool_version: "1.0.0".into(),
            arguments: serde_json::json!({"url": "https://example.test"}),
            effects: [Effect::NetworkRead].into_iter().collect(),
            grant_ids: BTreeSet::new(),
            data_destinations: [DataDestination::Origin("https://example.test".into())]
                .into_iter()
                .collect(),
            limits: ResourceLimits::default(),
            user_visible_summary: "Fetch example".into(),
        };
        let first = intent.digest().unwrap();
        intent.data_destinations = [DataDestination::Origin("https://evil.test".into())]
            .into_iter()
            .collect();
        assert_ne!(first, intent.digest().unwrap());
    }
}
