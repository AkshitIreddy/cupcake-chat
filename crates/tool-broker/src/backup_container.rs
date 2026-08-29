//! Streaming `.cupcakebak` container owned by the broker.
//!
//! The runtime prepares and verifies its product/DBOS/object archive. The
//! broker adds a transactionally consistent security-database snapshot and a
//! profile-key protection descriptor, then writes both payloads into one
//! bounded container. Provider credentials and plaintext profile keys are
//! never container payloads.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::backup_envelope::{
    BackupEntryRole, BackupIdentity, PortableBackupEntry, PortableBackupManifest,
    ProfileKeyEnvelope,
};
use crate::security_db::{SecurityBackupManifest, SecurityDatabase};
use crate::{BrokerError, Result};

pub const BACKUP_CONTAINER_FORMAT: &str = "cupcake-backup-container";
pub const BACKUP_CONTAINER_FORMAT_VERSION: u16 = 1;
pub const RUNTIME_PAYLOAD_PATH: &str = "payload/runtime.cupcake-runtime.zip";
pub const SECURITY_PAYLOAD_PATH: &str = "payload/security.sqlite";

const MAGIC: &[u8; 16] = b"CUPCAKEBAK\0\x01\0\0\0\0";
const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackupProtectionInput {
    Portable,
    SameUserDpapi,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerPayload {
    pub path: String,
    pub media_type: String,
    pub sha256: String,
    pub byte_size: u64,
}

impl ContainerPayload {
    fn from_file(path: &str, media_type: &str, source: &Path) -> Result<Self> {
        let (sha256, byte_size) = digest_file(source)?;
        Ok(Self {
            path: path.into(),
            media_type: media_type.into(),
            sha256,
            byte_size,
        })
    }

    fn validate(&self, expected_path: &str, expected_media_type: &str) -> Result<()> {
        if self.path != expected_path
            || self.media_type != expected_media_type
            || !is_lower_sha256(&self.sha256)
            || self.byte_size > MAX_PAYLOAD_BYTES
        {
            return Err(BrokerError::Integrity(
                "backup container payload descriptor is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupContainerManifest {
    pub format: String,
    pub format_version: u16,
    pub backup: PortableBackupManifest,
    pub runtime_payload: ContainerPayload,
    pub security_payload: ContainerPayload,
    pub security_snapshot: SecurityBackupManifest,
    pub contains_provider_credentials: bool,
    pub contains_plaintext_profile_key: bool,
}

impl BackupContainerManifest {
    pub fn validate(&self) -> Result<()> {
        if self.format != BACKUP_CONTAINER_FORMAT
            || self.format_version != BACKUP_CONTAINER_FORMAT_VERSION
            || self.contains_provider_credentials
            || self.contains_plaintext_profile_key
        {
            return Err(BrokerError::Integrity(
                "unsupported or unsafe backup container manifest".into(),
            ));
        }
        self.backup.validate()?;
        self.runtime_payload.validate(
            RUNTIME_PAYLOAD_PATH,
            "application/vnd.cupcakeagi.runtime-backup+zip",
        )?;
        self.security_payload
            .validate(SECURITY_PAYLOAD_PATH, "application/vnd.sqlite3")?;
        validate_security_metadata(&self.security_snapshot, &self.security_payload)?;

        let security_entries: Vec<_> = self
            .backup
            .entries
            .iter()
            .filter(|entry| entry.role == BackupEntryRole::SecurityDatabase)
            .collect();
        if security_entries.len() != 1
            || security_entries[0].path != SECURITY_PAYLOAD_PATH
            || security_entries[0].byte_size != self.security_payload.byte_size
            || !constant_time_text_equal(&security_entries[0].sha256, &self.security_payload.sha256)
        {
            return Err(BrokerError::Integrity(
                "security snapshot entry differs from its container payload".into(),
            ));
        }
        Ok(())
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES {
            return Err(BrokerError::Integrity(
                "backup container manifest size is invalid".into(),
            ));
        }
        let manifest: Self = serde_json::from_slice(bytes)
            .map_err(|_| BrokerError::Integrity("backup container manifest is invalid".into()))?;
        manifest.validate()?;
        Ok(manifest)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupContainerInspection {
    pub manifest: BackupContainerManifest,
    pub verified_payloads: u8,
    pub total_payload_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtractedBackupContainer {
    pub inspection: BackupContainerInspection,
    pub staging_directory: PathBuf,
    pub runtime_archive: PathBuf,
    pub security_snapshot: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeSnapshotManifest {
    format_version: u16,
    product_version: String,
    #[allow(dead_code)]
    created_at: String,
    #[allow(dead_code)]
    schema_version: u64,
    entries: Vec<RuntimeSnapshotEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeSnapshotEntry {
    path: String,
    sha256: String,
    byte_size: u64,
}

/// Create the complete outer container from a runtime-produced archive and a
/// broker security DB. The security snapshot is temporary, verified, and
/// deleted after the destination has been atomically installed.
#[allow(clippy::too_many_arguments)]
pub fn create_coordinated_backup(
    destination: &Path,
    runtime_archive: &Path,
    runtime_manifest: &Value,
    security_database: &SecurityDatabase,
    staging_root: &Path,
    identity: BackupIdentity,
    created_at: DateTime<Utc>,
    protection: BackupProtectionInput,
    key_envelope: Option<ProfileKeyEnvelope>,
) -> Result<BackupContainerInspection> {
    validate_regular_file(runtime_archive, "runtime backup archive")?;
    std::fs::create_dir_all(staging_root)?;
    let security_path = staging_root.join(format!("security-{}.sqlite", Uuid::now_v7()));
    let security_metadata = security_database
        .backup_to(&security_path, created_at.timestamp_millis())
        .map_err(|_| BrokerError::Integrity("broker security snapshot failed".into()))?;
    let result = (|| {
        let security_payload = ContainerPayload::from_file(
            SECURITY_PAYLOAD_PATH,
            "application/vnd.sqlite3",
            &security_path,
        )?;
        let entries = portable_entries_from_runtime_manifest(
            runtime_manifest,
            &identity.product_version,
            &security_payload,
        )?;
        let portable = match protection {
            BackupProtectionInput::Portable => PortableBackupManifest::new_portable(
                identity,
                created_at,
                key_envelope.ok_or_else(|| {
                    BrokerError::InvalidConfig(
                        "portable backup requires a profile-key envelope".into(),
                    )
                })?,
                entries,
            )?,
            BackupProtectionInput::SameUserDpapi => {
                if key_envelope.is_some() {
                    return Err(BrokerError::InvalidConfig(
                        "same-user DPAPI backup cannot contain a portable key envelope".into(),
                    ));
                }
                PortableBackupManifest::new_same_user_dpapi(identity, created_at, entries)?
            }
        };
        write_backup_container(
            destination,
            runtime_archive,
            &security_path,
            portable,
            security_metadata,
        )
    })();
    let _ = std::fs::remove_file(&security_path);
    result
}

pub fn write_backup_container(
    destination: &Path,
    runtime_archive: &Path,
    security_snapshot: &Path,
    portable_manifest: PortableBackupManifest,
    security_metadata: SecurityBackupManifest,
) -> Result<BackupContainerInspection> {
    if destination.exists() {
        return Err(BrokerError::InvalidConfig(
            "backup destination already exists".into(),
        ));
    }
    let parent = destination.parent().ok_or_else(|| {
        BrokerError::InvalidConfig("backup destination has no parent directory".into())
    })?;
    if !parent.is_dir() {
        return Err(BrokerError::InvalidConfig(
            "backup destination parent is unavailable".into(),
        ));
    }
    validate_regular_file(runtime_archive, "runtime backup archive")?;
    validate_regular_file(security_snapshot, "broker security snapshot")?;
    let runtime_payload = ContainerPayload::from_file(
        RUNTIME_PAYLOAD_PATH,
        "application/vnd.cupcakeagi.runtime-backup+zip",
        runtime_archive,
    )?;
    let security_payload = ContainerPayload::from_file(
        SECURITY_PAYLOAD_PATH,
        "application/vnd.sqlite3",
        security_snapshot,
    )?;
    let manifest = BackupContainerManifest {
        format: BACKUP_CONTAINER_FORMAT.into(),
        format_version: BACKUP_CONTAINER_FORMAT_VERSION,
        backup: portable_manifest,
        runtime_payload,
        security_payload,
        security_snapshot: security_metadata,
        contains_provider_credentials: false,
        contains_plaintext_profile_key: false,
    };
    manifest.validate()?;
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(BrokerError::InvalidConfig(
            "backup container manifest exceeds the 2 MiB limit".into(),
        ));
    }

    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backup.cupcakebak");
    let temporary = parent.join(format!(".{file_name}.{}.partial", Uuid::now_v7()));
    let write_result: Result<()> = (|| {
        let output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let mut output = BufWriter::new(output);
        output.write_all(MAGIC)?;
        output.write_all(&(manifest_bytes.len() as u32).to_be_bytes())?;
        output.write_all(&manifest_bytes)?;
        append_payload(
            &mut output,
            runtime_archive,
            manifest.runtime_payload.byte_size,
        )?;
        append_payload(
            &mut output,
            security_snapshot,
            manifest.security_payload.byte_size,
        )?;
        output.flush()?;
        output.get_ref().sync_all()?;
        drop(output);
        std::fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result?;
    match inspect_backup_container(destination) {
        Ok(inspection) => Ok(inspection),
        Err(error) => {
            let _ = std::fs::remove_file(destination);
            Err(error)
        }
    }
}

pub fn inspect_backup_container(source: &Path) -> Result<BackupContainerInspection> {
    validate_regular_file(source, "backup container")?;
    let file = File::open(source)?;
    let file_size = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let manifest = read_header(&mut reader, file_size)?;
    let runtime_bytes = verify_payload(&mut reader, &manifest.runtime_payload)?;
    let security_bytes = verify_payload(&mut reader, &manifest.security_payload)?;
    let mut trailing = [0_u8; 1];
    if reader.read(&mut trailing)? != 0 {
        return Err(BrokerError::Integrity(
            "backup container has trailing data".into(),
        ));
    }
    Ok(BackupContainerInspection {
        manifest,
        verified_payloads: 2,
        total_payload_bytes: runtime_bytes
            .checked_add(security_bytes)
            .ok_or_else(|| BrokerError::Integrity("backup payload size overflow".into()))?,
    })
}

/// Verify and extract into a new broker-private staging directory. Payloads
/// are copied with fixed names; archive paths never influence host paths.
pub fn extract_backup_container(
    source: &Path,
    staging_directory: &Path,
) -> Result<ExtractedBackupContainer> {
    validate_regular_file(source, "backup container")?;
    if staging_directory.exists() {
        return Err(BrokerError::InvalidConfig(
            "backup restore staging directory already exists".into(),
        ));
    }
    let file = File::open(source)?;
    let file_size = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let manifest = read_header(&mut reader, file_size)?;
    std::fs::create_dir_all(staging_directory)?;
    let runtime_archive = staging_directory.join("runtime.cupcake-runtime.zip");
    let security_snapshot = staging_directory.join("security.sqlite");
    let extract_result = (|| {
        let runtime_bytes =
            extract_payload(&mut reader, &manifest.runtime_payload, &runtime_archive)?;
        let security_bytes =
            extract_payload(&mut reader, &manifest.security_payload, &security_snapshot)?;
        let mut trailing = [0_u8; 1];
        if reader.read(&mut trailing)? != 0 {
            return Err(BrokerError::Integrity(
                "backup container has trailing data".into(),
            ));
        }
        let verified_security = SecurityDatabase::verify_snapshot(&security_snapshot)
            .map_err(|_| BrokerError::Integrity("security snapshot verification failed".into()))?;
        validate_matching_security_metadata(&manifest.security_snapshot, &verified_security)?;
        Ok(BackupContainerInspection {
            manifest: manifest.clone(),
            verified_payloads: 2,
            total_payload_bytes: runtime_bytes
                .checked_add(security_bytes)
                .ok_or_else(|| BrokerError::Integrity("backup payload size overflow".into()))?,
        })
    })();
    match extract_result {
        Ok(inspection) => Ok(ExtractedBackupContainer {
            inspection,
            staging_directory: staging_directory.to_path_buf(),
            runtime_archive,
            security_snapshot,
        }),
        Err(error) => {
            let _ = std::fs::remove_dir_all(staging_directory);
            Err(error)
        }
    }
}

pub fn portable_entries_from_runtime_manifest(
    value: &Value,
    expected_product_version: &str,
    security_payload: &ContainerPayload,
) -> Result<Vec<PortableBackupEntry>> {
    let runtime: RuntimeSnapshotManifest = serde_json::from_value(value.clone()).map_err(|_| {
        BrokerError::Integrity("runtime backup manifest has an invalid shape".into())
    })?;
    if runtime.format_version != 1 || runtime.product_version != expected_product_version {
        return Err(BrokerError::Integrity(
            "runtime backup manifest version does not match the backup".into(),
        ));
    }
    let mut entries = Vec::with_capacity(runtime.entries.len() + 1);
    for entry in runtime.entries {
        if !is_lower_sha256(&entry.sha256) || entry.byte_size > MAX_PAYLOAD_BYTES {
            return Err(BrokerError::Integrity(
                "runtime backup entry digest or size is invalid".into(),
            ));
        }
        let (role, object_id) = match entry.path.as_str() {
            "database/product.sqlite" => (BackupEntryRole::ProductDatabase, None),
            "database/dbos.sqlite" => (BackupEntryRole::DbosDatabase, None),
            path if path.starts_with("objects/") => (
                BackupEntryRole::EncryptedObject,
                Some(object_id_from_runtime_path(path)?),
            ),
            _ => {
                return Err(BrokerError::Integrity(
                    "runtime backup manifest contains an unsupported payload path".into(),
                ))
            }
        };
        entries.push(PortableBackupEntry {
            path: entry.path,
            role,
            sha256: entry.sha256,
            byte_size: entry.byte_size,
            object_id,
        });
    }
    entries.push(PortableBackupEntry {
        path: security_payload.path.clone(),
        role: BackupEntryRole::SecurityDatabase,
        sha256: security_payload.sha256.clone(),
        byte_size: security_payload.byte_size,
        object_id: None,
    });
    Ok(entries)
}

fn read_header(reader: &mut impl Read, file_size: u64) -> Result<BackupContainerManifest> {
    if file_size < (MAGIC.len() + 4 + 8 + 8) as u64 {
        return Err(BrokerError::Integrity(
            "backup container is truncated".into(),
        ));
    }
    let mut magic = [0_u8; MAGIC.len()];
    reader.read_exact(&mut magic)?;
    if magic.ct_eq(MAGIC).unwrap_u8() != 1 {
        return Err(BrokerError::Integrity(
            "backup container signature is invalid".into(),
        ));
    }
    let mut manifest_length = [0_u8; 4];
    reader.read_exact(&mut manifest_length)?;
    let manifest_length = u32::from_be_bytes(manifest_length) as usize;
    if manifest_length == 0 || manifest_length > MAX_MANIFEST_BYTES {
        return Err(BrokerError::Integrity(
            "backup container manifest size is invalid".into(),
        ));
    }
    let mut bytes = vec![0_u8; manifest_length];
    reader.read_exact(&mut bytes)?;
    BackupContainerManifest::from_json(&bytes)
}

fn append_payload(writer: &mut impl Write, source: &Path, expected_size: u64) -> Result<()> {
    writer.write_all(&expected_size.to_be_bytes())?;
    let mut input = File::open(source)?;
    let copied = std::io::copy(&mut input, writer)?;
    if copied != expected_size {
        return Err(BrokerError::Integrity(
            "backup payload changed while the container was written".into(),
        ));
    }
    Ok(())
}

fn verify_payload(reader: &mut impl Read, descriptor: &ContainerPayload) -> Result<u64> {
    let mut length = [0_u8; 8];
    reader.read_exact(&mut length)?;
    let length = u64::from_be_bytes(length);
    if length != descriptor.byte_size || length > MAX_PAYLOAD_BYTES {
        return Err(BrokerError::Integrity(
            "backup payload length differs from its manifest".into(),
        ));
    }
    let mut digest = Sha256::new();
    let copied = hash_exact(reader, length, &mut digest)?;
    if copied != length {
        return Err(BrokerError::Integrity("backup payload is truncated".into()));
    }
    let measured = hex::encode(digest.finalize());
    if !constant_time_text_equal(&measured, &descriptor.sha256) {
        return Err(BrokerError::Integrity(
            "backup payload digest differs from its manifest".into(),
        ));
    }
    Ok(copied)
}

fn extract_payload(
    reader: &mut impl Read,
    descriptor: &ContainerPayload,
    destination: &Path,
) -> Result<u64> {
    let mut length = [0_u8; 8];
    reader.read_exact(&mut length)?;
    let length = u64::from_be_bytes(length);
    if length != descriptor.byte_size || length > MAX_PAYLOAD_BYTES {
        return Err(BrokerError::Integrity(
            "backup payload length differs from its manifest".into(),
        ));
    }
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut output = BufWriter::new(output);
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    while copied < length {
        let remaining = (length - copied).min(buffer.len() as u64) as usize;
        let count = reader.read(&mut buffer[..remaining])?;
        if count == 0 {
            return Err(BrokerError::Integrity("backup payload is truncated".into()));
        }
        output.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
        copied += count as u64;
    }
    buffer.fill(0);
    output.flush()?;
    output.get_ref().sync_all()?;
    let measured = hex::encode(digest.finalize());
    if !constant_time_text_equal(&measured, &descriptor.sha256) {
        return Err(BrokerError::Integrity(
            "backup payload digest differs from its manifest".into(),
        ));
    }
    Ok(copied)
}

fn digest_file(source: &Path) -> Result<(String, u64)> {
    validate_regular_file(source, "backup payload")?;
    let mut input = File::open(source)?;
    let size = input.metadata()?.len();
    if size > MAX_PAYLOAD_BYTES {
        return Err(BrokerError::InvalidConfig(
            "backup payload exceeds the 1 TiB limit".into(),
        ));
    }
    let mut digest = Sha256::new();
    let copied = hash_exact(&mut input, size, &mut digest)?;
    if copied != size {
        return Err(BrokerError::Integrity(
            "backup payload changed while it was hashed".into(),
        ));
    }
    Ok((hex::encode(digest.finalize()), size))
}

fn hash_exact(reader: &mut impl Read, length: u64, digest: &mut Sha256) -> Result<u64> {
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    while copied < length {
        let remaining = (length - copied).min(buffer.len() as u64) as usize;
        let count = reader.read(&mut buffer[..remaining])?;
        if count == 0 {
            buffer.fill(0);
            return Err(BrokerError::Integrity("backup payload is truncated".into()));
        }
        digest.update(&buffer[..count]);
        copied += count as u64;
    }
    buffer.fill(0);
    Ok(copied)
}

fn validate_regular_file(path: &Path, label: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(BrokerError::InvalidConfig(format!(
            "{label} is not a regular file"
        )));
    }
    Ok(())
}

fn validate_security_metadata(
    metadata: &SecurityBackupManifest,
    payload: &ContainerPayload,
) -> Result<()> {
    if metadata.format != "cupcake-broker-security-snapshot-v1"
        || metadata.contains_provider_credentials
        || metadata.contains_profile_master_key
        || !is_lower_sha256(&metadata.snapshot_sha256)
        || !constant_time_text_equal(&metadata.snapshot_sha256, &payload.sha256)
    {
        return Err(BrokerError::Integrity(
            "security snapshot metadata is invalid or includes secret material".into(),
        ));
    }
    Ok(())
}

fn validate_matching_security_metadata(
    declared: &SecurityBackupManifest,
    verified: &SecurityBackupManifest,
) -> Result<()> {
    if declared.format != verified.format
        || declared.schema_version != verified.schema_version
        || declared.application_id != verified.application_id
        || declared.contains_provider_credentials != verified.contains_provider_credentials
        || declared.contains_profile_master_key != verified.contains_profile_master_key
        || declared.audit_anchor_sequence != verified.audit_anchor_sequence
        || declared.audit_head_sequence != verified.audit_head_sequence
        || declared.audit_head_hash != verified.audit_head_hash
        || !constant_time_text_equal(&declared.snapshot_sha256, &verified.snapshot_sha256)
    {
        return Err(BrokerError::Integrity(
            "security snapshot does not match its declared metadata".into(),
        ));
    }
    Ok(())
}

fn object_id_from_runtime_path(path: &str) -> Result<String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 4
        || parts[0] != "objects"
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts[3].ends_with(".cupobj")
    {
        return Err(BrokerError::Integrity(
            "runtime object archive path is invalid".into(),
        ));
    }
    let object_id = parts[3].trim_end_matches(".cupobj");
    if !is_lower_sha256(object_id) || parts[1] != &object_id[..2] || parts[2] != &object_id[2..4] {
        return Err(BrokerError::Integrity(
            "runtime object archive path does not match its object id".into(),
        ));
    }
    Ok(object_id.into())
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn constant_time_text_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.as_bytes().ct_eq(right.as_bytes()).unwrap_u8() == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_envelope::{
        Argon2idDescriptor, BackupProtection, ProfileKeyEnvelope, KEY_ENVELOPE_FORMAT,
        KEY_ENVELOPE_VERSION,
    };
    use chrono::TimeZone;
    use serde_json::json;
    use tempfile::tempdir;

    fn identity() -> BackupIdentity {
        BackupIdentity {
            backup_id: Uuid::parse_str("018f47bc-7f0c-7a3d-8b9f-1234567890ab").unwrap(),
            product_version: "2.0.0-rc.1".into(),
        }
    }

    fn envelope() -> ProfileKeyEnvelope {
        let identity = identity();
        ProfileKeyEnvelope {
            format: KEY_ENVELOPE_FORMAT.into(),
            format_version: KEY_ENVELOPE_VERSION,
            cipher: "aes-256-gcm".into(),
            kdf: Argon2idDescriptor {
                algorithm: "argon2id".into(),
                version: 19,
                memory_kib: 32 * 1024,
                iterations: 2,
                parallelism: 1,
                output_bytes: 32,
                salt_base64: "AwMDAwMDAwMDAwMDAwMDAw".into(),
            },
            nonce_base64: "BQUFBQUFBQUFBQUF".into(),
            wrapped_key_base64: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH"
                .into(),
            aad_sha256: hex::encode(Sha256::digest(
                crate::backup_envelope::authenticated_metadata(&identity),
            )),
        }
    }

    fn runtime_manifest(object_id: &str) -> Value {
        json!({
            "format_version": 1,
            "product_version": "2.0.0-rc.1",
            "created_at": "2026-08-28T12:00:00Z",
            "schema_version": 1,
            "entries": [
                {"path":"database/product.sqlite","sha256":"a".repeat(64),"byte_size":12},
                {"path":"database/dbos.sqlite","sha256":"b".repeat(64),"byte_size":13},
                {"path":format!("objects/{}/{}/{}.cupobj", &object_id[..2], &object_id[2..4], object_id),"sha256":"c".repeat(64),"byte_size":14}
            ]
        })
    }

    fn portable_manifest(security: &ContainerPayload) -> PortableBackupManifest {
        PortableBackupManifest::new_portable(
            identity(),
            Utc.with_ymd_and_hms(2026, 8, 28, 12, 0, 0).unwrap(),
            envelope(),
            portable_entries_from_runtime_manifest(
                &runtime_manifest(&"d".repeat(64)),
                "2.0.0-rc.1",
                security,
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn container_streams_round_trip_and_security_snapshot_verifies() {
        let directory = tempdir().unwrap();
        let runtime = directory.path().join("runtime.zip");
        std::fs::write(&runtime, b"verified runtime archive").unwrap();
        let security_db = SecurityDatabase::open(directory.path().join("security.db")).unwrap();
        let security = directory.path().join("security-snapshot.sqlite");
        let security_metadata = security_db.snapshot_to(&security, 100).unwrap();
        let security_payload = ContainerPayload::from_file(
            SECURITY_PAYLOAD_PATH,
            "application/vnd.sqlite3",
            &security,
        )
        .unwrap();
        let destination = directory.path().join("backup.cupcakebak");
        let created = write_backup_container(
            &destination,
            &runtime,
            &security,
            portable_manifest(&security_payload),
            security_metadata,
        )
        .unwrap();
        assert_eq!(created.verified_payloads, 2);
        assert!(!created.manifest.contains_provider_credentials);
        assert!(!created.manifest.contains_plaintext_profile_key);

        let extracted =
            extract_backup_container(&destination, &directory.path().join("restore")).unwrap();
        assert_eq!(
            std::fs::read(extracted.runtime_archive).unwrap(),
            b"verified runtime archive"
        );
        assert!(SecurityDatabase::verify_snapshot(extracted.security_snapshot).is_ok());
    }

    #[test]
    fn coordinated_backup_builds_security_entry_and_cleans_temporary_snapshot() {
        let directory = tempdir().unwrap();
        let runtime = directory.path().join("runtime.zip");
        std::fs::write(&runtime, b"runtime archive").unwrap();
        let security_db = SecurityDatabase::open(directory.path().join("security.db")).unwrap();
        let staging = directory.path().join("staging");
        let destination = directory.path().join("backup.cupcakebak");
        let inspection = create_coordinated_backup(
            &destination,
            &runtime,
            &runtime_manifest(&"e".repeat(64)),
            &security_db,
            &staging,
            identity(),
            Utc.with_ymd_and_hms(2026, 8, 28, 12, 0, 0).unwrap(),
            BackupProtectionInput::Portable,
            Some(envelope()),
        )
        .unwrap();
        assert!(matches!(
            inspection.manifest.backup.protection,
            BackupProtection::Portable(_)
        ));
        assert_eq!(
            inspection
                .manifest
                .backup
                .entries
                .iter()
                .filter(|entry| entry.role == BackupEntryRole::SecurityDatabase)
                .count(),
            1
        );
        assert_eq!(std::fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    fn tampering_truncation_and_trailing_bytes_fail_closed() {
        let directory = tempdir().unwrap();
        let runtime = directory.path().join("runtime.zip");
        std::fs::write(&runtime, b"runtime archive bytes").unwrap();
        let security_db = SecurityDatabase::open(directory.path().join("security.db")).unwrap();
        let security = directory.path().join("security.sqlite");
        let metadata = security_db.snapshot_to(&security, 100).unwrap();
        let payload = ContainerPayload::from_file(
            SECURITY_PAYLOAD_PATH,
            "application/vnd.sqlite3",
            &security,
        )
        .unwrap();
        let original = directory.path().join("original.cupcakebak");
        write_backup_container(
            &original,
            &runtime,
            &security,
            portable_manifest(&payload),
            metadata,
        )
        .unwrap();
        let bytes = std::fs::read(&original).unwrap();

        let tampered = directory.path().join("tampered.cupcakebak");
        let mut changed = bytes.clone();
        let index = changed.len() - 1;
        changed[index] ^= 0x80;
        std::fs::write(&tampered, changed).unwrap();
        assert!(inspect_backup_container(&tampered).is_err());

        let truncated = directory.path().join("truncated.cupcakebak");
        std::fs::write(&truncated, &bytes[..bytes.len() - 1]).unwrap();
        assert!(inspect_backup_container(&truncated).is_err());

        let trailing = directory.path().join("trailing.cupcakebak");
        let mut extra = bytes;
        extra.push(0);
        std::fs::write(&trailing, extra).unwrap();
        assert!(inspect_backup_container(&trailing).is_err());
    }

    #[test]
    fn runtime_manifest_rejects_missing_dbos_and_malformed_objects() {
        let security = ContainerPayload {
            path: SECURITY_PAYLOAD_PATH.into(),
            media_type: "application/vnd.sqlite3".into(),
            sha256: "f".repeat(64),
            byte_size: 1,
        };
        let mut missing = runtime_manifest(&"a".repeat(64));
        missing["entries"]
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry["path"] != "database/dbos.sqlite");
        let entries =
            portable_entries_from_runtime_manifest(&missing, "2.0.0-rc.1", &security).unwrap();
        assert!(
            PortableBackupManifest::new_portable(identity(), Utc::now(), envelope(), entries)
                .is_err()
        );

        let malformed = runtime_manifest(&"a".repeat(64));
        let mut malformed = malformed;
        malformed["entries"][2]["path"] = Value::String("objects/aa/bb/wrong.cupobj".into());
        assert!(
            portable_entries_from_runtime_manifest(&malformed, "2.0.0-rc.1", &security).is_err()
        );
    }
}
