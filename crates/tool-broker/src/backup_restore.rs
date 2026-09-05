//! Broker-owned preparation of a backup in a disposable profile.
//!
//! This module never replaces the live profile and never activates a restored
//! key. It resolves the key, authenticates/extracts the outer container, and
//! provides a bounded workspace for the runtime-open and security-DB checks.

use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::backup_container::{
    extract_backup_container_with_key, read_backup_container_manifest, BackupContainerInspection,
    BackupContainerManifest,
};
use crate::backup_envelope::{
    prompt_backup_passphrase, unwrap_profile_key, unwrap_same_user_profile_key, BackupIdentity,
    BackupPassphrasePurpose, BackupProtection,
};
use crate::security_db::SecurityDatabase;
use crate::vault::SecretBytes;
use crate::{BrokerError, Result};

#[derive(Debug)]
pub struct RestoreWorkspace {
    pub id: Uuid,
    pub root: PathBuf,
    pub profile_root: PathBuf,
    pub runtime_archive: PathBuf,
    pub security_snapshot: PathBuf,
    pub inspection: BackupContainerInspection,
}

impl RestoreWorkspace {
    pub fn receipt(&self, runtime_verification: &Value) -> Value {
        json!({
            "backupId": self.inspection.manifest.backup.backup_id,
            "productVersion": self.inspection.manifest.backup.product_version,
            "restoreToken": self.id,
            "verifiedContainerPayloads": self.inspection.verified_payloads,
            "totalPayloadBytes": self.inspection.total_payload_bytes,
            "runtimeVerification": runtime_verification,
            "prepared": true,
            "requiresRestart": true,
            "activeProfileChanged": false,
            "profileKeyActivated": false,
        })
    }

    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub fn read_restore_manifest(source: &Path) -> Result<BackupContainerManifest> {
    read_backup_container_manifest(source)
}

/// Resolve the profile key without exposing either passphrase or key material
/// to the renderer. Portable backups prompt in Windows Credential UI; same-user
/// backups unwrap their self-contained current-user DPAPI recovery blob. The
/// active vault is consulted only for the earlier blob-less legacy format.
pub fn resolve_restore_profile_key(manifest: &BackupContainerManifest) -> Result<SecretBytes> {
    match &manifest.backup.protection {
        BackupProtection::Portable(protection) => {
            let passphrase = prompt_backup_passphrase(BackupPassphrasePurpose::Restore)?;
            let identity = BackupIdentity {
                backup_id: manifest.backup.backup_id,
                product_version: manifest.backup.product_version.clone(),
            };
            unwrap_profile_key(&protection.key_envelope, &passphrase, &identity)
        }
        BackupProtection::SameUserDpapi(protection) => unwrap_same_user_profile_key(protection),
    }
}

pub fn extract_restore_workspace(
    source: &Path,
    staging_root: &Path,
    key: &SecretBytes,
) -> Result<RestoreWorkspace> {
    std::fs::create_dir_all(staging_root)?;
    let id = Uuid::now_v7();
    let root = staging_root.join(id.to_string());
    std::fs::create_dir(&root)?;
    let outer = root.join("outer");
    let result = (|| {
        let extracted = extract_backup_container_with_key(source, &outer, key)?;
        Ok(RestoreWorkspace {
            id,
            profile_root: root.join("profile"),
            runtime_archive: extracted.runtime_archive,
            security_snapshot: extracted.security_snapshot,
            inspection: extracted.inspection,
            root: root.clone(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&root);
    }
    result
}

pub fn restore_security_snapshot(workspace: &RestoreWorkspace) -> Result<()> {
    if !workspace.profile_root.is_dir() {
        return Err(BrokerError::Integrity(
            "disposable runtime profile was not prepared".into(),
        ));
    }
    let security_root = workspace.profile_root.join("security");
    std::fs::create_dir_all(&security_root)?;
    let destination = security_root.join("security.sqlite");
    SecurityDatabase::restore_snapshot(
        &workspace.security_snapshot,
        &destination,
        Utc::now().timestamp_millis(),
    )
    .map_err(|_| BrokerError::Integrity("security snapshot restore failed".into()))?;
    SecurityDatabase::verify_snapshot(&destination)
        .map_err(|_| BrokerError::Integrity("restored security snapshot is invalid".into()))?;
    Ok(())
}
