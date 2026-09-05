use crate::error::{HostError, HostResult};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MANIFEST_FILE: &str = "sidecars.manifest.json";
const EXPECTED_PROTOCOL_VERSION: u16 = 1;
const EXPECTED_SCHEMA_VERSION: u16 = 1;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_HASHED_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_SUPPORT_FILES: usize = 4096;
const MAX_RUNTIME_SUPPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const RUNTIME_SUPPORT_DIRECTORY: &str = "_internal";

#[derive(Debug, Clone)]
pub struct VerifiedSidecarSet {
    pub broker: PathBuf,
    pub runtime: PathBuf,
    pub local_baseline: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SidecarManifest {
    schema_version: u16,
    protocol_version: u16,
    platform: String,
    architecture: String,
    #[allow(dead_code)]
    generated_at: String,
    binaries: Vec<ManifestBinary>,
    resources: Vec<ManifestResource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestBinary {
    id: String,
    file: String,
    bytes: u64,
    sha256: String,
    transport: String,
    #[serde(default)]
    support_files: Vec<ManifestSupportFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestSupportFile {
    file: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestResource {
    id: String,
    directory: String,
    manifest: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CupcakeLocalManifest {
    archive_bytes: u64,
    archive_sha256: String,
    catalog_key_id: String,
    catalog_sha256: String,
    environment: String,
    model_catalog_sha256: String,
    model_count: u64,
    production_signing: bool,
    model_weights_bundled: bool,
    public_keys_sha256: String,
    reported_version: String,
    runtime_file_count: u64,
    runtime_id: String,
    runtime_version: String,
    schema_version: u16,
    source_revision: String,
}

pub fn verify_sidecar_directory(directory: &Path) -> HostResult<VerifiedSidecarSet> {
    let directory = fs::canonicalize(directory)
        .map_err(|_| HostError::unavailable("Packaged sidecar directory is unavailable"))?;
    let manifest_path = directory.join(MANIFEST_FILE);
    let manifest: SidecarManifest = read_bounded_json(&manifest_path)?;
    if manifest.schema_version != EXPECTED_SCHEMA_VERSION
        || manifest.protocol_version != EXPECTED_PROTOCOL_VERSION
        || manifest.platform != "win32"
        || manifest.architecture != "x64"
    {
        return Err(HostError::new(
            "SIDECAR_MANIFEST_MISMATCH",
            "Packaged sidecar manifest does not match this Windows host",
            false,
        ));
    }
    if manifest.binaries.len() != 2 || manifest.resources.len() != 1 {
        return Err(HostError::new(
            "SIDECAR_MANIFEST_INCOMPLETE",
            "Packaged sidecar manifest is incomplete",
            false,
        ));
    }

    let mut seen = HashSet::new();
    let mut broker = None;
    let mut runtime = None;
    for binary in manifest.binaries {
        if !seen.insert(binary.id.clone()) {
            return Err(HostError::internal(
                "Packaged sidecar manifest contains duplicates",
            ));
        }
        let expected_name = match binary.id.as_str() {
            "tool-broker" => "cupcake-tool-broker.exe",
            "runtime" => "cupcake-runtime.exe",
            _ => return Err(HostError::internal("Packaged sidecar identity is unknown")),
        };
        if binary.file != expected_name
            || binary.transport != "authenticated-length-prefixed-json"
            || !safe_relative_file(&binary.file)
        {
            return Err(HostError::internal("Packaged sidecar record is invalid"));
        }
        let path = directory.join(&binary.file);
        verify_file(&path, binary.bytes, &binary.sha256)?;
        match binary.id.as_str() {
            "runtime" => verify_runtime_support(&directory, &binary.support_files)?,
            "tool-broker" if !binary.support_files.is_empty() => {
                return Err(HostError::internal(
                    "Tool broker must not declare runtime support files",
                ));
            }
            _ => {}
        }
        match binary.id.as_str() {
            "tool-broker" => broker = Some(path),
            "runtime" => runtime = Some(path),
            _ => unreachable!(),
        }
    }

    let resource = &manifest.resources[0];
    if resource.id != "cupcake-local-cpu-baseline"
        || resource.directory != "cupcake-local"
        || resource.manifest != "cupcake-local/cupcake-local.manifest.json"
        || !safe_relative_path(&resource.directory)
        || !safe_relative_path(&resource.manifest)
        || !valid_digest(&resource.sha256)
    {
        return Err(HostError::internal(
            "Cupcake Local resource record is invalid",
        ));
    }
    let local_baseline = fs::canonicalize(directory.join(&resource.directory))
        .map_err(|_| HostError::unavailable("Cupcake Local CPU baseline is unavailable"))?;
    ensure_descendant(&directory, &local_baseline)?;
    let local_manifest_path = directory.join(&resource.manifest);
    if digest_file(&local_manifest_path, MAX_MANIFEST_BYTES)? != resource.sha256 {
        return Err(HostError::new(
            "SIDECAR_DIGEST_MISMATCH",
            "Cupcake Local manifest failed integrity verification",
            false,
        ));
    }
    let local: CupcakeLocalManifest = read_bounded_json(&local_manifest_path)?;
    let expected_runtime_id = format!("llama.cpp:{}:windows-x64-cpu", local.runtime_version);
    if local.schema_version != EXPECTED_SCHEMA_VERSION
        || local.environment != "local-release-candidate"
        || local.production_signing
        || local.model_weights_bundled
        || local.archive_bytes == 0
        || local.model_count == 0
        || local.runtime_file_count == 0
        || local.runtime_version.is_empty()
        || local.runtime_id != expected_runtime_id
        || local.reported_version.is_empty()
        || !safe_identifier(&local.catalog_key_id)
        || !valid_revision(&local.source_revision)
        || !valid_digest(&local.archive_sha256)
        || !valid_digest(&local.catalog_sha256)
        || !valid_digest(&local.model_catalog_sha256)
        || !valid_digest(&local.public_keys_sha256)
    {
        return Err(HostError::new(
            "LOCAL_RUNTIME_PROVENANCE_INVALID",
            "Cupcake Local runtime provenance is invalid",
            false,
        ));
    }
    let archive = local_baseline.join("archive").join(format!(
        "llama-{}-bin-win-cpu-x64.zip",
        local.runtime_version
    ));
    verify_file(&archive, local.archive_bytes, &local.archive_sha256)?;
    verify_declared_resource(
        &local_baseline.join("cupcake-local-runtime-v1.json"),
        &local.catalog_sha256,
    )?;
    verify_declared_resource(
        &local_baseline.join("cupcake-local-models-v1.json"),
        &local.model_catalog_sha256,
    )?;
    verify_declared_resource(
        &local_baseline.join("cupcake-local-public-keys.json"),
        &local.public_keys_sha256,
    )?;
    if contains_model_weights(&local_baseline)? {
        return Err(HostError::new(
            "MODEL_WEIGHTS_BUNDLED",
            "The desktop package must not bundle model weights",
            false,
        ));
    }

    Ok(VerifiedSidecarSet {
        broker: broker.ok_or_else(|| HostError::internal("Broker record is missing"))?,
        runtime: runtime.ok_or_else(|| HostError::internal("Runtime record is missing"))?,
        local_baseline,
    })
}

fn verify_runtime_support(directory: &Path, declared: &[ManifestSupportFile]) -> HostResult<()> {
    if declared.is_empty() || declared.len() > MAX_RUNTIME_SUPPORT_FILES {
        return Err(HostError::internal(
            "Packaged runtime support manifest is incomplete",
        ));
    }
    let support_root = fs::canonicalize(directory.join(RUNTIME_SUPPORT_DIRECTORY))
        .map_err(|_| HostError::unavailable("Packaged runtime support directory is unavailable"))?;
    ensure_descendant(directory, &support_root)?;
    let mut declared_paths = HashSet::with_capacity(declared.len());
    let mut total_bytes = 0_u64;
    for record in declared {
        let relative = Path::new(&record.file);
        if !safe_relative_path(&record.file)
            || !relative.starts_with(Path::new(RUNTIME_SUPPORT_DIRECTORY))
            || relative.components().count() < 2
            || !declared_paths.insert(relative.to_path_buf())
        {
            return Err(HostError::internal(
                "Packaged runtime support record is invalid",
            ));
        }
        total_bytes = total_bytes
            .checked_add(record.bytes)
            .ok_or_else(|| HostError::internal("Packaged runtime support size overflow"))?;
        if total_bytes > MAX_RUNTIME_SUPPORT_BYTES {
            return Err(HostError::internal(
                "Packaged runtime support exceeds its size limit",
            ));
        }
        let path = directory.join(relative);
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            HostError::unavailable("A packaged runtime support file is unavailable")
        })?;
        if metadata.file_type().is_symlink() {
            return Err(HostError::internal(
                "Packaged runtime support must not contain links",
            ));
        }
        let canonical = fs::canonicalize(&path).map_err(|_| {
            HostError::unavailable("A packaged runtime support file is unavailable")
        })?;
        ensure_descendant(directory, &canonical)?;
        verify_support_file(&canonical, record.bytes, &record.sha256)?;
    }

    let mut actual_paths = HashSet::with_capacity(declared.len());
    let mut pending = vec![support_root];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)
            .map_err(|_| HostError::internal("Packaged runtime support cannot be inspected"))?
        {
            let entry = entry
                .map_err(|_| HostError::internal("Packaged runtime support cannot be inspected"))?;
            let file_type = entry
                .file_type()
                .map_err(|_| HostError::internal("Packaged runtime support cannot be inspected"))?;
            if file_type.is_symlink() {
                return Err(HostError::internal(
                    "Packaged runtime support must not contain links",
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(directory)
                    .map_err(|_| HostError::internal("Packaged runtime support escaped its root"))?
                    .to_path_buf();
                actual_paths.insert(relative);
                if actual_paths.len() > MAX_RUNTIME_SUPPORT_FILES {
                    return Err(HostError::internal(
                        "Packaged runtime support contains too many files",
                    ));
                }
            } else {
                return Err(HostError::internal(
                    "Packaged runtime support contains an unsupported entry",
                ));
            }
        }
    }
    if actual_paths != declared_paths {
        return Err(HostError::new(
            "SIDECAR_MANIFEST_MISMATCH",
            "Packaged runtime support does not match its manifest",
            false,
        ));
    }
    Ok(())
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(path: &Path) -> HostResult<T> {
    let metadata = fs::metadata(path)
        .map_err(|_| HostError::unavailable("Packaged manifest is unavailable"))?;
    if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(HostError::internal("Packaged manifest size is invalid"));
    }
    let bytes =
        fs::read(path).map_err(|_| HostError::internal("Packaged manifest cannot be read"))?;
    serde_json::from_slice(&bytes).map_err(|_| HostError::internal("Packaged manifest is invalid"))
}

fn verify_file(path: &Path, expected_bytes: u64, expected_digest: &str) -> HostResult<()> {
    if expected_bytes == 0
        || expected_bytes > MAX_HASHED_FILE_BYTES
        || !valid_digest(expected_digest)
    {
        return Err(HostError::internal("Packaged sidecar metadata is invalid"));
    }
    let metadata = fs::metadata(path)
        .map_err(|_| HostError::unavailable("A packaged sidecar is unavailable"))?;
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return Err(HostError::new(
            "SIDECAR_SIZE_MISMATCH",
            "A packaged sidecar failed size verification",
            false,
        ));
    }
    if digest_file(path, MAX_HASHED_FILE_BYTES)? != expected_digest {
        return Err(HostError::new(
            "SIDECAR_DIGEST_MISMATCH",
            "A packaged sidecar failed integrity verification",
            false,
        ));
    }
    Ok(())
}

fn verify_support_file(path: &Path, expected_bytes: u64, expected_digest: &str) -> HostResult<()> {
    if expected_bytes > MAX_HASHED_FILE_BYTES || !valid_digest(expected_digest) {
        return Err(HostError::internal(
            "Packaged runtime support metadata is invalid",
        ));
    }
    let metadata = fs::metadata(path)
        .map_err(|_| HostError::unavailable("A packaged runtime support file is unavailable"))?;
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return Err(HostError::new(
            "SIDECAR_SIZE_MISMATCH",
            "A packaged runtime support file failed size verification",
            false,
        ));
    }
    if digest_file(path, MAX_HASHED_FILE_BYTES)? != expected_digest {
        return Err(HostError::new(
            "SIDECAR_DIGEST_MISMATCH",
            "A packaged runtime support file failed integrity verification",
            false,
        ));
    }
    Ok(())
}

fn digest_file(path: &Path, maximum: u64) -> HostResult<String> {
    let metadata =
        fs::metadata(path).map_err(|_| HostError::internal("File cannot be inspected"))?;
    if metadata.len() > maximum {
        return Err(HostError::internal(
            "File exceeds the verification size limit",
        ));
    }
    let mut file = File::open(path).map_err(|_| HostError::internal("File cannot be read"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| HostError::internal("File cannot be read"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_declared_resource(path: &Path, expected_digest: &str) -> HostResult<()> {
    if digest_file(path, MAX_MANIFEST_BYTES)? != expected_digest {
        return Err(HostError::new(
            "SIDECAR_DIGEST_MISMATCH",
            "A Cupcake Local resource failed integrity verification",
            false,
        ));
    }
    Ok(())
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn contains_model_weights(directory: &Path) -> HostResult<bool> {
    let mut pending = vec![directory.to_path_buf()];
    let mut entries = 0_usize;
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(current)
            .map_err(|_| HostError::internal("Cupcake Local resource cannot be inspected"))?
        {
            let entry = entry
                .map_err(|_| HostError::internal("Cupcake Local resource cannot be inspected"))?;
            entries += 1;
            if entries > 10_000 {
                return Err(HostError::internal(
                    "Cupcake Local resource contains too many files",
                ));
            }
            let metadata = entry
                .metadata()
                .map_err(|_| HostError::internal("Cupcake Local resource cannot be inspected"))?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("gguf"))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_relative_file(value: &str) -> bool {
    safe_relative_path(value) && Path::new(value).components().count() == 1
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':'])
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn ensure_descendant(root: &Path, target: &Path) -> HostResult<()> {
    if target == root || !target.starts_with(root) {
        return Err(HostError::internal("Packaged resource escaped its root"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_file(path: &Path, bytes: &[u8]) -> (u64, String) {
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
        (bytes.len() as u64, digest_file(path, 1024 * 1024).unwrap())
    }

    #[test]
    fn verifies_exact_sidecar_set_and_rejects_tampering() {
        let directory = tempdir().unwrap();
        let local = directory.path().join("cupcake-local");
        fs::create_dir(&local).unwrap();
        let archive_directory = local.join("archive");
        fs::create_dir(&archive_directory).unwrap();
        let (archive_bytes, archive_digest) = write_file(
            &archive_directory.join("llama-b1-bin-win-cpu-x64.zip"),
            b"archive",
        );
        let (_, catalog_digest) = write_file(&local.join("cupcake-local-runtime-v1.json"), b"{}");
        let (_, model_catalog_digest) =
            write_file(&local.join("cupcake-local-models-v1.json"), b"{}");
        let (_, public_keys_digest) =
            write_file(&local.join("cupcake-local-public-keys.json"), b"{}");
        let local_manifest = local.join("cupcake-local.manifest.json");
        fs::write(
            &local_manifest,
            serde_json::to_vec(&json!({
                "archiveBytes": archive_bytes,
                "archiveSha256": archive_digest,
                "catalogKeyId": "test-key",
                "catalogSha256": catalog_digest,
                "environment": "local-release-candidate",
                "modelCatalogSha256": model_catalog_digest,
                "modelCount": 1,
                "modelWeightsBundled": false,
                "productionSigning": false,
                "publicKeysSha256": public_keys_digest,
                "reportedVersion": "version: test",
                "runtimeFileCount": 1,
                "runtimeId": "llama.cpp:b1:windows-x64-cpu",
                "runtimeVersion": "b1",
                "schemaVersion": 1,
                "sourceRevision": "0000000000000000000000000000000000000000"
            }))
            .unwrap(),
        )
        .unwrap();
        let local_digest = digest_file(&local_manifest, MAX_MANIFEST_BYTES).unwrap();
        let (broker_bytes, broker_digest) =
            write_file(&directory.path().join("cupcake-tool-broker.exe"), b"broker");
        let (runtime_bytes, runtime_digest) =
            write_file(&directory.path().join("cupcake-runtime.exe"), b"runtime");
        let runtime_support = directory.path().join(RUNTIME_SUPPORT_DIRECTORY);
        fs::create_dir(&runtime_support).unwrap();
        let (support_bytes, support_digest) =
            write_file(&runtime_support.join("python3.dll"), b"support");
        let (empty_support_bytes, empty_support_digest) =
            write_file(&runtime_support.join("empty.marker"), b"");
        let manifest = json!({
            "schemaVersion": 1,
            "protocolVersion": 1,
            "platform": "win32",
            "architecture": "x64",
            "generatedAt": "2026-08-29T00:00:00Z",
            "binaries": [
                {"id":"runtime","file":"cupcake-runtime.exe","bytes":runtime_bytes,"sha256":runtime_digest,"transport":"authenticated-length-prefixed-json","supportFiles":[{"file":"_internal/python3.dll","bytes":support_bytes,"sha256":support_digest},{"file":"_internal/empty.marker","bytes":empty_support_bytes,"sha256":empty_support_digest}]},
                {"id":"tool-broker","file":"cupcake-tool-broker.exe","bytes":broker_bytes,"sha256":broker_digest,"transport":"authenticated-length-prefixed-json","supportFiles":[]}
            ],
            "resources": [{"id":"cupcake-local-cpu-baseline","directory":"cupcake-local","manifest":"cupcake-local/cupcake-local.manifest.json","sha256":local_digest}]
        });
        fs::write(
            directory.path().join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(verify_sidecar_directory(directory.path()).is_ok());
        fs::write(directory.path().join("cupcake-runtime.exe"), b"tampered").unwrap();
        assert_eq!(
            verify_sidecar_directory(directory.path()).unwrap_err().code,
            "SIDECAR_SIZE_MISMATCH"
        );
        fs::write(directory.path().join("cupcake-runtime.exe"), b"runtime").unwrap();
        fs::write(runtime_support.join("python3.dll"), b"suppory").unwrap();
        assert_eq!(
            verify_sidecar_directory(directory.path()).unwrap_err().code,
            "SIDECAR_DIGEST_MISMATCH"
        );
        fs::write(runtime_support.join("python3.dll"), b"support").unwrap();
        fs::write(runtime_support.join("undeclared.dll"), b"extra").unwrap();
        assert_eq!(
            verify_sidecar_directory(directory.path()).unwrap_err().code,
            "SIDECAR_MANIFEST_MISMATCH"
        );
    }

    #[test]
    fn relative_path_policy_rejects_traversal_and_windows_separators() {
        assert!(safe_relative_path("cupcake-local/manifest.json"));
        assert!(!safe_relative_path("../outside"));
        assert!(!safe_relative_path("cupcake-local\\manifest.json"));
        assert!(!safe_relative_path("C:/outside"));
    }
}
