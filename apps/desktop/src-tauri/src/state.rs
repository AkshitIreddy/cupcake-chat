use crate::file_handles::FileHandleRegistry;
use crate::sidecar::SidecarSupervisor;
use crate::workspace_lock::WorkspaceLock;
use crate::{error::HostError, error::HostResult};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct HostState {
    pub files: Arc<FileHandleRegistry>,
    pub supervisor: Arc<SidecarSupervisor>,
    pub workspace_lock: Arc<WorkspaceLock>,
}

/// Resolve a deliberately named disposable profile for package testing.
/// Ordinary launches never set this variable and continue to use Tauri's
/// per-user application-data directory.
pub fn test_profile_directory(value: Option<&Path>) -> HostResult<Option<PathBuf>> {
    let Some(path) = value else {
        return Ok(None);
    };
    if !path.is_absolute() || path.parent().is_none() {
        return Err(HostError::invalid(
            "The disposable test profile must be an absolute non-root directory",
        ));
    }
    Ok(Some(path.to_path_buf()))
}

impl HostState {
    pub fn new(supervisor: Arc<SidecarSupervisor>, workspace_lock: Arc<WorkspaceLock>) -> Self {
        Self {
            files: Arc::new(FileHandleRegistry::default()),
            supervisor,
            workspace_lock,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_profile_directory;
    use std::path::Path;

    #[test]
    fn disposable_profile_rejects_relative_and_root_paths() {
        assert!(test_profile_directory(Some(Path::new("relative"))).is_err());
        assert!(test_profile_directory(Some(Path::new(r"C:\"))).is_err());
        assert_eq!(
            test_profile_directory(Some(Path::new(r"C:\temp\cupcake-test")))
                .unwrap()
                .unwrap(),
            Path::new(r"C:\temp\cupcake-test")
        );
    }
}
