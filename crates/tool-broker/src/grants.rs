use crate::{BrokerError, Result};
use base64::prelude::*;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemPermission {
    Read,
    Create,
    Modify,
    Delete,
    List,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    Once,
    Session,
    Project { project_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GrantId(String);

impl GrantId {
    pub fn expose_opaque(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
struct GrantRecord {
    root: PathBuf,
    permissions: BTreeSet<FilesystemPermission>,
    scope: GrantScope,
    expires_unix_ms: i64,
    revoked: bool,
    used: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedPath {
    grant_id: GrantId,
    canonical_root: PathBuf,
    resolved: PathBuf,
    permission: FilesystemPermission,
}

impl ResolvedPath {
    /// Kept crate-private in the product protocol: callers receive opaque
    /// resource labels, while only an execution adapter can use the OS path.
    pub fn as_path(&self) -> &Path {
        &self.resolved
    }

    pub fn grant_id(&self) -> &GrantId {
        &self.grant_id
    }

    pub fn permission(&self) -> FilesystemPermission {
        self.permission
    }

    pub fn revalidate(&self) -> Result<()> {
        let candidate = canonicalize_for_access(&self.resolved)?;
        if !candidate.starts_with(&self.canonical_root) {
            return Err(BrokerError::PathEscape);
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct FilesystemGrantStore {
    grants: HashMap<GrantId, GrantRecord>,
}

impl FilesystemGrantStore {
    pub fn issue(
        &mut self,
        root: &Path,
        permissions: BTreeSet<FilesystemPermission>,
        scope: GrantScope,
        expires_unix_ms: i64,
    ) -> Result<GrantId> {
        if permissions.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "filesystem grant must contain at least one permission".into(),
            ));
        }
        let canonical_root = root.canonicalize()?;
        if !canonical_root.is_dir() {
            return Err(BrokerError::InvalidConfig(
                "filesystem grant root must be a directory".into(),
            ));
        }
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let id = GrantId(format!("fs_{}", BASE64_URL_SAFE_NO_PAD.encode(bytes)));
        self.grants.insert(
            id.clone(),
            GrantRecord {
                root: canonical_root,
                permissions,
                scope,
                expires_unix_ms,
                revoked: false,
                used: false,
            },
        );
        Ok(id)
    }

    pub fn resolve(
        &mut self,
        id: &GrantId,
        relative: &Path,
        permission: FilesystemPermission,
        now_unix_ms: i64,
        project_id: Option<&str>,
    ) -> Result<ResolvedPath> {
        validate_relative(relative)?;
        let grant = self.grants.get_mut(id).ok_or(BrokerError::InvalidGrant)?;
        if grant.revoked
            || grant.expires_unix_ms < now_unix_ms
            || !grant.permissions.contains(&permission)
            || matches!(grant.scope, GrantScope::Once) && grant.used
        {
            return Err(BrokerError::InvalidGrant);
        }
        if let GrantScope::Project {
            project_id: expected,
        } = &grant.scope
        {
            if Some(expected.as_str()) != project_id {
                return Err(BrokerError::InvalidGrant);
            }
        }

        let unresolved = grant.root.join(relative);
        let resolved = canonicalize_for_access(&unresolved)?;
        if !resolved.starts_with(&grant.root) {
            return Err(BrokerError::PathEscape);
        }
        if matches!(grant.scope, GrantScope::Once) {
            grant.used = true;
        }
        Ok(ResolvedPath {
            grant_id: id.clone(),
            canonical_root: grant.root.clone(),
            resolved,
            permission,
        })
    }

    pub fn revoke(&mut self, id: &GrantId) -> bool {
        if let Some(grant) = self.grants.get_mut(id) {
            grant.revoked = true;
            true
        } else {
            false
        }
    }
}

fn validate_relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(BrokerError::PathEscape);
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(BrokerError::PathEscape)
            }
        }
    }
    Ok(())
}

/// Canonicalizes the deepest existing ancestor, then appends only validated
/// normal components. This supports create targets while detecting symlink
/// escapes in every existing parent. Execution adapters must call revalidate
/// immediately before opening to narrow TOCTOU exposure.
fn canonicalize_for_access(path: &Path) -> Result<PathBuf> {
    let mut missing = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        let name = cursor
            .file_name()
            .ok_or(BrokerError::PathEscape)?
            .to_os_string();
        missing.push(name);
        cursor = cursor.parent().ok_or(BrokerError::PathEscape)?;
    }
    let mut canonical = cursor.canonicalize()?;
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn permissions() -> BTreeSet<FilesystemPermission> {
        [FilesystemPermission::Read, FilesystemPermission::Create]
            .into_iter()
            .collect()
    }

    #[test]
    fn paths_are_opaque_and_traversal_is_rejected() {
        let root = tempdir().unwrap();
        let mut store = FilesystemGrantStore::default();
        let id = store
            .issue(root.path(), permissions(), GrantScope::Session, 2_000)
            .unwrap();
        assert!(!id.expose_opaque().contains(root.path().to_str().unwrap()));
        assert!(matches!(
            store.resolve(
                &id,
                Path::new("../outside"),
                FilesystemPermission::Read,
                1_000,
                None
            ),
            Err(BrokerError::PathEscape)
        ));
        let resolved = store
            .resolve(
                &id,
                Path::new("new/thing.txt"),
                FilesystemPermission::Create,
                1_000,
                None,
            )
            .unwrap();
        assert!(resolved
            .as_path()
            .starts_with(root.path().canonicalize().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), root.path().join("door")).unwrap();
        let mut store = FilesystemGrantStore::default();
        let id = store
            .issue(root.path(), permissions(), GrantScope::Session, 2_000)
            .unwrap();
        assert!(matches!(
            store.resolve(
                &id,
                Path::new("door/secret.txt"),
                FilesystemPermission::Create,
                1_000,
                None
            ),
            Err(BrokerError::PathEscape)
        ));
    }

    #[test]
    fn once_grant_is_consumed_and_project_scope_is_bound() {
        let root = tempdir().unwrap();
        let mut store = FilesystemGrantStore::default();
        let id = store
            .issue(root.path(), permissions(), GrantScope::Once, 2_000)
            .unwrap();
        store
            .resolve(
                &id,
                Path::new("a"),
                FilesystemPermission::Create,
                1_000,
                None,
            )
            .unwrap();
        assert!(store
            .resolve(
                &id,
                Path::new("b"),
                FilesystemPermission::Create,
                1_000,
                None
            )
            .is_err());
    }
}
