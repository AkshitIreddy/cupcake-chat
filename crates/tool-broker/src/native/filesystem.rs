use crate::grants::ResolvedPath;
use crate::{BrokerError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};
use uuid::Uuid;

const MAX_LIST_ENTRIES: usize = 10_000;
const MAX_COMPONENTS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub name: String,
    pub kind: FileEntryKind,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone)]
pub struct ExactWrite {
    pub resource: ResolvedPath,
    pub bytes: Vec<u8>,
    /// `Some` means replace exactly that revision. `None` means create-only.
    pub expected_sha256: Option<String>,
}

pub fn validate_relative_windows_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(BrokerError::PathEscape);
    }
    let mut count = 0;
    for component in path.components() {
        count += 1;
        let Component::Normal(value) = component else {
            return Err(BrokerError::PathEscape);
        };
        validate_windows_component(value)?;
    }
    if count == 0 || count > MAX_COMPONENTS {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

fn validate_windows_component(value: &OsStr) -> Result<()> {
    let text = value.to_string_lossy();
    if text.contains(':')
        || text.contains('\0')
        || text.ends_with(' ')
        || text.ends_with('.')
        || text
            .chars()
            .any(|character| matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(BrokerError::PathEscape);
    }
    let stem = text
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if reserved {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

pub fn read_bounded(resource: &ResolvedPath, maximum: usize) -> Result<Vec<u8>> {
    if maximum == 0 {
        return Err(BrokerError::InvalidConfig(
            "file read bound must be positive".into(),
        ));
    }
    resource.revalidate()?;
    reject_unc_or_device_path(resource.as_path())?;
    let mut file = File::open(resource.as_path())?;
    verify_opened_file(&file, resource.as_path())?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err(BrokerError::InvalidConfig(
            "file is not regular or exceeds the read bound".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(BrokerError::InvalidConfig(
            "file changed while reading or exceeds the read bound".into(),
        ));
    }
    Ok(bytes)
}

pub fn list_bounded(resource: &ResolvedPath, maximum: usize) -> Result<Vec<FileEntry>> {
    let maximum = maximum.min(MAX_LIST_ENTRIES);
    if maximum == 0 {
        return Err(BrokerError::InvalidConfig(
            "directory list bound must be positive".into(),
        ));
    }
    resource.revalidate()?;
    reject_unc_or_device_path(resource.as_path())?;
    let canonical = resource.as_path().canonicalize()?;
    if !canonical.is_dir() {
        return Err(BrokerError::InvalidConfig(
            "list target is not a directory".into(),
        ));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical)? {
        if entries.len() == maximum {
            return Err(BrokerError::InvalidConfig(
                "directory entry bound exceeded".into(),
            ));
        }
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let kind = if file_type.is_file() {
            FileEntryKind::File
        } else if file_type.is_dir() {
            FileEntryKind::Directory
        } else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        validate_windows_component(OsStr::new(&name))?;
        let entry_path = entry.path().canonicalize()?;
        if !entry_path.starts_with(&canonical) {
            return Err(BrokerError::PathEscape);
        }
        entries.push(FileEntry {
            name,
            kind,
            size: entry.metadata()?.len(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

pub fn apply_exact_write(write: &ExactWrite, maximum: usize) -> Result<String> {
    validate_exact_write(write, maximum)?;
    let target = write.resource.as_path();
    let parent = target
        .parent()
        .ok_or_else(|| BrokerError::InvalidConfig("write target has no parent".into()))?
        .canonicalize()?;

    let target_name = target
        .file_name()
        .ok_or_else(|| BrokerError::InvalidConfig("write target has no file name".into()))?
        .to_string_lossy();
    let temporary = parent.join(format!(".{target_name}.cupcake-{}.tmp", Uuid::now_v7()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&write.bytes)?;
        file.sync_all()?;
        verify_opened_file(&file, &temporary)?;
        drop(file);
        write.resource.revalidate()?;
        // Revalidate the revision immediately before the atomic replacement.
        validate_exact_write(write, maximum)?;
        atomic_replace(&temporary, target, write.expected_sha256.is_some())?;
        sync_directory(&parent)?;
        Ok(hex::encode(Sha256::digest(&write.bytes)))
    })();
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn validate_exact_write(write: &ExactWrite, maximum: usize) -> Result<()> {
    if write.bytes.len() > maximum {
        return Err(BrokerError::InvalidConfig(
            "staged write exceeds output bound".into(),
        ));
    }
    write.resource.revalidate()?;
    reject_unc_or_device_path(write.resource.as_path())?;
    let target = write.resource.as_path();
    let parent = target
        .parent()
        .ok_or_else(|| BrokerError::InvalidConfig("write target has no parent".into()))?
        .canonicalize()?;
    if !parent.is_dir() {
        return Err(BrokerError::InvalidConfig(
            "write parent is not a directory".into(),
        ));
    }

    match (&write.expected_sha256, target.exists()) {
        (None, false) => {}
        (None, true) => {
            return Err(BrokerError::Integrity(
                "create-only target appeared after proposal".into(),
            ))
        }
        (Some(_), false) => {
            return Err(BrokerError::Integrity(
                "replace target disappeared after proposal".into(),
            ))
        }
        (Some(expected), true) => {
            let actual = digest_existing_path(target, maximum)?;
            if !constant_time_hex_eq(expected, &actual) {
                return Err(BrokerError::Integrity(
                    "target revision changed after proposal".into(),
                ));
            }
        }
    }
    Ok(())
}

fn digest_existing_path(path: &Path, maximum: usize) -> Result<String> {
    let mut file = File::open(path)?;
    verify_opened_file(&file, path)?;
    if !file.metadata()?.is_file() {
        return Err(BrokerError::InvalidConfig(
            "replace target is not a regular file".into(),
        ));
    }
    let mut hasher = Sha256::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read);
        if total > maximum {
            return Err(BrokerError::InvalidConfig(
                "replace target exceeds output bound".into(),
            ));
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn constant_time_hex_eq(left: &str, right: &str) -> bool {
    use subtle::ConstantTimeEq;
    left.len() == 64 && right.len() == 64 && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn reject_unc_or_device_path(path: &Path) -> Result<()> {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    let extended_local_drive = lower
        .strip_prefix("\\\\?\\")
        .is_some_and(|tail| tail.as_bytes().get(1) == Some(&b':'));
    if (lower.starts_with("\\\\") && !extended_local_drive)
        || lower.starts_with("//")
        || lower.starts_with("\\\\.\\")
        || lower.starts_with("\\device\\")
    {
        return Err(BrokerError::PermissionDenied(
            "UNC and device paths are outside local filesystem grants".into(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_opened_file(file: &File, requested: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    let opened =
        std::path::PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd())).canonicalize()?;
    let requested = requested.canonicalize()?;
    if opened != requested {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

#[cfg(windows)]
fn verify_opened_file(file: &File, requested: &Path) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let handle = file.as_raw_handle();
    let needed = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
    if needed == 0 || needed > 32_768 {
        return Err(BrokerError::Integrity(
            "cannot resolve opened file handle".into(),
        ));
    }
    let mut buffer = vec![0u16; needed as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize >= buffer.len() {
        return Err(BrokerError::Integrity(
            "cannot resolve opened file handle".into(),
        ));
    }
    let opened = String::from_utf16_lossy(&buffer[..written as usize]);
    let opened = opened.strip_prefix(r"\\?\").unwrap_or(&opened);
    let requested = requested.canonicalize()?.to_string_lossy().into_owned();
    let requested = requested.strip_prefix(r"\\?\").unwrap_or(&requested);
    if !opened.eq_ignore_ascii_case(requested) {
        return Err(BrokerError::PathEscape);
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, target: &Path, _replace: bool) -> Result<()> {
    std::fs::rename(temporary, target)?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, target: &Path, replace: bool) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let temporary_wide = wide(temporary);
    let target_wide = wide(target);
    let succeeded = unsafe {
        if replace {
            ReplaceFileW(
                target_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<()> {
    // ReplaceFileW/MoveFileExW use WRITE_THROUGH above. Opening directories for
    // FlushFileBuffers is not supported consistently on Windows filesystems.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::{FilesystemGrantStore, FilesystemPermission, GrantScope};
    use std::collections::BTreeSet;
    use tempfile::tempdir;

    fn resolved(root: &Path, relative: &str, permission: FilesystemPermission) -> ResolvedPath {
        let mut store = FilesystemGrantStore::default();
        let grant = store
            .issue(
                root,
                [
                    FilesystemPermission::Read,
                    FilesystemPermission::List,
                    FilesystemPermission::Create,
                    FilesystemPermission::Modify,
                ]
                .into_iter()
                .collect::<BTreeSet<_>>(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        store
            .resolve(&grant, Path::new(relative), permission, 1_000, None)
            .unwrap()
    }

    #[test]
    fn rejects_windows_ads_devices_and_ambiguous_names_on_every_platform() {
        for bad in ["note.txt:secret", "CON", "aux.txt", "trail. ", "LPT9.log"] {
            assert!(
                validate_relative_windows_path(Path::new(bad)).is_err(),
                "{bad}"
            );
        }
        assert!(validate_relative_windows_path(Path::new("safe/frosting.md")).is_ok());
    }

    #[test]
    fn exact_write_detects_revision_races_and_create_collisions() {
        let root = tempdir().unwrap();
        let target = root.path().join("decision.txt");
        std::fs::write(&target, b"before").unwrap();
        let resource = resolved(root.path(), "decision.txt", FilesystemPermission::Modify);
        let expected = hex::encode(Sha256::digest(b"before"));
        std::fs::write(&target, b"raced").unwrap();
        let write = ExactWrite {
            resource,
            bytes: b"after".to_vec(),
            expected_sha256: Some(expected),
        };
        assert!(matches!(
            apply_exact_write(&write, 1024),
            Err(BrokerError::Integrity(_))
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"raced");

        let create = ExactWrite {
            resource: resolved(root.path(), "new.txt", FilesystemPermission::Create),
            bytes: b"new".to_vec(),
            expected_sha256: None,
        };
        std::fs::write(root.path().join("new.txt"), b"attacker").unwrap();
        assert!(apply_exact_write(&create, 1024).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn read_follows_no_escape_even_when_symlink_is_swapped() {
        use std::os::unix::fs::symlink;
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"nope").unwrap();
        symlink(outside.path(), root.path().join("junction")).unwrap();
        let mut store = FilesystemGrantStore::default();
        let grant = store
            .issue(
                root.path(),
                [FilesystemPermission::Read].into_iter().collect(),
                GrantScope::Session,
                10_000,
            )
            .unwrap();
        assert!(matches!(
            store.resolve(
                &grant,
                Path::new("junction/secret"),
                FilesystemPermission::Read,
                1_000,
                None
            ),
            Err(BrokerError::PathEscape)
        ));
    }
}
