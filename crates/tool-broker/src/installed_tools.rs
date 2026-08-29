//! Broker-owned installed-package catalog.
//!
//! Runtime requests contain only a package/connection ID and grant ID. Native
//! paths, arguments, environment names, and executable digests are loaded from
//! this private catalog, which is populated only by the explicit installer.

use crate::sdk::CustomToolManifest;
use crate::{BrokerError, Result, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledMcpManifest {
    pub manifest_version: u16,
    pub connection_id: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub inherited_environment: BTreeSet<String>,
}

pub fn mcp_grant_resource(manifest: &InstalledMcpManifest) -> Result<String> {
    let digest = hex::encode(Sha256::digest(serde_json::to_vec(manifest)?));
    Ok(format!("mcp.package.{}.{}", manifest.connection_id, digest))
}

pub fn custom_tool_grant_resource(manifest: &CustomToolManifest) -> Result<String> {
    let digest = hex::encode(Sha256::digest(serde_json::to_vec(manifest)?));
    Ok(format!("custom.package.{}.{}", manifest.package_id, digest))
}

impl InstalledMcpManifest {
    pub fn load(catalog_root: &Path, connection_id: &str) -> Result<(PathBuf, Self)> {
        validate_package_id(connection_id)?;
        let catalog_root = catalog_root.canonicalize()?;
        let package_root = catalog_root.join(connection_id).canonicalize()?;
        if !package_root.starts_with(&catalog_root) || !package_root.is_dir() {
            return Err(BrokerError::PathEscape);
        }
        let manifest_path = package_root.join("mcp.json");
        let bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
        let manifest: Self = serde_json::from_slice(&bytes)?;
        manifest.validate(connection_id)?;
        let executable = manifest.resolve_executable(&package_root)?;
        Ok((executable, manifest))
    }

    fn validate(&self, expected_id: &str) -> Result<()> {
        if self.manifest_version != PROTOCOL_VERSION {
            return Err(BrokerError::UnsupportedProtocol(self.manifest_version));
        }
        validate_package_id(&self.connection_id)?;
        if self.connection_id != expected_id {
            return Err(BrokerError::Integrity(
                "installed MCP manifest identity mismatch".into(),
            ));
        }
        validate_relative_path(&self.executable)?;
        if self.executable_sha256.len() != 64
            || !self
                .executable_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(BrokerError::InvalidConfig(
                "installed MCP executable digest is invalid".into(),
            ));
        }
        if self.arguments.len() > 128
            || self
                .arguments
                .iter()
                .any(|argument| argument.contains('\0') || argument.len() > 64 * 1024)
        {
            return Err(BrokerError::InvalidConfig(
                "installed MCP arguments exceed bounds".into(),
            ));
        }
        if self.inherited_environment.iter().any(|name| {
            name.is_empty()
                || name.len() > 128
                || ["KEY", "TOKEN", "SECRET", "PASSWORD"]
                    .iter()
                    .any(|marker| name.contains(marker))
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        }) {
            return Err(BrokerError::InvalidConfig(
                "installed MCP environment allowlist contains an invalid or credential-like name"
                    .into(),
            ));
        }
        Ok(())
    }

    fn resolve_executable(&self, package_root: &Path) -> Result<PathBuf> {
        let executable = package_root.join(&self.executable).canonicalize()?;
        if !executable.starts_with(package_root) || !executable.is_file() {
            return Err(BrokerError::PathEscape);
        }
        let digest = digest_file(&executable, MAX_EXECUTABLE_BYTES)?;
        if !digest.eq_ignore_ascii_case(&self.executable_sha256) {
            return Err(BrokerError::Integrity(
                "installed MCP executable digest mismatch".into(),
            ));
        }
        Ok(executable)
    }
}

pub fn load_custom_tool_manifest(
    catalog_root: &Path,
    package_id: &str,
) -> Result<(PathBuf, CustomToolManifest)> {
    validate_package_id(package_id)?;
    let catalog_root = catalog_root.canonicalize()?;
    let package_root = catalog_root.join(package_id).canonicalize()?;
    if !package_root.starts_with(&catalog_root) || !package_root.is_dir() {
        return Err(BrokerError::PathEscape);
    }
    let bytes = read_bounded(&package_root.join("tool.json"), MAX_MANIFEST_BYTES)?;
    let manifest = CustomToolManifest::from_json(&bytes)?;
    if manifest.package_id != package_id {
        return Err(BrokerError::Integrity(
            "installed custom-tool manifest identity mismatch".into(),
        ));
    }
    // Resolve and checksum now as well as immediately before supervisor spawn.
    manifest.verify_executable(&package_root)?;
    Ok((package_root, manifest))
}

fn validate_package_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
    {
        return Err(BrokerError::InvalidConfig(
            "invalid installed package identifier".into(),
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(BrokerError::InvalidConfig(
            "installed package file is missing or exceeds its bound".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(BrokerError::FrameTooLarge {
            actual: bytes.len(),
            maximum: maximum as usize,
        });
    }
    Ok(bytes)
}

fn digest_file(path: &Path, maximum: u64) -> Result<String> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(BrokerError::InvalidConfig(
            "installed executable is missing or exceeds its bound".into(),
        ));
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > maximum {
            return Err(BrokerError::FrameTooLarge {
                actual: total as usize,
                maximum: maximum as usize,
            });
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn installed_mcp_uses_catalog_identity_and_digest() {
        let root = tempdir().unwrap();
        let package = root.path().join("demo");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(package.join("server.exe"), b"server").unwrap();
        let digest = hex::encode(Sha256::digest(b"server"));
        std::fs::write(
            package.join("mcp.json"),
            serde_json::to_vec(&serde_json::json!({
                "manifest_version": PROTOCOL_VERSION,
                "connection_id":"demo",
                "executable":"server.exe",
                "executable_sha256":digest,
                "arguments":[],
                "inherited_environment":[]
            }))
            .unwrap(),
        )
        .unwrap();
        let (executable, manifest) = InstalledMcpManifest::load(root.path(), "demo").unwrap();
        assert_eq!(
            executable,
            package.join("server.exe").canonicalize().unwrap()
        );
        assert_eq!(manifest.connection_id, "demo");
        assert!(mcp_grant_resource(&manifest)
            .unwrap()
            .starts_with("mcp.package.demo."));
    }

    #[test]
    fn package_escape_and_credential_environment_are_rejected() {
        assert!(validate_relative_path(Path::new("../evil.exe")).is_err());
        let manifest = InstalledMcpManifest {
            manifest_version: PROTOCOL_VERSION,
            connection_id: "demo".into(),
            executable: "server.exe".into(),
            executable_sha256: "00".repeat(32),
            arguments: vec![],
            inherited_environment: ["API_TOKEN".into()].into_iter().collect(),
        };
        assert!(manifest.validate("demo").is_err());
    }
}
