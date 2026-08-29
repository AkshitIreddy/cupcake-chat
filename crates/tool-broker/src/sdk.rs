use crate::registry::{validate_identifier, ToolDescriptor};
use crate::{BrokerError, Result, PROTOCOL_VERSION};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomToolManifest {
    pub manifest_version: u16,
    pub package_id: String,
    pub package_version: String,
    pub broker_version: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub inherited_environment: BTreeSet<String>,
    pub tools: Vec<ToolDescriptor>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl CustomToolManifest {
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.manifest_version != PROTOCOL_VERSION {
            return Err(BrokerError::UnsupportedProtocol(self.manifest_version));
        }
        validate_identifier(&self.package_id)?;
        Version::parse(&self.package_version).map_err(|error| {
            BrokerError::InvalidConfig(format!("invalid custom tool package version: {error}"))
        })?;
        VersionReq::parse(&self.broker_version).map_err(|error| {
            BrokerError::InvalidConfig(format!("invalid broker version requirement: {error}"))
        })?;
        validate_relative_executable(&self.executable)?;
        if self.executable_sha256.len() != 64
            || !self
                .executable_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(BrokerError::InvalidConfig(
                "executable_sha256 must be a 64-character hex digest".into(),
            ));
        }
        if self.arguments.len() > 128
            || self
                .arguments
                .iter()
                .any(|argument| argument.contains('\0'))
        {
            return Err(BrokerError::InvalidConfig(
                "custom tool arguments are invalid or exceed bounds".into(),
            ));
        }
        if self.inherited_environment.iter().any(|name| {
            name.is_empty()
                || name.contains("KEY")
                || name.contains("TOKEN")
                || name.contains("SECRET")
                || name.contains("PASSWORD")
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        }) {
            return Err(BrokerError::InvalidConfig(
                "custom tool inherited environment contains a credential-like name".into(),
            ));
        }
        if self.tools.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "custom tool package exposes no tools".into(),
            ));
        }
        let mut ids = BTreeSet::new();
        for tool in &self.tools {
            tool.validate()?;
            if !tool.id.starts_with(&format!("{}.", self.package_id)) {
                return Err(BrokerError::InvalidConfig(
                    "custom tool IDs must be namespaced by package ID".into(),
                ));
            }
            if !ids.insert(&tool.id) {
                return Err(BrokerError::Duplicate(tool.id.clone()));
            }
        }
        Ok(())
    }

    pub fn verify_executable(&self, package_root: &Path) -> Result<PathBuf> {
        let canonical_root = package_root.canonicalize()?;
        let candidate = canonical_root.join(&self.executable).canonicalize()?;
        if !candidate.starts_with(&canonical_root) || !candidate.is_file() {
            return Err(BrokerError::PathEscape);
        }
        let bytes = std::fs::read(&candidate)?;
        let actual = hex::encode(Sha256::digest(bytes));
        if !actual.eq_ignore_ascii_case(&self.executable_sha256) {
            return Err(BrokerError::Integrity(
                "custom tool executable digest mismatch".into(),
            ));
        }
        Ok(candidate)
    }
}

fn validate_relative_executable(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(BrokerError::PathEscape);
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::native_descriptor_catalog;
    use tempfile::tempdir;

    fn manifest() -> CustomToolManifest {
        let mut descriptor = native_descriptor_catalog().remove(0);
        descriptor.id = "demo.read".into();
        CustomToolManifest {
            manifest_version: PROTOCOL_VERSION,
            package_id: "demo".into(),
            package_version: "1.0.0".into(),
            broker_version: "^2.0".into(),
            executable: PathBuf::from("bin/tool"),
            executable_sha256: "00".repeat(32),
            arguments: vec![],
            inherited_environment: BTreeSet::new(),
            tools: vec![descriptor],
            metadata: BTreeMap::new(),
        }
    }

    #[test]
    fn traversal_and_unknown_manifest_fields_are_rejected() {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value["executable"] = serde_json::json!("../escape");
        assert!(CustomToolManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = serde_json::to_value(manifest()).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<CustomToolManifest>(value).is_err());
    }

    #[test]
    fn executable_digest_is_verified_inside_package() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("bin")).unwrap();
        std::fs::write(dir.path().join("bin/tool"), b"hello").unwrap();
        let mut manifest = manifest();
        manifest.executable_sha256 = hex::encode(Sha256::digest(b"hello"));
        manifest.verify_executable(dir.path()).unwrap();
        manifest.executable_sha256 = "11".repeat(32);
        assert!(manifest.verify_executable(dir.path()).is_err());
    }
}
