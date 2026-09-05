//! Portable backup key protection and manifest contracts.
//!
//! Portable backups wrap the 32-byte profile master key with a passphrase that
//! is entered in Windows Credential UI. The passphrase and unwrapped key stay
//! inside the broker process. A same-user DPAPI backup is deliberately modeled
//! as a different, explicitly nonportable mode.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::prelude::*;
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::vault::{
    protect_for_current_windows_user, select_platform_vault, unprotect_for_current_windows_user,
    CredentialVault, SecretBytes,
};
use crate::{BrokerError, Result};

pub const PORTABLE_BACKUP_FORMAT: &str = "cupcake-portable-backup";
pub const PORTABLE_BACKUP_FORMAT_VERSION: u16 = 1;
pub const KEY_ENVELOPE_FORMAT: &str = "cupcake-profile-key-envelope";
pub const KEY_ENVELOPE_VERSION: u16 = 1;
pub const NONPORTABLE_DPAPI_NOTICE: &str =
    "This backup is protected by Windows DPAPI for the current user and cannot be restored by another Windows user or on another computer.";

const PROFILE_KEY_BYTES: usize = 32;
const ARGON2_SALT_BYTES: usize = 16;
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
const MIN_PASSPHRASE_BYTES: usize = 12;
const MAX_PASSPHRASE_BYTES: usize = 4096;
const MIN_MEMORY_KIB: u32 = 32 * 1024;
const MAX_MEMORY_KIB: u32 = 256 * 1024;
const MIN_ITERATIONS: u32 = 2;
const MAX_ITERATIONS: u32 = 8;
const MIN_PARALLELISM: u32 = 1;
const MAX_PARALLELISM: u32 = 4;
const PROFILE_MASTER_KEY_ACCOUNT: &str = "profile.default.master-key";
const STAGED_KEY_LIMIT: usize = 4;
const STAGED_KEY_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackupPassphrasePurpose {
    Create,
    Restore,
}

/// Broker-process-only capability identifying a staged restored profile key.
/// The UUID is not secret, but only the broker retains and redeems it.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct StagedProfileKeyId(Uuid);

impl std::fmt::Display for StagedProfileKeyId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for StagedProfileKeyId {
    type Err = BrokerError;

    fn from_str(value: &str) -> Result<Self> {
        Uuid::parse_str(value)
            .map(Self)
            .map_err(|_| BrokerError::InvalidConfig("invalid staged profile key id".into()))
    }
}

struct StagedProfileKey {
    key: SecretBytes,
    created_at: Instant,
}

#[derive(Default)]
struct ProfileKeyStager {
    entries: Mutex<HashMap<StagedProfileKeyId, StagedProfileKey>>,
}

impl ProfileKeyStager {
    fn stage(&self, key: SecretBytes) -> Result<StagedProfileKeyId> {
        validate_profile_key(&key)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| BrokerError::VaultUnavailable("profile key staging lock failed".into()))?;
        Self::remove_expired(&mut entries);
        if entries.len() >= STAGED_KEY_LIMIT {
            return Err(BrokerError::PermissionDenied(
                "too many profile keys are awaiting restore validation".into(),
            ));
        }
        let id = StagedProfileKeyId(Uuid::now_v7());
        entries.insert(
            id,
            StagedProfileKey {
                key,
                created_at: Instant::now(),
            },
        );
        Ok(id)
    }

    fn activate(&self, id: StagedProfileKeyId, vault: &dyn CredentialVault) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| BrokerError::VaultUnavailable("profile key staging lock failed".into()))?;
        Self::remove_expired(&mut entries);
        let staged = entries.get(&id).ok_or_else(|| {
            BrokerError::NotFound("staged profile key is invalid, expired, or already used".into())
        })?;
        vault.store(PROFILE_MASTER_KEY_ACCOUNT, &staged.key)?;
        let verified = vault
            .load(PROFILE_MASTER_KEY_ACCOUNT)?
            .ok_or_else(|| BrokerError::Integrity("activated profile key is missing".into()))?;
        if staged.key.expose().ct_eq(verified.expose()).unwrap_u8() != 1 {
            return Err(BrokerError::Integrity(
                "activated profile key could not be verified".into(),
            ));
        }
        // Consume only after write+readback verification. Replays and wrong IDs
        // therefore fail without mutating the active DPAPI value.
        entries.remove(&id);
        Ok(())
    }

    fn remove_expired(entries: &mut HashMap<StagedProfileKeyId, StagedProfileKey>) {
        entries.retain(|_, staged| staged.created_at.elapsed() <= STAGED_KEY_LIFETIME);
    }
}

fn profile_key_stager() -> &'static ProfileKeyStager {
    static STAGER: OnceLock<ProfileKeyStager> = OnceLock::new();
    STAGER.get_or_init(ProfileKeyStager::default)
}

/// Load the current 32-byte profile key directly from the Windows DPAPI vault.
/// It is returned only to broker code and never serialized to a protocol frame.
pub fn load_profile_master_key_for_backup() -> Result<SecretBytes> {
    let selected = select_platform_vault();
    require_windows_dpapi(selected.inner())?;
    load_profile_master_key_from(selected.inner())
}

/// Keep an authenticated, unwrapped restore key in broker memory until every
/// archive/database validation step succeeds. Staged entries expire after five
/// minutes and at most four can exist at once.
pub fn stage_restored_profile_master_key(key: SecretBytes) -> Result<StagedProfileKeyId> {
    profile_key_stager().stage(key)
}

/// Atomically consume a staged key capability after persisting and reading it
/// back from the Windows DPAPI vault. A capability can be activated only once.
pub fn activate_staged_profile_key(id: StagedProfileKeyId) -> Result<()> {
    let selected = select_platform_vault();
    require_windows_dpapi(selected.inner())?;
    profile_key_stager().activate(id, selected.inner())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Argon2idWorkFactor {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Argon2idWorkFactor {
    fn default() -> Self {
        Self {
            memory_kib: 64 * 1024,
            iterations: 3,
            parallelism: 1,
        }
    }
}

impl Argon2idWorkFactor {
    pub fn validate(self) -> Result<()> {
        if !(MIN_MEMORY_KIB..=MAX_MEMORY_KIB).contains(&self.memory_kib)
            || !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&self.iterations)
            || !(MIN_PARALLELISM..=MAX_PARALLELISM).contains(&self.parallelism)
        {
            return Err(BrokerError::InvalidConfig(
                "Argon2id work factors are outside the supported safety bounds".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupIdentity {
    pub backup_id: Uuid,
    pub product_version: String,
}

impl BackupIdentity {
    pub fn validate(&self) -> Result<()> {
        if self.product_version.is_empty()
            || self.product_version.len() > 128
            || self.product_version.chars().any(char::is_control)
        {
            return Err(BrokerError::InvalidConfig(
                "invalid backup product version".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Argon2idDescriptor {
    pub algorithm: String,
    pub version: u32,
    #[serde(rename = "memoryKiB")]
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub output_bytes: u32,
    pub salt_base64: String,
}

impl Argon2idDescriptor {
    fn work_factor(&self) -> Result<Argon2idWorkFactor> {
        if self.algorithm != "argon2id" || self.version != 19 || self.output_bytes != 32 {
            return Err(BrokerError::Integrity(
                "unsupported backup key derivation descriptor".into(),
            ));
        }
        let factor = Argon2idWorkFactor {
            memory_kib: self.memory_kib,
            iterations: self.iterations,
            parallelism: self.parallelism,
        };
        factor.validate().map_err(|_| {
            BrokerError::Integrity("backup Argon2id work factors are unsafe".into())
        })?;
        Ok(factor)
    }

    fn salt(&self) -> Result<Vec<u8>> {
        let salt = decode_base64(&self.salt_base64, "Argon2id salt")?;
        if salt.len() != ARGON2_SALT_BYTES {
            return Err(BrokerError::Integrity(
                "backup Argon2id salt has an invalid length".into(),
            ));
        }
        Ok(salt)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileKeyEnvelope {
    pub format: String,
    pub format_version: u16,
    pub cipher: String,
    pub kdf: Argon2idDescriptor,
    pub nonce_base64: String,
    pub wrapped_key_base64: String,
    pub aad_sha256: String,
}

impl ProfileKeyEnvelope {
    pub fn validate(&self, identity: &BackupIdentity) -> Result<()> {
        identity.validate()?;
        if self.format != KEY_ENVELOPE_FORMAT
            || self.format_version != KEY_ENVELOPE_VERSION
            || self.cipher != "aes-256-gcm"
        {
            return Err(BrokerError::Integrity(
                "unsupported backup key envelope".into(),
            ));
        }
        self.kdf.work_factor()?;
        self.kdf.salt()?;
        let nonce = decode_base64(&self.nonce_base64, "AES-GCM nonce")?;
        if nonce.len() != AES_GCM_NONCE_BYTES {
            return Err(BrokerError::Integrity(
                "backup AES-GCM nonce has an invalid length".into(),
            ));
        }
        let wrapped = decode_base64(&self.wrapped_key_base64, "wrapped profile key")?;
        if wrapped.len() != PROFILE_KEY_BYTES + AES_GCM_TAG_BYTES {
            return Err(BrokerError::Integrity(
                "wrapped profile key has an invalid length".into(),
            ));
        }
        let expected_aad_hash = hex::encode(Sha256::digest(authenticated_metadata(identity)));
        if self.aad_sha256.len() != 64
            || expected_aad_hash
                .as_bytes()
                .ct_eq(self.aad_sha256.as_bytes())
                .unwrap_u8()
                != 1
        {
            return Err(BrokerError::Integrity(
                "backup key envelope metadata digest is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePassphraseProtection {
    pub mode: String,
    pub cross_user: bool,
    pub key_envelope: ProfileKeyEnvelope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SameUserDpapiProtection {
    pub mode: String,
    pub cross_user: bool,
    pub notice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_profile_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BackupProtection {
    Portable(PortablePassphraseProtection),
    SameUserDpapi(SameUserDpapiProtection),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupEntryRole {
    ProductDatabase,
    DbosDatabase,
    SecurityDatabase,
    EncryptedObject,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableBackupEntry {
    pub path: String,
    pub role: BackupEntryRole,
    pub sha256: String,
    pub byte_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

impl PortableBackupEntry {
    fn validate(&self) -> Result<()> {
        let path = Path::new(&self.path);
        if self.path.is_empty()
            || self.path.contains('\\')
            || path.is_absolute()
            || path
                .components()
                .next()
                .is_some_and(|part| part.as_os_str().to_string_lossy().contains(':'))
            || path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(BrokerError::Integrity(
                "backup manifest contains an unsafe archive path".into(),
            ));
        }
        if !is_lower_hex(&self.sha256, 64) {
            return Err(BrokerError::Integrity(
                "backup entry has an invalid SHA-256 digest".into(),
            ));
        }
        match self.role {
            BackupEntryRole::EncryptedObject => {
                if !self
                    .object_id
                    .as_deref()
                    .is_some_and(|value| is_lower_hex(value, 64))
                {
                    return Err(BrokerError::Integrity(
                        "encrypted object entry is missing its object id".into(),
                    ));
                }
            }
            _ if self.object_id.is_some() => {
                return Err(BrokerError::Integrity(
                    "database snapshot entry cannot contain an object id".into(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableBackupManifest {
    pub format: String,
    pub format_version: u16,
    pub backup_id: Uuid,
    pub product_version: String,
    pub created_at: DateTime<Utc>,
    pub protection: BackupProtection,
    pub entries: Vec<PortableBackupEntry>,
}

impl PortableBackupManifest {
    pub fn new_portable(
        identity: BackupIdentity,
        created_at: DateTime<Utc>,
        key_envelope: ProfileKeyEnvelope,
        entries: Vec<PortableBackupEntry>,
    ) -> Result<Self> {
        let manifest = Self {
            format: PORTABLE_BACKUP_FORMAT.into(),
            format_version: PORTABLE_BACKUP_FORMAT_VERSION,
            backup_id: identity.backup_id,
            product_version: identity.product_version,
            created_at,
            protection: BackupProtection::Portable(PortablePassphraseProtection {
                mode: "passphrase-portable".into(),
                cross_user: true,
                key_envelope,
            }),
            entries,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn new_same_user_dpapi(
        identity: BackupIdentity,
        created_at: DateTime<Utc>,
        profile_key: &SecretBytes,
        entries: Vec<PortableBackupEntry>,
    ) -> Result<Self> {
        validate_profile_key(profile_key)?;
        let protected_profile_key = protect_for_current_windows_user(profile_key.expose())
            .map(|protected| BASE64_STANDARD.encode(protected))?;
        let manifest = Self {
            format: PORTABLE_BACKUP_FORMAT.into(),
            format_version: PORTABLE_BACKUP_FORMAT_VERSION,
            backup_id: identity.backup_id,
            product_version: identity.product_version,
            created_at,
            protection: BackupProtection::SameUserDpapi(SameUserDpapiProtection {
                mode: "windows-dpapi-current-user".into(),
                cross_user: false,
                notice: NONPORTABLE_DPAPI_NOTICE.into(),
                protected_profile_key: Some(protected_profile_key),
            }),
            entries,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 1024 * 1024 {
            return Err(BrokerError::Integrity(
                "backup manifest exceeds the 1 MiB limit".into(),
            ));
        }
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.format != PORTABLE_BACKUP_FORMAT
            || self.format_version != PORTABLE_BACKUP_FORMAT_VERSION
        {
            return Err(BrokerError::Integrity(
                "unsupported portable backup manifest".into(),
            ));
        }
        let identity = BackupIdentity {
            backup_id: self.backup_id,
            product_version: self.product_version.clone(),
        };
        identity.validate()?;
        match &self.protection {
            BackupProtection::Portable(value) => {
                if value.mode != "passphrase-portable" || !value.cross_user {
                    return Err(BrokerError::Integrity(
                        "portable backup protection flags are invalid".into(),
                    ));
                }
                value.key_envelope.validate(&identity)?;
            }
            BackupProtection::SameUserDpapi(value) => {
                if value.mode != "windows-dpapi-current-user"
                    || value.cross_user
                    || value.notice != NONPORTABLE_DPAPI_NOTICE
                    || value.protected_profile_key.as_ref().is_some_and(|blob| {
                        blob.len() > 32 * 1024 || BASE64_STANDARD.decode(blob).is_err()
                    })
                {
                    return Err(BrokerError::Integrity(
                        "DPAPI backup must be explicitly marked nonportable".into(),
                    ));
                }
            }
        }

        let mut paths = HashSet::new();
        let mut object_ids = HashSet::new();
        let mut product_databases = 0_u8;
        let mut dbos_databases = 0_u8;
        let mut security_databases = 0_u8;
        for entry in &self.entries {
            entry.validate()?;
            if !paths.insert(&entry.path) {
                return Err(BrokerError::Integrity(
                    "backup manifest contains duplicate paths".into(),
                ));
            }
            match entry.role {
                BackupEntryRole::ProductDatabase => product_databases += 1,
                BackupEntryRole::DbosDatabase => dbos_databases += 1,
                BackupEntryRole::SecurityDatabase => security_databases += 1,
                BackupEntryRole::EncryptedObject => {
                    if !object_ids.insert(entry.object_id.as_deref().unwrap_or_default()) {
                        return Err(BrokerError::Integrity(
                            "backup manifest contains duplicate object ids".into(),
                        ));
                    }
                }
            }
        }
        if (product_databases, dbos_databases, security_databases) != (1, 1, 1) {
            return Err(BrokerError::Integrity(
                "backup manifest must contain exactly one product, DBOS, and security database snapshot"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// Recover the self-contained key from a new DPAPI backup. Backups produced by
/// the earlier unshipped format omitted the blob and retain the narrow legacy
/// behavior of using the active vault key.
pub fn unwrap_same_user_profile_key(protection: &SameUserDpapiProtection) -> Result<SecretBytes> {
    let Some(encoded) = protection.protected_profile_key.as_deref() else {
        return load_profile_master_key_for_backup();
    };
    if encoded.len() > 32 * 1024 {
        return Err(BrokerError::Integrity(
            "DPAPI recovery-key envelope is too large".into(),
        ));
    }
    let protected = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| BrokerError::Integrity("DPAPI recovery-key envelope is invalid".into()))?;
    let key = SecretBytes::new(unprotect_for_current_windows_user(&protected)?)?;
    validate_profile_key(&key)?;
    Ok(key)
}

/// Wrap the profile key using fresh OS randomness and bounded Argon2id work
/// factors. The returned JSON-safe structure contains no passphrase material.
pub fn wrap_profile_key(
    profile_key: &SecretBytes,
    passphrase: &SecretBytes,
    identity: &BackupIdentity,
    work_factor: Argon2idWorkFactor,
) -> Result<ProfileKeyEnvelope> {
    let mut salt = [0_u8; ARGON2_SALT_BYTES];
    let mut nonce = [0_u8; AES_GCM_NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    wrap_profile_key_with_material(profile_key, passphrase, identity, work_factor, salt, nonce)
}

/// Authenticate and unwrap a profile key. Wrong passphrases and any envelope
/// or backup-identity tampering return the same fail-closed integrity error.
pub fn unwrap_profile_key(
    envelope: &ProfileKeyEnvelope,
    passphrase: &SecretBytes,
    identity: &BackupIdentity,
) -> Result<SecretBytes> {
    envelope.validate(identity)?;
    validate_passphrase(passphrase)?;
    let salt = Zeroizing::new(envelope.kdf.salt()?);
    let nonce = decode_base64(&envelope.nonce_base64, "AES-GCM nonce")?;
    let wrapped = Zeroizing::new(decode_base64(
        &envelope.wrapped_key_base64,
        "wrapped profile key",
    )?);
    let work_factor = envelope.kdf.work_factor()?;
    let kek = derive_kek(passphrase, &salt, work_factor)?;
    let cipher = Aes256Gcm::new_from_slice(kek.as_ref())
        .map_err(|_| BrokerError::Integrity("portable backup key authentication failed".into()))?;
    let aad = authenticated_metadata(identity);
    let mut plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: wrapped.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|_| BrokerError::Integrity("portable backup key authentication failed".into()))?;
    if plaintext.len() != PROFILE_KEY_BYTES {
        plaintext.zeroize();
        return Err(BrokerError::Integrity(
            "unwrapped profile key has an invalid length".into(),
        ));
    }
    SecretBytes::new(plaintext)
}

fn wrap_profile_key_with_material(
    profile_key: &SecretBytes,
    passphrase: &SecretBytes,
    identity: &BackupIdentity,
    work_factor: Argon2idWorkFactor,
    salt: [u8; ARGON2_SALT_BYTES],
    nonce: [u8; AES_GCM_NONCE_BYTES],
) -> Result<ProfileKeyEnvelope> {
    if profile_key.expose().len() != PROFILE_KEY_BYTES {
        return Err(BrokerError::InvalidConfig(
            "profile master key must contain exactly 32 bytes".into(),
        ));
    }
    identity.validate()?;
    validate_passphrase(passphrase)?;
    work_factor.validate()?;
    let kek = derive_kek(passphrase, &salt, work_factor)?;
    let cipher = Aes256Gcm::new_from_slice(kek.as_ref())
        .map_err(|_| BrokerError::InvalidConfig("could not initialize backup cipher".into()))?;
    let aad = authenticated_metadata(identity);
    let wrapped = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: profile_key.expose(),
                aad: &aad,
            },
        )
        .map_err(|_| BrokerError::Integrity("could not wrap profile key".into()))?;
    let envelope = ProfileKeyEnvelope {
        format: KEY_ENVELOPE_FORMAT.into(),
        format_version: KEY_ENVELOPE_VERSION,
        cipher: "aes-256-gcm".into(),
        kdf: Argon2idDescriptor {
            algorithm: "argon2id".into(),
            version: 19,
            memory_kib: work_factor.memory_kib,
            iterations: work_factor.iterations,
            parallelism: work_factor.parallelism,
            output_bytes: 32,
            salt_base64: BASE64_URL_SAFE_NO_PAD.encode(salt),
        },
        nonce_base64: BASE64_URL_SAFE_NO_PAD.encode(nonce),
        wrapped_key_base64: BASE64_URL_SAFE_NO_PAD.encode(wrapped),
        aad_sha256: hex::encode(Sha256::digest(&aad)),
    };
    envelope.validate(identity)?;
    Ok(envelope)
}

fn derive_kek(
    passphrase: &SecretBytes,
    salt: &[u8],
    work_factor: Argon2idWorkFactor,
) -> Result<Zeroizing<[u8; PROFILE_KEY_BYTES]>> {
    work_factor.validate()?;
    let params = Params::new(
        work_factor.memory_kib,
        work_factor.iterations,
        work_factor.parallelism,
        Some(PROFILE_KEY_BYTES),
    )
    .map_err(|_| BrokerError::InvalidConfig("invalid Argon2id parameters".into()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; PROFILE_KEY_BYTES]);
    argon2
        .hash_password_into(passphrase.expose(), salt, key.as_mut())
        .map_err(|_| BrokerError::Integrity("could not derive portable backup key".into()))?;
    Ok(key)
}

fn validate_passphrase(passphrase: &SecretBytes) -> Result<()> {
    if !(MIN_PASSPHRASE_BYTES..=MAX_PASSPHRASE_BYTES).contains(&passphrase.expose().len()) {
        return Err(BrokerError::InvalidConfig(
            "portable backup passphrase must contain 12..4096 UTF-8 bytes".into(),
        ));
    }
    Ok(())
}

fn validate_profile_key(key: &SecretBytes) -> Result<()> {
    if key.expose().len() != PROFILE_KEY_BYTES {
        return Err(BrokerError::InvalidConfig(
            "profile master key must contain exactly 32 bytes".into(),
        ));
    }
    Ok(())
}

fn require_windows_dpapi(vault: &dyn CredentialVault) -> Result<()> {
    if !vault.is_persistent() || vault.backend_name() != "windows-dpapi" {
        return Err(BrokerError::VaultUnavailable(
            "profile backup/restore requires the Windows DPAPI vault".into(),
        ));
    }
    Ok(())
}

fn load_profile_master_key_from(vault: &dyn CredentialVault) -> Result<SecretBytes> {
    let key = vault
        .load(PROFILE_MASTER_KEY_ACCOUNT)?
        .ok_or_else(|| BrokerError::NotFound("profile master key is not initialized".into()))?;
    validate_profile_key(&key).map_err(|_| {
        BrokerError::Integrity("stored profile master key has an invalid length".into())
    })?;
    Ok(key)
}

/// Stable binary AAD, independent of JSON map ordering. Both backup identity
/// fields are length-delimited and authenticated by AES-GCM.
pub fn authenticated_metadata(identity: &BackupIdentity) -> Vec<u8> {
    let mut aad = b"CUPCAKEAGI\0portable-backup-key-envelope\0v1\0".to_vec();
    aad.extend_from_slice(identity.backup_id.as_bytes());
    aad.extend_from_slice(&(identity.product_version.len() as u32).to_be_bytes());
    aad.extend_from_slice(identity.product_version.as_bytes());
    aad
}

fn decode_base64(value: &str, label: &str) -> Result<Vec<u8>> {
    if value.len() > 8192 || value.contains('=') {
        return Err(BrokerError::Integrity(format!(
            "backup {label} encoding is invalid"
        )));
    }
    BASE64_URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| BrokerError::Integrity(format!("backup {label} encoding is invalid")))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(windows)]
pub fn prompt_backup_passphrase(purpose: BackupPassphrasePurpose) -> Result<SecretBytes> {
    use windows_sys::Win32::Foundation::ERROR_CANCELLED;
    use windows_sys::Win32::Security::Credentials::{
        CredUIPromptForCredentialsW, CREDUI_FLAGS_ALWAYS_SHOW_UI, CREDUI_FLAGS_DO_NOT_PERSIST,
        CREDUI_FLAGS_GENERIC_CREDENTIALS, CREDUI_FLAGS_KEEP_USERNAME,
        CREDUI_FLAGS_PASSWORD_ONLY_OK, CREDUI_INFOW, CREDUI_MAX_USERNAME_LENGTH,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn prompt_once(caption_text: &str, message_text: &str) -> Result<SecretBytes> {
        let caption = wide(caption_text);
        let message = wide(message_text);
        let target = wide("CUPCAKEAGI:portable-backup:passphrase");
        let mut username = wide("CupcakeAI backup");
        username.resize(CREDUI_MAX_USERNAME_LENGTH as usize, 0);
        let mut password = Zeroizing::new(vec![0_u16; 2048]);
        let info = CREDUI_INFOW {
            cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: std::ptr::null_mut(),
            pszMessageText: message.as_ptr(),
            pszCaptionText: caption.as_ptr(),
            hbmBanner: std::ptr::null_mut(),
        };
        let mut save = 0;
        // SAFETY: pointers reference live, NUL-terminated buffers, with
        // capacities passed in UTF-16 code units. Windows owns the UI.
        let status = unsafe {
            CredUIPromptForCredentialsW(
                &info,
                target.as_ptr(),
                std::ptr::null(),
                0,
                username.as_mut_ptr(),
                username.len() as u32,
                password.as_mut_ptr(),
                password.len() as u32,
                &mut save,
                CREDUI_FLAGS_GENERIC_CREDENTIALS
                    | CREDUI_FLAGS_ALWAYS_SHOW_UI
                    | CREDUI_FLAGS_DO_NOT_PERSIST
                    | CREDUI_FLAGS_KEEP_USERNAME
                    | CREDUI_FLAGS_PASSWORD_ONLY_OK,
            )
        };
        username.zeroize();
        if status == ERROR_CANCELLED {
            return Err(BrokerError::PermissionDenied(
                "backup passphrase prompt was cancelled".into(),
            ));
        }
        if status != 0 {
            return Err(BrokerError::VaultUnavailable(format!(
                "Windows backup passphrase prompt failed with status {status}"
            )));
        }
        let length = password
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(password.len());
        let text = Zeroizing::new(String::from_utf16(&password[..length]).map_err(|_| {
            BrokerError::InvalidConfig("backup passphrase is not valid Unicode".into())
        })?);
        if text.chars().count() < 12 {
            return Err(BrokerError::InvalidConfig(
                "portable backup passphrase must contain at least 12 characters".into(),
            ));
        }
        let secret = SecretBytes::new(text.as_bytes().to_vec())?;
        validate_passphrase(&secret)?;
        Ok(secret)
    }

    match purpose {
        BackupPassphrasePurpose::Create => {
            let first = prompt_once(
                "Create portable CupcakeAI backup",
                "Enter a new backup passphrase (12 characters or more). It is never shown to the app and cannot be recovered if lost.",
            )?;
            let confirmation = prompt_once(
                "Confirm portable backup passphrase",
                "Enter the same backup passphrase again to confirm it.",
            )?;
            if first.expose().ct_eq(confirmation.expose()).unwrap_u8() != 1 {
                return Err(BrokerError::InvalidConfig(
                    "backup passphrase confirmation did not match".into(),
                ));
            }
            Ok(first)
        }
        BackupPassphrasePurpose::Restore => prompt_once(
            "Restore portable CupcakeAI backup",
            "Enter the passphrase used when this portable backup was created.",
        ),
    }
}

#[cfg(not(windows))]
pub fn prompt_backup_passphrase(_purpose: BackupPassphrasePurpose) -> Result<SecretBytes> {
    Err(BrokerError::VaultUnavailable(
        "portable backup passphrase entry requires Windows Credential UI".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::SessionCredentialVault;
    use chrono::TimeZone;

    fn identity() -> BackupIdentity {
        BackupIdentity {
            backup_id: Uuid::parse_str("018f47bc-7f0c-7a3d-8b9f-1234567890ab").unwrap(),
            product_version: "2.0.0-rc.1".into(),
        }
    }

    fn secret(value: &[u8]) -> SecretBytes {
        SecretBytes::new(value.to_vec()).unwrap()
    }

    fn entry(role: BackupEntryRole, path: &str) -> PortableBackupEntry {
        PortableBackupEntry {
            path: path.into(),
            role,
            sha256: "a".repeat(64),
            byte_size: 42,
            object_id: None,
        }
    }

    fn entries() -> Vec<PortableBackupEntry> {
        vec![
            entry(BackupEntryRole::ProductDatabase, "database/product.sqlite"),
            entry(BackupEntryRole::DbosDatabase, "database/dbos.sqlite"),
            entry(
                BackupEntryRole::SecurityDatabase,
                "database/security.sqlite",
            ),
            PortableBackupEntry {
                path: format!("objects/{}.cupobj", "b".repeat(64)),
                role: BackupEntryRole::EncryptedObject,
                sha256: "c".repeat(64),
                byte_size: 99,
                object_id: Some("b".repeat(64)),
            },
        ]
    }

    fn deterministic_envelope() -> ProfileKeyEnvelope {
        wrap_profile_key_with_material(
            &secret(&[7_u8; 32]),
            &secret(b"correct horse battery staple"),
            &identity(),
            Argon2idWorkFactor {
                memory_kib: MIN_MEMORY_KIB,
                iterations: MIN_ITERATIONS,
                parallelism: 1,
            },
            [3_u8; ARGON2_SALT_BYTES],
            [5_u8; AES_GCM_NONCE_BYTES],
        )
        .unwrap()
    }

    #[test]
    fn wraps_and_unwraps_profile_key() {
        let envelope = deterministic_envelope();
        let restored = unwrap_profile_key(
            &envelope,
            &secret(b"correct horse battery staple"),
            &identity(),
        )
        .unwrap();
        assert_eq!(restored.expose(), &[7_u8; 32]);
        assert_eq!(envelope.kdf.algorithm, "argon2id");
        assert_eq!(envelope.kdf.version, 19);
        assert_eq!(
            hex::encode(authenticated_metadata(&identity())),
            "43555043414b4541474900706f727461626c652d6261636b75702d6b65792d656e76656c6f706500763100018f47bc7f0c7a3d8b9f1234567890ab0000000a322e302e302d72632e31"
        );
    }

    #[test]
    fn wrong_passphrase_and_tampering_fail_closed() {
        let envelope = deterministic_envelope();
        assert!(unwrap_profile_key(
            &envelope,
            &secret(b"wrong passphrase is long enough"),
            &identity()
        )
        .is_err());

        let mut tampered = envelope.clone();
        tampered.wrapped_key_base64.replace_range(0..1, "A");
        assert!(unwrap_profile_key(
            &tampered,
            &secret(b"correct horse battery staple"),
            &identity()
        )
        .is_err());

        let mut changed_identity = identity();
        changed_identity.product_version = "2.0.0-final".into();
        assert!(unwrap_profile_key(
            &envelope,
            &secret(b"correct horse battery staple"),
            &changed_identity
        )
        .is_err());
    }

    #[test]
    fn rejects_dangerous_argon2_parameters_before_derivation() {
        let mut envelope = deterministic_envelope();
        envelope.kdf.memory_kib = MAX_MEMORY_KIB + 1;
        assert!(unwrap_profile_key(
            &envelope,
            &secret(b"correct horse battery staple"),
            &identity()
        )
        .is_err());
    }

    #[test]
    fn manifest_contract_requires_all_consistent_snapshots() {
        let manifest = PortableBackupManifest::new_portable(
            identity(),
            Utc.with_ymd_and_hms(2026, 8, 28, 12, 0, 0).unwrap(),
            deterministic_envelope(),
            entries(),
        )
        .unwrap();
        let json = serde_json::to_vec_pretty(&manifest).unwrap();
        assert_eq!(PortableBackupManifest::from_json(&json).unwrap(), manifest);
        assert!(String::from_utf8(json)
            .unwrap()
            .contains("passphrase-portable"));
        assert!(serde_json::to_string(&manifest)
            .unwrap()
            .contains("\"memoryKiB\":32768"));

        let mut missing = entries();
        missing.retain(|entry| entry.role != BackupEntryRole::DbosDatabase);
        assert!(PortableBackupManifest::new_portable(
            identity(),
            Utc::now(),
            deterministic_envelope(),
            missing
        )
        .is_err());
    }

    #[test]
    fn dpapi_manifest_is_explicitly_nonportable() {
        let manifest = PortableBackupManifest::new_same_user_dpapi(
            identity(),
            Utc::now(),
            &secret(&[41_u8; 32]),
            entries(),
        )
        .unwrap();
        let BackupProtection::SameUserDpapi(protection) = manifest.protection else {
            panic!("expected DPAPI protection")
        };
        assert!(!protection.cross_user);
        assert_eq!(protection.notice, NONPORTABLE_DPAPI_NOTICE);
        assert!(protection.protected_profile_key.is_some());
        assert_eq!(
            unwrap_same_user_profile_key(&protection).unwrap().expose(),
            &[41_u8; 32]
        );
    }

    #[test]
    fn manifest_rejects_unknown_fields_and_unsafe_paths() {
        let mut manifest = PortableBackupManifest::new_same_user_dpapi(
            identity(),
            Utc::now(),
            &secret(&[42_u8; 32]),
            entries(),
        )
        .unwrap();
        manifest.entries[0].path = "../product.sqlite".into();
        assert!(manifest.validate().is_err());

        let mut value = serde_json::to_value(
            PortableBackupManifest::new_same_user_dpapi(
                identity(),
                Utc::now(),
                &secret(&[43_u8; 32]),
                entries(),
            )
            .unwrap(),
        )
        .unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("futureField".into(), serde_json::Value::Bool(true));
        assert!(PortableBackupManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn staged_profile_key_activation_is_verified_and_one_shot() {
        let stager = ProfileKeyStager::default();
        let vault = SessionCredentialVault::default();
        let id = stager.stage(secret(&[9_u8; 32])).unwrap();
        stager.activate(id, &vault).unwrap();
        assert_eq!(
            load_profile_master_key_from(&vault).unwrap().expose(),
            &[9_u8; 32]
        );

        assert!(stager.activate(id, &vault).is_err());
        let wrong = StagedProfileKeyId(Uuid::now_v7());
        assert!(stager.activate(wrong, &vault).is_err());
        assert_eq!(
            load_profile_master_key_from(&vault).unwrap().expose(),
            &[9_u8; 32]
        );
    }

    #[test]
    fn staging_rejects_wrong_length_profile_keys() {
        let stager = ProfileKeyStager::default();
        assert!(stager.stage(secret(&[1_u8; 31])).is_err());
    }
}
