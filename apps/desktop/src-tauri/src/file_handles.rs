use crate::error::{HostError, HostResult};
use crate::models::{FileHandleKind, OpaqueFileHandle};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const MAX_ACTIVE_FILE_HANDLES: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InternalFileGrant {
    pub public: OpaqueFileHandle,
    pub absolute_path: PathBuf,
    pub created_at_ms: u128,
}

#[derive(Debug, Default)]
pub struct FileHandleRegistry {
    handles: Mutex<HashMap<Uuid, InternalFileGrant>>,
}

impl FileHandleRegistry {
    pub fn register_existing(&self, path: &Path, writable: bool) -> HostResult<OpaqueFileHandle> {
        if !path.is_absolute() {
            return Err(HostError::invalid("Selected path must be absolute"));
        }
        let canonical = fs::canonicalize(path)
            .map_err(|_| HostError::invalid("Selected file or directory is unavailable"))?;
        let metadata = fs::metadata(&canonical)
            .map_err(|_| HostError::invalid("Selected file or directory is unavailable"))?;
        let kind = if metadata.is_dir() {
            FileHandleKind::Directory
        } else if metadata.is_file() {
            FileHandleKind::File
        } else {
            return Err(HostError::invalid("Selected path type is not supported"));
        };
        let public = OpaqueFileHandle {
            id: Uuid::now_v7().to_string(),
            kind,
            name: safe_file_name(&canonical)?,
            extension: (kind == FileHandleKind::File)
                .then(|| safe_extension(&canonical))
                .flatten(),
            size: (kind == FileHandleKind::File).then_some(metadata.len()),
            writable,
        };
        self.insert(public, canonical)
    }

    pub fn register_save_target(&self, requested: &Path) -> HostResult<OpaqueFileHandle> {
        if !requested.is_absolute() {
            return Err(HostError::invalid("Save target must be absolute"));
        }
        let parent = requested
            .parent()
            .ok_or_else(|| HostError::invalid("Save target has no parent directory"))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|_| HostError::invalid("Save target directory is unavailable"))?;
        let name = requested
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| HostError::invalid("Save target name is invalid"))?;
        if name == OsStr::new(".") || name == OsStr::new("..") {
            return Err(HostError::invalid("Save target name is invalid"));
        }
        let target = canonical_parent.join(name);
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() || metadata.is_dir() || !metadata.is_file() {
                return Err(HostError::invalid("Save target type is not supported"));
            }
        }
        let public = OpaqueFileHandle {
            id: Uuid::now_v7().to_string(),
            kind: FileHandleKind::SaveTarget,
            name: os_string(name)?,
            extension: safe_extension(&target),
            size: None,
            writable: true,
        };
        self.insert(public, target)
    }

    pub fn resolve(&self, id: &str) -> Option<InternalFileGrant> {
        let id = Uuid::parse_str(id).ok()?;
        self.lock().get(&id).cloned()
    }

    pub fn resolve_active_attachments(&self, ids: &[String]) -> HostResult<Vec<InternalFileGrant>> {
        if ids.len() > 32 {
            return Err(HostError::invalid(
                "A request may contain at most 32 attachments",
            ));
        }
        let handles = self.lock();
        let mut seen = std::collections::HashSet::with_capacity(ids.len());
        ids.iter()
            .map(|raw| {
                let id = Uuid::parse_str(raw)
                    .map_err(|_| HostError::invalid("Attachment handle is invalid"))?;
                if !seen.insert(id) {
                    return Err(HostError::invalid("Attachment handles must be unique"));
                }
                let grant = handles
                    .get(&id)
                    .filter(|grant| {
                        grant.public.kind == FileHandleKind::File && !grant.public.writable
                    })
                    .cloned()
                    .ok_or_else(|| HostError::invalid("Attachment handle is unavailable"))?;
                Ok(grant)
            })
            .collect()
    }

    pub fn release(&self, id: &str) -> Option<InternalFileGrant> {
        Uuid::parse_str(id)
            .ok()
            .and_then(|id| self.lock().remove(&id))
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    fn insert(&self, public: OpaqueFileHandle, path: PathBuf) -> HostResult<OpaqueFileHandle> {
        let id =
            Uuid::parse_str(&public.id).map_err(|_| HostError::internal("Invalid host UUID"))?;
        let mut handles = self.lock();
        if handles.len() >= MAX_ACTIVE_FILE_HANDLES {
            return Err(HostError::new(
                "TOO_MANY_FILE_HANDLES",
                "Too many file selections are active; release an earlier selection",
                true,
            ));
        }
        let created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        handles.insert(
            id,
            InternalFileGrant {
                public: public.clone(),
                absolute_path: path,
                created_at_ms,
            },
        );
        Ok(public)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<Uuid, InternalFileGrant>> {
        self.handles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn safe_file_name(path: &Path) -> HostResult<String> {
    path.file_name()
        .ok_or_else(|| HostError::invalid("Selected path has no file name"))
        .and_then(os_string)
}

fn safe_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .filter(|value| !value.is_empty() && value.len() <= 32)
}

fn os_string(value: &OsStr) -> HostResult<String> {
    let value = value
        .to_str()
        .ok_or_else(|| HostError::invalid("Selected path name is not valid Unicode"))?;
    if value.is_empty() || value.len() > 260 || value.chars().any(char::is_control) {
        return Err(HostError::invalid("Selected path name is invalid"));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn renderer_handle_omits_native_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("report.txt");
        File::create(&path).unwrap();
        let registry = FileHandleRegistry::default();
        let public = registry.register_existing(&path, false).unwrap();
        assert_eq!(public.name, "report.txt");
        assert_eq!(public.extension.as_deref(), Some("txt"));
        assert!(!serde_json::to_string(&public)
            .unwrap()
            .contains(directory.path().to_str().unwrap()));
        assert_eq!(
            registry.resolve(&public.id).unwrap().absolute_path,
            fs::canonicalize(path).unwrap()
        );
    }

    #[test]
    fn attachment_resolution_rejects_directories_and_writable_grants() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("draft.txt");
        File::create(&path).unwrap();
        let registry = FileHandleRegistry::default();
        let folder = registry.register_existing(directory.path(), false).unwrap();
        let writable = registry.register_existing(&path, true).unwrap();
        assert!(registry.resolve_active_attachments(&[folder.id]).is_err());
        assert!(registry.resolve_active_attachments(&[writable.id]).is_err());
    }

    #[test]
    fn release_is_explicit_and_idempotent() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("report.txt");
        File::create(&path).unwrap();
        let registry = FileHandleRegistry::default();
        let handle = registry.register_existing(&path, false).unwrap();
        assert!(registry.release(&handle.id).is_some());
        assert!(registry.release(&handle.id).is_none());
    }
}
