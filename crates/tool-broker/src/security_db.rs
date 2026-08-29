//! Durable, broker-owned security metadata.
//!
//! This database is deliberately separate from product data and DBOS runtime
//! checkpoints. It contains authorization state only. Provider credentials and
//! the profile master key are DPAPI values and must never be inserted here or
//! included in snapshots produced by this module.

use crate::audit::{redact, AuditEvent};
use rusqlite::backup::Backup;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use thiserror::Error;

const APPLICATION_ID: i64 = 0x4355_5043; // "CUPC"
const SCHEMA_VERSION: i64 = 1;
const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

pub type SecurityDbResult<T> = std::result::Result<T, SecurityDbError>;

#[derive(Debug, Error)]
pub enum SecurityDbError {
    #[error("security database I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("security database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("security database JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("security database is corrupt: {0}")]
    Corrupt(String),
    #[error("security database belongs to another application")]
    WrongApplication,
    #[error("security database schema {found} is newer than supported schema {supported}")]
    UnsupportedVersion { found: i64, supported: i64 },
    #[error("invalid security record: {0}")]
    InvalidRecord(String),
    #[error("approval is missing, expired, mismatched, revoked, or already consumed")]
    ApprovalRejected,
    #[error("grant is missing, expired, mismatched, revoked, or already consumed")]
    GrantRejected,
    #[error("security database mutex was poisoned")]
    Poisoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityGrantScope {
    Once,
    Session { session_id: String },
    Project { project_id: String },
    Persistent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityGrant {
    pub id: String,
    /// Opaque resource/grant locator. Callers must not use a raw credential.
    pub resource_id: String,
    pub permissions: Vec<String>,
    pub scope: SecurityGrantScope,
    pub created_unix_ms: i64,
    pub expires_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizedGrant {
    pub id: String,
    pub resource_id: String,
    pub permissions: Vec<String>,
    pub scope: SecurityGrantScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredPolicyDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "scope")]
pub enum StoredPolicyScope {
    Global,
    Session { session_id: String },
    Project { project_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredPolicy {
    pub id: String,
    pub tool_id: String,
    pub effect: String,
    pub resource_id: Option<String>,
    pub decision: StoredPolicyDecision,
    pub scope: StoredPolicyScope,
    pub created_unix_ms: i64,
    pub expires_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredApprovalChallenge {
    pub approval_id: String,
    pub nonce: String,
    pub intent_digest: String,
    pub preflight_digest: String,
    /// An HMAC proof, not a provider credential.
    pub token: String,
    pub created_unix_ms: i64,
    pub expires_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredMcpSchema {
    pub connection_id: String,
    pub approved_schema_hash: Option<String>,
    pub pending_schema_hash: Option<String>,
    pub schema: Value,
    pub allowed_tools: Vec<String>,
    pub updated_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredMcpSession {
    pub session_id: String,
    pub connection_id: String,
    pub project_id: Option<String>,
    pub state: String,
    /// Diagnostic metadata is recursively redacted before persistence.
    pub metadata: Value,
    pub created_unix_ms: i64,
    pub last_seen_unix_ms: i64,
    pub expires_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAuditEvent {
    pub sequence: i64,
    pub timestamp_unix_ms: i64,
    pub category: String,
    pub action: String,
    pub outcome: String,
    pub fields: Value,
    pub previous_hash: String,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetentionPolicy {
    pub inactive_records_ms: i64,
    pub approval_tombstones_ms: i64,
    pub audit_events_ms: i64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            inactive_records_ms: 30 * 24 * 60 * 60 * 1_000,
            approval_tombstones_ms: 30 * 24 * 60 * 60 * 1_000,
            audit_events_ms: 30 * 24 * 60 * 60 * 1_000,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetentionReport {
    pub grants_removed: u64,
    pub policies_removed: u64,
    pub approvals_removed: u64,
    pub mcp_sessions_removed: u64,
    pub audit_events_removed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityBackupManifest {
    pub format: String,
    pub schema_version: i64,
    pub created_unix_ms: i64,
    pub application_id: i64,
    pub contains_provider_credentials: bool,
    pub contains_profile_master_key: bool,
    pub audit_anchor_sequence: i64,
    pub audit_head_sequence: i64,
    pub audit_head_hash: String,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedactedSecurityExport {
    pub format: String,
    pub schema_version: i64,
    pub application_id: i64,
    pub contains_provider_credentials: bool,
    pub contains_profile_master_key: bool,
    pub record_counts: BTreeMap<String, i64>,
    pub audit_anchor_sequence: i64,
    pub audit_head_sequence: i64,
    pub audit_head_hash: String,
    pub mcp_connections: Vec<String>,
}

/// Thread-safe owner of the broker security store.
pub struct SecurityDatabase {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SecurityDatabase {
    pub fn open(path: impl AsRef<Path>) -> SecurityDbResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let existed_with_data = path.metadata().map(|m| m.len() > 0).unwrap_or(false);
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )?;
        configure_connection(&connection)?;
        reject_corruption(&connection)?;
        migrate(&mut connection, existed_with_data)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> SecurityDbResult<i64> {
        self.connection()?
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(Into::into)
    }

    pub fn issue_grant(&self, grant: &SecurityGrant) -> SecurityDbResult<()> {
        validate_grant(grant)?;
        let (scope_kind, session_id, project_id) = grant_scope_columns(&grant.scope);
        let permissions = serde_json::to_string(&grant.permissions)?;
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO grants
             (id, resource_id, permissions_json, scope_kind, session_id, project_id,
              created_unix_ms, expires_unix_ms, used_unix_ms, revoked_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL)",
            params![
                grant.id,
                grant.resource_id,
                permissions,
                scope_kind,
                session_id,
                project_id,
                grant.created_unix_ms,
                grant.expires_unix_ms,
            ],
        )?;
        Ok(())
    }

    /// Checks and consumes a one-use grant in the same IMMEDIATE transaction.
    pub fn authorize_grant(
        &self,
        id: &str,
        required_permission: &str,
        now_unix_ms: i64,
        session_id: Option<&str>,
        project_id: Option<&str>,
    ) -> SecurityDbResult<AuthorizedGrant> {
        validate_text("grant id", id)?;
        validate_text("permission", required_permission)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT resource_id, permissions_json, scope_kind, session_id, project_id,
                        expires_unix_ms, used_unix_ms, revoked_unix_ms
                 FROM grants WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            resource_id,
            permissions_json,
            scope_kind,
            stored_session,
            stored_project,
            expires,
            used,
            revoked,
        )) = row
        else {
            return Err(SecurityDbError::GrantRejected);
        };
        let permissions: Vec<String> = serde_json::from_str(&permissions_json)?;
        let active = revoked.is_none()
            && expires.is_none_or(|value| value >= now_unix_ms)
            && permissions.iter().any(|value| value == required_permission)
            && match scope_kind.as_str() {
                "once" => used.is_none(),
                "session" => stored_session.as_deref() == session_id,
                "project" => stored_project.as_deref() == project_id,
                "persistent" => true,
                _ => false,
            };
        if !active {
            return Err(SecurityDbError::GrantRejected);
        }
        if scope_kind == "once" {
            let changed = tx.execute(
                "UPDATE grants SET used_unix_ms = ?2
                 WHERE id = ?1 AND used_unix_ms IS NULL AND revoked_unix_ms IS NULL",
                params![id, now_unix_ms],
            )?;
            if changed != 1 {
                return Err(SecurityDbError::GrantRejected);
            }
        }
        let scope = columns_to_grant_scope(&scope_kind, stored_session, stored_project)?;
        tx.commit()?;
        Ok(AuthorizedGrant {
            id: id.to_owned(),
            resource_id,
            permissions,
            scope,
        })
    }

    pub fn revoke_grant(&self, id: &str, now_unix_ms: i64) -> SecurityDbResult<bool> {
        validate_text("grant id", id)?;
        Ok(self.connection()?.execute(
            "UPDATE grants SET revoked_unix_ms = COALESCE(revoked_unix_ms, ?2) WHERE id = ?1",
            params![id, now_unix_ms],
        )? == 1)
    }

    pub fn put_policy(&self, policy: &StoredPolicy) -> SecurityDbResult<()> {
        validate_policy(policy)?;
        let (scope_kind, session_id, project_id) = policy_scope_columns(&policy.scope);
        self.connection()?.execute(
            "INSERT INTO policies
             (id, tool_id, effect, resource_id, decision, scope_kind, session_id, project_id,
              created_unix_ms, expires_unix_ms, revoked_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
             ON CONFLICT(id) DO UPDATE SET
               tool_id=excluded.tool_id, effect=excluded.effect, resource_id=excluded.resource_id,
               decision=excluded.decision, scope_kind=excluded.scope_kind,
               session_id=excluded.session_id, project_id=excluded.project_id,
               created_unix_ms=excluded.created_unix_ms, expires_unix_ms=excluded.expires_unix_ms,
               revoked_unix_ms=NULL",
            params![
                policy.id,
                policy.tool_id,
                policy.effect,
                policy.resource_id,
                policy_decision_text(policy.decision),
                scope_kind,
                session_id,
                project_id,
                policy.created_unix_ms,
                policy.expires_unix_ms,
            ],
        )?;
        Ok(())
    }

    pub fn active_policies(
        &self,
        now_unix_ms: i64,
        session_id: Option<&str>,
        project_id: Option<&str>,
    ) -> SecurityDbResult<Vec<StoredPolicy>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, tool_id, effect, resource_id, decision, scope_kind, session_id,
                    project_id, created_unix_ms, expires_unix_ms
             FROM policies
             WHERE revoked_unix_ms IS NULL
               AND (expires_unix_ms IS NULL OR expires_unix_ms >= ?1)
               AND (scope_kind = 'global'
                    OR (scope_kind = 'session' AND session_id = ?2)
                    OR (scope_kind = 'project' AND project_id = ?3))
             ORDER BY id",
        )?;
        let rows = statement.query_map(params![now_unix_ms, session_id, project_id], |row| {
            let decision: String = row.get(4)?;
            let scope_kind: String = row.get(5)?;
            let stored_session: Option<String> = row.get(6)?;
            let stored_project: Option<String> = row.get(7)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                decision,
                scope_kind,
                stored_session,
                stored_project,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                tool_id,
                effect,
                resource_id,
                decision,
                scope_kind,
                session,
                project,
                created,
                expires,
            ) = row?;
            Ok(StoredPolicy {
                id,
                tool_id,
                effect,
                resource_id,
                decision: parse_policy_decision(&decision)?,
                scope: columns_to_policy_scope(&scope_kind, session, project)?,
                created_unix_ms: created,
                expires_unix_ms: expires,
            })
        })
        .collect()
    }

    pub fn revoke_policy(&self, id: &str, now_unix_ms: i64) -> SecurityDbResult<bool> {
        validate_text("policy id", id)?;
        Ok(self.connection()?.execute(
            "UPDATE policies SET revoked_unix_ms = COALESCE(revoked_unix_ms, ?2) WHERE id = ?1",
            params![id, now_unix_ms],
        )? == 1)
    }

    pub fn store_pending_approval(
        &self,
        approval: &StoredApprovalChallenge,
    ) -> SecurityDbResult<()> {
        validate_approval(approval)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM approval_tombstones WHERE approval_id = ?1)",
            [&approval.approval_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(SecurityDbError::ApprovalRejected);
        }
        tx.execute(
            "INSERT INTO pending_approvals
             (approval_id, nonce, intent_digest, preflight_digest, token, created_unix_ms,
              expires_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                approval.approval_id,
                approval.nonce,
                approval.intent_digest,
                approval.preflight_digest,
                approval.token,
                approval.created_unix_ms,
                approval.expires_unix_ms,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Atomically removes a matching pending challenge and persists a replay
    /// tombstone. Cryptographic proof validation remains the ApprovalManager's
    /// responsibility; this function binds durable state to the same values.
    pub fn consume_approval(
        &self,
        approval_id: &str,
        nonce: &str,
        intent_digest: &str,
        preflight_digest: &str,
        token: &str,
        now_unix_ms: i64,
    ) -> SecurityDbResult<StoredApprovalChallenge> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_tombstone: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM approval_tombstones WHERE approval_id = ?1)",
            [approval_id],
            |row| row.get(0),
        )?;
        if existing_tombstone {
            return Err(SecurityDbError::ApprovalRejected);
        }
        let approval = tx.query_row(
            "SELECT nonce, intent_digest, preflight_digest, token, created_unix_ms, expires_unix_ms
             FROM pending_approvals WHERE approval_id = ?1",
            [approval_id],
            |row| Ok(StoredApprovalChallenge {
                approval_id: approval_id.to_owned(),
                nonce: row.get(0)?,
                intent_digest: row.get(1)?,
                preflight_digest: row.get(2)?,
                token: row.get(3)?,
                created_unix_ms: row.get(4)?,
                expires_unix_ms: row.get(5)?,
            }),
        ).optional()?.ok_or(SecurityDbError::ApprovalRejected)?;
        if approval.expires_unix_ms < now_unix_ms
            || approval.nonce != nonce
            || approval.intent_digest != intent_digest
            || approval.preflight_digest != preflight_digest
            || approval.token != token
        {
            return Err(SecurityDbError::ApprovalRejected);
        }
        tx.execute(
            "INSERT INTO approval_tombstones
             (approval_id, disposition, consumed_unix_ms, challenge_expires_unix_ms)
             VALUES (?1, 'consumed', ?2, ?3)",
            params![approval_id, now_unix_ms, approval.expires_unix_ms],
        )?;
        tx.execute(
            "DELETE FROM pending_approvals WHERE approval_id = ?1",
            [approval_id],
        )?;
        tx.commit()?;
        Ok(approval)
    }

    pub fn revoke_approval(&self, approval_id: &str, now_unix_ms: i64) -> SecurityDbResult<()> {
        validate_text("approval id", approval_id)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expires = tx
            .query_row(
                "SELECT expires_unix_ms FROM pending_approvals WHERE approval_id = ?1",
                [approval_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now_unix_ms);
        tx.execute(
            "INSERT INTO approval_tombstones
             (approval_id, disposition, consumed_unix_ms, challenge_expires_unix_ms)
             VALUES (?1, 'revoked', ?2, ?3)
             ON CONFLICT(approval_id) DO NOTHING",
            params![approval_id, now_unix_ms, expires],
        )?;
        tx.execute(
            "DELETE FROM pending_approvals WHERE approval_id = ?1",
            [approval_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn is_approval_consumed(&self, approval_id: &str) -> SecurityDbResult<bool> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM approval_tombstones WHERE approval_id = ?1)",
            [approval_id],
            |r| r.get(0),
        )?)
    }

    /// Records a schema observation. A changed hash clears the old allowlist
    /// and becomes pending until `approve_mcp_schema` is called.
    pub fn observe_mcp_schema(
        &self,
        connection_id: &str,
        schema_hash: &str,
        schema: Value,
        now_unix_ms: i64,
    ) -> SecurityDbResult<StoredMcpSchema> {
        validate_text("MCP connection id", connection_id)?;
        validate_digest("MCP schema hash", schema_hash)?;
        validate_json_size(&schema)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(Option<String>, String)> = tx.query_row(
            "SELECT approved_schema_hash, allowed_tools_json FROM mcp_schemas WHERE connection_id=?1",
            [connection_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (approved, pending, allowed_tools) = match current {
            None => (Some(schema_hash.to_owned()), None, Vec::new()),
            Some((approved, allowed_json)) if approved.as_deref() == Some(schema_hash) => {
                (approved, None, serde_json::from_str(&allowed_json)?)
            }
            Some((approved, _)) => (approved, Some(schema_hash.to_owned()), Vec::new()),
        };
        tx.execute(
            "INSERT INTO mcp_schemas
             (connection_id, approved_schema_hash, pending_schema_hash, schema_json,
              allowed_tools_json, updated_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(connection_id) DO UPDATE SET
               approved_schema_hash=excluded.approved_schema_hash,
               pending_schema_hash=excluded.pending_schema_hash,
               schema_json=excluded.schema_json,
               allowed_tools_json=excluded.allowed_tools_json,
               updated_unix_ms=excluded.updated_unix_ms",
            params![
                connection_id,
                approved,
                pending,
                serde_json::to_string(&schema)?,
                serde_json::to_string(&allowed_tools)?,
                now_unix_ms,
            ],
        )?;
        tx.commit()?;
        Ok(StoredMcpSchema {
            connection_id: connection_id.to_owned(),
            approved_schema_hash: approved,
            pending_schema_hash: pending,
            schema,
            allowed_tools,
            updated_unix_ms: now_unix_ms,
        })
    }

    pub fn approve_mcp_schema(
        &self,
        connection_id: &str,
        expected_hash: &str,
        allowed_tools: &[String],
        now_unix_ms: i64,
    ) -> SecurityDbResult<()> {
        validate_digest("MCP schema hash", expected_hash)?;
        for tool in allowed_tools {
            validate_text("MCP tool id", tool)?;
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending: Option<String> = tx
            .query_row(
                "SELECT pending_schema_hash FROM mcp_schemas WHERE connection_id=?1",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        // First observations are approved immediately and have no pending hash.
        let approved: Option<String> = tx
            .query_row(
                "SELECT approved_schema_hash FROM mcp_schemas WHERE connection_id=?1",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if pending.as_deref() != Some(expected_hash) && approved.as_deref() != Some(expected_hash) {
            return Err(SecurityDbError::InvalidRecord(
                "MCP schema approval digest mismatch".into(),
            ));
        }
        tx.execute(
            "UPDATE mcp_schemas
             SET approved_schema_hash=?2, pending_schema_hash=NULL,
                 allowed_tools_json=?3, updated_unix_ms=?4
             WHERE connection_id=?1",
            params![
                connection_id,
                expected_hash,
                serde_json::to_string(allowed_tools)?,
                now_unix_ms
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn mcp_schema(&self, connection_id: &str) -> SecurityDbResult<Option<StoredMcpSchema>> {
        let connection = self.connection()?;
        let value = connection
            .query_row(
                "SELECT approved_schema_hash, pending_schema_hash, schema_json,
                    allowed_tools_json, updated_unix_ms
             FROM mcp_schemas WHERE connection_id=?1",
                [connection_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?;
        value
            .map(|(approved, pending, schema, tools, updated)| {
                Ok(StoredMcpSchema {
                    connection_id: connection_id.to_owned(),
                    approved_schema_hash: approved,
                    pending_schema_hash: pending,
                    schema: serde_json::from_str(&schema)?,
                    allowed_tools: serde_json::from_str(&tools)?,
                    updated_unix_ms: updated,
                })
            })
            .transpose()
    }

    pub fn upsert_mcp_session(&self, session: &StoredMcpSession) -> SecurityDbResult<()> {
        validate_mcp_session(session)?;
        let metadata = redact(session.metadata.clone());
        validate_json_size(&metadata)?;
        self.connection()?.execute(
            "INSERT INTO mcp_sessions
             (session_id, connection_id, project_id, state, metadata_json,
              created_unix_ms, last_seen_unix_ms, expires_unix_ms, revoked_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
             ON CONFLICT(session_id) DO UPDATE SET
               connection_id=excluded.connection_id, project_id=excluded.project_id,
               state=excluded.state, metadata_json=excluded.metadata_json,
               last_seen_unix_ms=excluded.last_seen_unix_ms,
               expires_unix_ms=excluded.expires_unix_ms, revoked_unix_ms=NULL",
            params![
                session.session_id,
                session.connection_id,
                session.project_id,
                session.state,
                serde_json::to_string(&metadata)?,
                session.created_unix_ms,
                session.last_seen_unix_ms,
                session.expires_unix_ms,
            ],
        )?;
        Ok(())
    }

    pub fn active_mcp_session(
        &self,
        session_id: &str,
        now_unix_ms: i64,
        project_id: Option<&str>,
    ) -> SecurityDbResult<Option<StoredMcpSession>> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT connection_id, project_id, state, metadata_json, created_unix_ms,
                    last_seen_unix_ms, expires_unix_ms
             FROM mcp_sessions
             WHERE session_id=?1 AND revoked_unix_ms IS NULL AND expires_unix_ms >= ?2
               AND (project_id IS NULL OR project_id=?3)",
                params![session_id, now_unix_ms, project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(connection_id, project_id, state, metadata, created, seen, expires)| {
                Ok(StoredMcpSession {
                    session_id: session_id.to_owned(),
                    connection_id,
                    project_id,
                    state,
                    metadata: serde_json::from_str(&metadata)?,
                    created_unix_ms: created,
                    last_seen_unix_ms: seen,
                    expires_unix_ms: expires,
                })
            },
        )
        .transpose()
    }

    /// Revokes every session/project-scoped authorization record atomically.
    pub fn revoke_scope(
        &self,
        session_id: Option<&str>,
        project_id: Option<&str>,
        now_unix_ms: i64,
    ) -> SecurityDbResult<u64> {
        if session_id.is_none() && project_id.is_none() {
            return Err(SecurityDbError::InvalidRecord("scope is required".into()));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut changed = 0_u64;
        changed += tx.execute(
            "UPDATE grants SET revoked_unix_ms=COALESCE(revoked_unix_ms, ?3)
             WHERE (session_id=?1 AND ?1 IS NOT NULL) OR (project_id=?2 AND ?2 IS NOT NULL)",
            params![session_id, project_id, now_unix_ms],
        )? as u64;
        changed += tx.execute(
            "UPDATE policies SET revoked_unix_ms=COALESCE(revoked_unix_ms, ?3)
             WHERE (session_id=?1 AND ?1 IS NOT NULL) OR (project_id=?2 AND ?2 IS NOT NULL)",
            params![session_id, project_id, now_unix_ms],
        )? as u64;
        changed += tx.execute(
            "UPDATE mcp_sessions SET revoked_unix_ms=COALESCE(revoked_unix_ms, ?3)
             WHERE (session_id=?1 AND ?1 IS NOT NULL) OR (project_id=?2 AND ?2 IS NOT NULL)",
            params![session_id, project_id, now_unix_ms],
        )? as u64;
        tx.commit()?;
        Ok(changed)
    }

    pub fn append_audit(
        &self,
        event: AuditEvent,
        timestamp_unix_ms: i64,
    ) -> SecurityDbResult<StoredAuditEvent> {
        validate_text("audit category", &event.category)?;
        validate_text("audit action", &event.action)?;
        validate_text("audit outcome", &event.outcome)?;
        let fields = redact(event.fields);
        validate_json_size(&fields)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (anchor_sequence, anchor_hash) = audit_anchor(&tx)?;
        let head: Option<(i64, String)> = tx
            .query_row(
                "SELECT sequence, hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (sequence, previous_hash) = head
            .map(|(sequence, hash)| (sequence + 1, hash))
            .unwrap_or((anchor_sequence + 1, anchor_hash));
        let unsigned = serde_json::json!({
            "sequence": sequence,
            "timestamp_unix_ms": timestamp_unix_ms,
            "category": event.category,
            "action": event.action,
            "outcome": event.outcome,
            "fields": fields,
            "previous_hash": previous_hash,
        });
        let hash = digest_value(&unsigned)?;
        tx.execute(
            "INSERT INTO audit_events
             (sequence, timestamp_unix_ms, category, action, outcome, fields_json,
              previous_hash, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                sequence,
                timestamp_unix_ms,
                unsigned["category"].as_str().unwrap(),
                unsigned["action"].as_str().unwrap(),
                unsigned["outcome"].as_str().unwrap(),
                serde_json::to_string(&unsigned["fields"])?,
                previous_hash,
                hash,
            ],
        )?;
        tx.commit()?;
        Ok(StoredAuditEvent {
            sequence,
            timestamp_unix_ms,
            category: unsigned["category"].as_str().unwrap().to_owned(),
            action: unsigned["action"].as_str().unwrap().to_owned(),
            outcome: unsigned["outcome"].as_str().unwrap().to_owned(),
            fields: unsigned["fields"].clone(),
            previous_hash,
            hash,
        })
    }

    pub fn verify_integrity(&self) -> SecurityDbResult<()> {
        let connection = self.connection()?;
        reject_corruption(&connection)?;
        verify_audit_chain(&connection)
    }

    pub fn apply_retention(
        &self,
        now_unix_ms: i64,
        policy: RetentionPolicy,
    ) -> SecurityDbResult<RetentionReport> {
        validate_retention(policy)?;
        let inactive_cutoff = now_unix_ms.saturating_sub(policy.inactive_records_ms);
        let approval_cutoff = now_unix_ms.saturating_sub(policy.approval_tombstones_ms);
        let audit_cutoff = now_unix_ms.saturating_sub(policy.audit_events_ms);
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let grants_removed = tx.execute(
            "DELETE FROM grants
             WHERE (revoked_unix_ms IS NOT NULL AND revoked_unix_ms < ?1)
                OR (expires_unix_ms IS NOT NULL AND expires_unix_ms < ?1)
                OR (used_unix_ms IS NOT NULL AND used_unix_ms < ?1)",
            [inactive_cutoff],
        )? as u64;
        let policies_removed = tx.execute(
            "DELETE FROM policies
             WHERE (revoked_unix_ms IS NOT NULL AND revoked_unix_ms < ?1)
                OR (expires_unix_ms IS NOT NULL AND expires_unix_ms < ?1)",
            [inactive_cutoff],
        )? as u64;
        let approvals_removed = tx.execute(
            "DELETE FROM approval_tombstones
             WHERE consumed_unix_ms < ?1 AND challenge_expires_unix_ms < ?1",
            [approval_cutoff],
        )? as u64;
        tx.execute(
            "DELETE FROM pending_approvals WHERE expires_unix_ms < ?1",
            [inactive_cutoff],
        )?;
        let mcp_sessions_removed = tx.execute(
            "DELETE FROM mcp_sessions
             WHERE (revoked_unix_ms IS NOT NULL AND revoked_unix_ms < ?1)
                OR expires_unix_ms < ?1",
            [inactive_cutoff],
        )? as u64;
        let audit_tail: Option<(i64, String)> = tx
            .query_row(
                "SELECT sequence, hash FROM audit_events
             WHERE timestamp_unix_ms < ?1 ORDER BY sequence DESC LIMIT 1",
                [audit_cutoff],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let audit_events_removed = if let Some((sequence, hash)) = audit_tail {
            set_meta(&tx, "audit_anchor_sequence", &sequence.to_string())?;
            set_meta(&tx, "audit_anchor_hash", &hash)?;
            tx.execute("DELETE FROM audit_events WHERE sequence <= ?1", [sequence])? as u64
        } else {
            0
        };
        tx.commit()?;
        Ok(RetentionReport {
            grants_removed,
            policies_removed,
            approvals_removed,
            mcp_sessions_removed,
            audit_events_removed,
        })
    }

    /// Creates a transactionally consistent SQLite snapshot. The manifest
    /// explicitly attests that DPAPI credentials and the profile key are not
    /// part of this database or snapshot.
    pub fn snapshot_to(
        &self,
        destination: impl AsRef<Path>,
        created_unix_ms: i64,
    ) -> SecurityDbResult<SecurityBackupManifest> {
        let destination = destination.as_ref();
        if destination == self.path {
            return Err(SecurityDbError::InvalidRecord(
                "snapshot destination equals source".into(),
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            return Err(SecurityDbError::InvalidRecord(
                "snapshot destination already exists".into(),
            ));
        }
        let source = self.connection()?;
        let mut target = Connection::open(destination)?;
        {
            let backup = Backup::new(&source, &mut target)?;
            backup.run_to_completion(64, Duration::from_millis(2), None)?;
        }
        target.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        drop(target);
        let snapshot = SecurityDatabase::open(destination)?;
        snapshot.verify_integrity()?;
        let (anchor_sequence, _, head_sequence, head_hash) = snapshot.audit_summary()?;
        drop(snapshot);
        Ok(SecurityBackupManifest {
            format: "cupcake-broker-security-snapshot-v1".into(),
            schema_version: SCHEMA_VERSION,
            created_unix_ms,
            application_id: APPLICATION_ID,
            contains_provider_credentials: false,
            contains_profile_master_key: false,
            audit_anchor_sequence: anchor_sequence,
            audit_head_sequence: head_sequence,
            audit_head_hash: head_hash,
            snapshot_sha256: digest_file(destination)?,
        })
    }

    /// Alias used by the desktop backup coordinator.
    pub fn backup_to(
        &self,
        destination: impl AsRef<Path>,
        created_unix_ms: i64,
    ) -> SecurityDbResult<SecurityBackupManifest> {
        self.snapshot_to(destination, created_unix_ms)
    }

    /// Opens a snapshot read/write only long enough to run SQLite and audit
    /// integrity checks. It does not restore it or expose authorization rows.
    pub fn verify_snapshot(snapshot: impl AsRef<Path>) -> SecurityDbResult<SecurityBackupManifest> {
        let snapshot_path = snapshot.as_ref();
        let snapshot = SecurityDatabase::open(snapshot_path)?;
        snapshot.verify_integrity()?;
        let (anchor_sequence, _, head_sequence, head_hash) = snapshot.audit_summary()?;
        drop(snapshot);
        Ok(SecurityBackupManifest {
            format: "cupcake-broker-security-snapshot-v1".into(),
            schema_version: SCHEMA_VERSION,
            // Creation time belongs to the coordinator's external backup
            // manifest; it is intentionally not inferred from filesystem time.
            created_unix_ms: 0,
            application_id: APPLICATION_ID,
            contains_provider_credentials: false,
            contains_profile_master_key: false,
            audit_anchor_sequence: anchor_sequence,
            audit_head_sequence: head_sequence,
            audit_head_hash: head_hash,
            snapshot_sha256: digest_file(snapshot_path)?,
        })
    }

    /// Restores a validated snapshot into a new database using an atomic rename.
    /// An existing destination is never overwritten.
    pub fn restore_snapshot(
        snapshot: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        restored_unix_ms: i64,
    ) -> SecurityDbResult<SecurityBackupManifest> {
        let snapshot = snapshot.as_ref();
        let destination = destination.as_ref();
        if destination.exists() {
            return Err(SecurityDbError::InvalidRecord(
                "restore destination already exists".into(),
            ));
        }
        let source = SecurityDatabase::open(snapshot)?;
        source.verify_integrity()?;
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let file_name = destination
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("security.db");
        let temporary = parent.join(format!(".{file_name}.restore-{}.tmp", uuid::Uuid::now_v7()));
        let result = source.snapshot_to(&temporary, restored_unix_ms);
        let manifest = match result {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        };
        fs::rename(&temporary, destination)?;
        let restored = SecurityDatabase::open(destination)?;
        restored.verify_integrity()?;
        drop(restored);
        Ok(SecurityBackupManifest {
            snapshot_sha256: digest_file(destination)?,
            ..manifest
        })
    }

    pub fn export_redacted_metadata(&self) -> SecurityDbResult<RedactedSecurityExport> {
        let connection = self.connection()?;
        let mut counts = BTreeMap::new();
        for table in [
            "grants",
            "policies",
            "pending_approvals",
            "approval_tombstones",
            "mcp_schemas",
            "mcp_sessions",
            "audit_events",
        ] {
            // Table names are a closed compile-time allowlist.
            let count =
                connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            counts.insert(table.to_owned(), count);
        }
        let mut statement =
            connection.prepare("SELECT connection_id FROM mcp_schemas ORDER BY connection_id")?;
        let connections = statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?;
        let (anchor_sequence, _, head_sequence, head_hash) = audit_summary_with(&connection)?;
        Ok(RedactedSecurityExport {
            format: "cupcake-broker-security-redacted-metadata-v1".into(),
            schema_version: SCHEMA_VERSION,
            application_id: APPLICATION_ID,
            contains_provider_credentials: false,
            contains_profile_master_key: false,
            record_counts: counts,
            audit_anchor_sequence: anchor_sequence,
            audit_head_sequence: head_sequence,
            audit_head_hash: head_hash,
            mcp_connections: connections,
        })
    }

    fn audit_summary(&self) -> SecurityDbResult<(i64, String, i64, String)> {
        let connection = self.connection()?;
        audit_summary_with(&connection)
    }

    fn connection(&self) -> SecurityDbResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| SecurityDbError::Poisoned)
    }
}

fn configure_connection(connection: &Connection) -> SecurityDbResult<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA trusted_schema=OFF;
         PRAGMA secure_delete=ON;
         PRAGMA synchronous=FULL;
         PRAGMA temp_store=MEMORY;
         PRAGMA wal_autocheckpoint=256;",
    )?;
    let mode: String = connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(SecurityDbError::InvalidRecord(
            "WAL mode is unavailable".into(),
        ));
    }
    Ok(())
}

fn reject_corruption(connection: &Connection) -> SecurityDbResult<()> {
    let status: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| SecurityDbError::Corrupt(error.to_string()))?;
    if status != "ok" {
        return Err(SecurityDbError::Corrupt(status));
    }
    Ok(())
}

fn migrate(connection: &mut Connection, existed_with_data: bool) -> SecurityDbResult<()> {
    let application_id: i64 = connection.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(SecurityDbError::UnsupportedVersion {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    if existed_with_data && application_id != APPLICATION_ID {
        return Err(SecurityDbError::WrongApplication);
    }
    if version == 0 {
        let tx = connection.transaction_with_behavior(TransactionBehavior::Exclusive)?;
        tx.execute_batch(&format!(
            "PRAGMA application_id={APPLICATION_ID};
             CREATE TABLE security_meta (
               key TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL
             ) STRICT;
             CREATE TABLE grants (
               id TEXT PRIMARY KEY NOT NULL,
               resource_id TEXT NOT NULL,
               permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
               scope_kind TEXT NOT NULL CHECK(scope_kind IN ('once','session','project','persistent')),
               session_id TEXT,
               project_id TEXT,
               created_unix_ms INTEGER NOT NULL,
               expires_unix_ms INTEGER,
               used_unix_ms INTEGER,
               revoked_unix_ms INTEGER,
               CHECK((scope_kind='session')=(session_id IS NOT NULL)),
               CHECK((scope_kind='project')=(project_id IS NOT NULL))
             ) STRICT;
             CREATE INDEX grants_session_idx ON grants(session_id);
             CREATE INDEX grants_project_idx ON grants(project_id);
             CREATE TABLE policies (
               id TEXT PRIMARY KEY NOT NULL,
               tool_id TEXT NOT NULL,
               effect TEXT NOT NULL,
               resource_id TEXT,
               decision TEXT NOT NULL CHECK(decision IN ('allow','deny','ask')),
               scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','session','project')),
               session_id TEXT,
               project_id TEXT,
               created_unix_ms INTEGER NOT NULL,
               expires_unix_ms INTEGER,
               revoked_unix_ms INTEGER,
               CHECK((scope_kind='session')=(session_id IS NOT NULL)),
               CHECK((scope_kind='project')=(project_id IS NOT NULL))
             ) STRICT;
             CREATE INDEX policies_session_idx ON policies(session_id);
             CREATE INDEX policies_project_idx ON policies(project_id);
             CREATE TABLE pending_approvals (
               approval_id TEXT PRIMARY KEY NOT NULL,
               nonce TEXT NOT NULL,
               intent_digest TEXT NOT NULL,
               preflight_digest TEXT NOT NULL,
               token TEXT NOT NULL,
               created_unix_ms INTEGER NOT NULL,
               expires_unix_ms INTEGER NOT NULL
             ) STRICT;
             CREATE TABLE approval_tombstones (
               approval_id TEXT PRIMARY KEY NOT NULL,
               disposition TEXT NOT NULL CHECK(disposition IN ('consumed','revoked')),
               consumed_unix_ms INTEGER NOT NULL,
               challenge_expires_unix_ms INTEGER NOT NULL
             ) STRICT;
             CREATE TABLE mcp_schemas (
               connection_id TEXT PRIMARY KEY NOT NULL,
               approved_schema_hash TEXT,
               pending_schema_hash TEXT,
               schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
               allowed_tools_json TEXT NOT NULL CHECK(json_valid(allowed_tools_json)),
               updated_unix_ms INTEGER NOT NULL
             ) STRICT;
             CREATE TABLE mcp_sessions (
               session_id TEXT PRIMARY KEY NOT NULL,
               connection_id TEXT NOT NULL REFERENCES mcp_schemas(connection_id) ON DELETE CASCADE,
               project_id TEXT,
               state TEXT NOT NULL,
               metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
               created_unix_ms INTEGER NOT NULL,
               last_seen_unix_ms INTEGER NOT NULL,
               expires_unix_ms INTEGER NOT NULL,
               revoked_unix_ms INTEGER
             ) STRICT;
             CREATE INDEX mcp_sessions_project_idx ON mcp_sessions(project_id);
             CREATE TABLE audit_events (
               sequence INTEGER PRIMARY KEY NOT NULL,
               timestamp_unix_ms INTEGER NOT NULL,
               category TEXT NOT NULL,
               action TEXT NOT NULL,
               outcome TEXT NOT NULL,
               fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
               previous_hash TEXT NOT NULL,
               hash TEXT NOT NULL UNIQUE
             ) STRICT;
             PRAGMA user_version={SCHEMA_VERSION};"
        ))?;
        set_meta(&tx, "audit_anchor_sequence", "0")?;
        set_meta(&tx, "audit_anchor_hash", GENESIS_HASH)?;
        tx.commit()?;
    }
    let final_application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    if final_application_id != APPLICATION_ID {
        return Err(SecurityDbError::WrongApplication);
    }
    verify_audit_chain(connection)?;
    Ok(())
}

fn verify_audit_chain(connection: &Connection) -> SecurityDbResult<()> {
    let (mut expected_sequence, mut previous_hash) = audit_anchor(connection)?;
    let mut statement = connection.prepare(
        "SELECT sequence, timestamp_unix_ms, category, action, outcome, fields_json,
                previous_hash, hash FROM audit_events ORDER BY sequence",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let timestamp: i64 = row.get(1)?;
        let category: String = row.get(2)?;
        let action: String = row.get(3)?;
        let outcome: String = row.get(4)?;
        let fields_text: String = row.get(5)?;
        let stored_previous: String = row.get(6)?;
        let stored_hash: String = row.get(7)?;
        expected_sequence += 1;
        if sequence != expected_sequence || stored_previous != previous_hash {
            return Err(SecurityDbError::Corrupt("audit chain discontinuity".into()));
        }
        let fields: Value = serde_json::from_str(&fields_text)
            .map_err(|_| SecurityDbError::Corrupt("invalid audit JSON".into()))?;
        let unsigned = serde_json::json!({
            "sequence": sequence, "timestamp_unix_ms": timestamp,
            "category": category, "action": action, "outcome": outcome,
            "fields": fields, "previous_hash": stored_previous,
        });
        let expected_hash = digest_value(&unsigned)?;
        if stored_hash != expected_hash {
            return Err(SecurityDbError::Corrupt("audit event was modified".into()));
        }
        previous_hash = stored_hash;
    }
    Ok(())
}

fn audit_anchor(connection: &Connection) -> SecurityDbResult<(i64, String)> {
    let sequence = get_meta(connection, "audit_anchor_sequence")?
        .ok_or_else(|| SecurityDbError::Corrupt("missing audit anchor sequence".into()))?
        .parse::<i64>()
        .map_err(|_| SecurityDbError::Corrupt("invalid audit anchor sequence".into()))?;
    let hash = get_meta(connection, "audit_anchor_hash")?
        .ok_or_else(|| SecurityDbError::Corrupt("missing audit anchor hash".into()))?;
    validate_digest("audit anchor hash", &hash)
        .map_err(|_| SecurityDbError::Corrupt("invalid audit anchor hash".into()))?;
    Ok((sequence, hash))
}

fn audit_summary_with(connection: &Connection) -> SecurityDbResult<(i64, String, i64, String)> {
    let (anchor_sequence, anchor_hash) = audit_anchor(connection)?;
    let head = connection
        .query_row(
            "SELECT sequence, hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((anchor_sequence, anchor_hash.clone()));
    Ok((anchor_sequence, anchor_hash, head.0, head.1))
}

fn get_meta(connection: &Connection, key: &str) -> SecurityDbResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT value FROM security_meta WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

fn set_meta(connection: &Connection, key: &str, value: &str) -> SecurityDbResult<()> {
    connection.execute(
        "INSERT INTO security_meta(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn validate_grant(value: &SecurityGrant) -> SecurityDbResult<()> {
    validate_text("grant id", &value.id)?;
    validate_text("grant resource", &value.resource_id)?;
    if value.permissions.is_empty() {
        return Err(SecurityDbError::InvalidRecord(
            "grant permissions are empty".into(),
        ));
    }
    for permission in &value.permissions {
        validate_text("grant permission", permission)?;
    }
    if value
        .expires_unix_ms
        .is_some_and(|expiry| expiry < value.created_unix_ms)
    {
        return Err(SecurityDbError::InvalidRecord(
            "grant expires before creation".into(),
        ));
    }
    match &value.scope {
        SecurityGrantScope::Session { session_id } => validate_text("session id", session_id),
        SecurityGrantScope::Project { project_id } => validate_text("project id", project_id),
        _ => Ok(()),
    }
}

fn validate_policy(value: &StoredPolicy) -> SecurityDbResult<()> {
    validate_text("policy id", &value.id)?;
    validate_text("policy tool id", &value.tool_id)?;
    validate_text("policy effect", &value.effect)?;
    if let Some(resource) = &value.resource_id {
        validate_text("policy resource", resource)?;
    }
    match &value.scope {
        StoredPolicyScope::Session { session_id } => validate_text("session id", session_id)?,
        StoredPolicyScope::Project { project_id } => validate_text("project id", project_id)?,
        StoredPolicyScope::Global => {}
    }
    if value
        .expires_unix_ms
        .is_some_and(|expiry| expiry < value.created_unix_ms)
    {
        return Err(SecurityDbError::InvalidRecord(
            "policy expires before creation".into(),
        ));
    }
    Ok(())
}

fn validate_approval(value: &StoredApprovalChallenge) -> SecurityDbResult<()> {
    for (label, text) in [
        ("approval id", value.approval_id.as_str()),
        ("approval nonce", &value.nonce),
        ("intent digest", &value.intent_digest),
        ("preflight digest", &value.preflight_digest),
        ("approval token", &value.token),
    ] {
        validate_text(label, text)?;
    }
    if value.expires_unix_ms < value.created_unix_ms {
        return Err(SecurityDbError::InvalidRecord(
            "approval expires before creation".into(),
        ));
    }
    Ok(())
}

fn validate_mcp_session(value: &StoredMcpSession) -> SecurityDbResult<()> {
    validate_text("MCP session id", &value.session_id)?;
    validate_text("MCP connection id", &value.connection_id)?;
    validate_text("MCP session state", &value.state)?;
    if let Some(project) = &value.project_id {
        validate_text("project id", project)?;
    }
    if value.expires_unix_ms < value.created_unix_ms
        || value.last_seen_unix_ms < value.created_unix_ms
    {
        return Err(SecurityDbError::InvalidRecord(
            "invalid MCP session timestamps".into(),
        ));
    }
    Ok(())
}

fn validate_retention(value: RetentionPolicy) -> SecurityDbResult<()> {
    if value.inactive_records_ms < 0
        || value.approval_tombstones_ms < 0
        || value.audit_events_ms < 0
    {
        return Err(SecurityDbError::InvalidRecord(
            "retention durations cannot be negative".into(),
        ));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str) -> SecurityDbResult<()> {
    if value.trim().is_empty() || value.len() > MAX_TEXT_BYTES || value.contains('\0') {
        return Err(SecurityDbError::InvalidRecord(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_digest(label: &str, value: &str) -> SecurityDbResult<()> {
    validate_text(label, value)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SecurityDbError::InvalidRecord(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_json_size(value: &Value) -> SecurityDbResult<()> {
    if serde_json::to_vec(value)?.len() > MAX_TEXT_BYTES {
        return Err(SecurityDbError::InvalidRecord(
            "JSON record exceeds size limit".into(),
        ));
    }
    Ok(())
}

fn grant_scope_columns(scope: &SecurityGrantScope) -> (&'static str, Option<&str>, Option<&str>) {
    match scope {
        SecurityGrantScope::Once => ("once", None, None),
        SecurityGrantScope::Session { session_id } => ("session", Some(session_id), None),
        SecurityGrantScope::Project { project_id } => ("project", None, Some(project_id)),
        SecurityGrantScope::Persistent => ("persistent", None, None),
    }
}

fn columns_to_grant_scope(
    kind: &str,
    session: Option<String>,
    project: Option<String>,
) -> SecurityDbResult<SecurityGrantScope> {
    match kind {
        "once" => Ok(SecurityGrantScope::Once),
        "session" => session
            .map(|session_id| SecurityGrantScope::Session { session_id })
            .ok_or_else(|| SecurityDbError::Corrupt("session grant has no session".into())),
        "project" => project
            .map(|project_id| SecurityGrantScope::Project { project_id })
            .ok_or_else(|| SecurityDbError::Corrupt("project grant has no project".into())),
        "persistent" => Ok(SecurityGrantScope::Persistent),
        _ => Err(SecurityDbError::Corrupt("invalid grant scope".into())),
    }
}

fn policy_scope_columns(scope: &StoredPolicyScope) -> (&'static str, Option<&str>, Option<&str>) {
    match scope {
        StoredPolicyScope::Global => ("global", None, None),
        StoredPolicyScope::Session { session_id } => ("session", Some(session_id), None),
        StoredPolicyScope::Project { project_id } => ("project", None, Some(project_id)),
    }
}

fn columns_to_policy_scope(
    kind: &str,
    session: Option<String>,
    project: Option<String>,
) -> SecurityDbResult<StoredPolicyScope> {
    match kind {
        "global" => Ok(StoredPolicyScope::Global),
        "session" => session
            .map(|session_id| StoredPolicyScope::Session { session_id })
            .ok_or_else(|| SecurityDbError::Corrupt("session policy has no session".into())),
        "project" => project
            .map(|project_id| StoredPolicyScope::Project { project_id })
            .ok_or_else(|| SecurityDbError::Corrupt("project policy has no project".into())),
        _ => Err(SecurityDbError::Corrupt("invalid policy scope".into())),
    }
}

fn policy_decision_text(value: StoredPolicyDecision) -> &'static str {
    match value {
        StoredPolicyDecision::Allow => "allow",
        StoredPolicyDecision::Deny => "deny",
        StoredPolicyDecision::Ask => "ask",
    }
}

fn parse_policy_decision(value: &str) -> SecurityDbResult<StoredPolicyDecision> {
    match value {
        "allow" => Ok(StoredPolicyDecision::Allow),
        "deny" => Ok(StoredPolicyDecision::Deny),
        "ask" => Ok(StoredPolicyDecision::Ask),
        _ => Err(SecurityDbError::Corrupt("invalid policy decision".into())),
    }
}

fn digest_value(value: &Value) -> SecurityDbResult<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn digest_file(path: &Path) -> SecurityDbResult<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn database() -> (tempfile::TempDir, SecurityDatabase) {
        let dir = tempdir().unwrap();
        let database = SecurityDatabase::open(dir.path().join("security.db")).unwrap();
        (dir, database)
    }

    fn challenge(id: &str) -> StoredApprovalChallenge {
        StoredApprovalChallenge {
            approval_id: id.into(),
            nonce: "nonce".into(),
            intent_digest: "intent".into(),
            preflight_digest: "preflight".into(),
            token: "hmac-token".into(),
            created_unix_ms: 100,
            expires_unix_ms: 1_000,
        }
    }

    #[test]
    fn configures_wal_full_sync_and_separate_application_id() {
        let (_dir, database) = database();
        let connection = database.connection().unwrap();
        assert_eq!(
            connection
                .query_row::<String, _, _>("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap()
                .to_lowercase(),
            "wal"
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>("PRAGMA synchronous", [], |r| r.get(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>("PRAGMA application_id", [], |r| r.get(0))
                .unwrap(),
            APPLICATION_ID
        );
        drop(connection);
        assert_eq!(database.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn once_grant_is_consumed_atomically_and_scope_is_enforced() {
        let (_dir, database) = database();
        database
            .issue_grant(&SecurityGrant {
                id: "grant-once".into(),
                resource_id: "opaque-folder-1".into(),
                permissions: vec!["read".into()],
                scope: SecurityGrantScope::Once,
                created_unix_ms: 1,
                expires_unix_ms: Some(100),
            })
            .unwrap();
        database
            .authorize_grant("grant-once", "read", 10, None, None)
            .unwrap();
        assert!(matches!(
            database.authorize_grant("grant-once", "read", 11, None, None),
            Err(SecurityDbError::GrantRejected)
        ));

        database
            .issue_grant(&SecurityGrant {
                id: "project-grant".into(),
                resource_id: "opaque-folder-2".into(),
                permissions: vec!["modify".into()],
                scope: SecurityGrantScope::Project {
                    project_id: "project-a".into(),
                },
                created_unix_ms: 1,
                expires_unix_ms: None,
            })
            .unwrap();
        assert!(database
            .authorize_grant("project-grant", "modify", 10, None, Some("project-b"))
            .is_err());
        database
            .authorize_grant("project-grant", "modify", 10, None, Some("project-a"))
            .unwrap();
        database.revoke_scope(None, Some("project-a"), 11).unwrap();
        assert!(database
            .authorize_grant("project-grant", "modify", 12, None, Some("project-a"))
            .is_err());
    }

    #[test]
    fn policy_scope_and_expiry_are_durable() {
        let (dir, database) = database();
        database
            .put_policy(&StoredPolicy {
                id: "policy-1".into(),
                tool_id: "native.files".into(),
                effect: "read_files".into(),
                resource_id: Some("opaque-folder".into()),
                decision: StoredPolicyDecision::Allow,
                scope: StoredPolicyScope::Session {
                    session_id: "session-a".into(),
                },
                created_unix_ms: 10,
                expires_unix_ms: Some(100),
            })
            .unwrap();
        assert_eq!(
            database
                .active_policies(20, Some("session-a"), None)
                .unwrap()
                .len(),
            1
        );
        assert!(database
            .active_policies(20, Some("session-b"), None)
            .unwrap()
            .is_empty());
        let path = database.path().to_owned();
        drop(database);
        let reopened = SecurityDatabase::open(path).unwrap();
        assert_eq!(
            reopened
                .active_policies(20, Some("session-a"), None)
                .unwrap()
                .len(),
            1
        );
        assert!(dir.path().join("security.db").exists());
    }

    #[test]
    fn approval_replay_is_rejected_after_restart() {
        let (dir, database) = database();
        let approval = challenge("approval-1");
        database.store_pending_approval(&approval).unwrap();
        database
            .consume_approval(
                "approval-1",
                "nonce",
                "intent",
                "preflight",
                "hmac-token",
                200,
            )
            .unwrap();
        let path = database.path().to_owned();
        drop(database);
        let reopened = SecurityDatabase::open(path).unwrap();
        assert!(reopened.is_approval_consumed("approval-1").unwrap());
        assert!(matches!(
            reopened.consume_approval(
                "approval-1",
                "nonce",
                "intent",
                "preflight",
                "hmac-token",
                201
            ),
            Err(SecurityDbError::ApprovalRejected)
        ));
        assert!(dir.path().exists());
    }

    #[test]
    fn mismatched_approval_does_not_consume_the_valid_challenge() {
        let (_dir, database) = database();
        database
            .store_pending_approval(&challenge("approval-2"))
            .unwrap();
        assert!(database
            .consume_approval(
                "approval-2",
                "bad",
                "intent",
                "preflight",
                "hmac-token",
                200
            )
            .is_err());
        database
            .consume_approval(
                "approval-2",
                "nonce",
                "intent",
                "preflight",
                "hmac-token",
                201,
            )
            .unwrap();
    }

    #[test]
    fn mcp_schema_change_invalidates_tools_and_session_metadata_is_redacted() {
        let (_dir, database) = database();
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        database
            .observe_mcp_schema("mcp-a", &hash_a, serde_json::json!({"tools":["read"]}), 10)
            .unwrap();
        database
            .approve_mcp_schema("mcp-a", &hash_a, &["read".into()], 11)
            .unwrap();
        let changed = database
            .observe_mcp_schema(
                "mcp-a",
                &hash_b,
                serde_json::json!({"tools":["read","write"]}),
                12,
            )
            .unwrap();
        assert_eq!(
            changed.pending_schema_hash.as_deref(),
            Some(hash_b.as_str())
        );
        assert!(changed.allowed_tools.is_empty());
        database
            .upsert_mcp_session(&StoredMcpSession {
                session_id: "session-a".into(),
                connection_id: "mcp-a".into(),
                project_id: Some("project-a".into()),
                state: "connected".into(),
                metadata: serde_json::json!({"authorization":"Bearer secret.value"}),
                created_unix_ms: 10,
                last_seen_unix_ms: 11,
                expires_unix_ms: 100,
            })
            .unwrap();
        let stored = database
            .active_mcp_session("session-a", 12, Some("project-a"))
            .unwrap()
            .unwrap();
        assert_eq!(stored.metadata["authorization"], "[REDACTED]");
        assert!(database
            .active_mcp_session("session-a", 12, Some("project-b"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn audit_chain_redacts_detects_tampering_and_survives_retention_anchor() {
        let (_dir, database) = database();
        database.append_audit(AuditEvent {
            category: "provider".into(), action: "connect".into(), outcome: "ok".into(),
            fields: serde_json::json!({"api_key":"sk-do-not-store-abcdefghijklmnopqrstuvwxyz"}),
        }, 10).unwrap();
        database
            .append_audit(
                AuditEvent {
                    category: "tool".into(),
                    action: "read".into(),
                    outcome: "ok".into(),
                    fields: serde_json::json!({"resource":"opaque"}),
                },
                100,
            )
            .unwrap();
        database.verify_integrity().unwrap();
        let report = database
            .apply_retention(
                200,
                RetentionPolicy {
                    inactive_records_ms: 10_000,
                    approval_tombstones_ms: 10_000,
                    audit_events_ms: 150,
                },
            )
            .unwrap();
        assert_eq!(report.audit_events_removed, 1);
        database.verify_integrity().unwrap();
        let next = database
            .append_audit(
                AuditEvent {
                    category: "tool".into(),
                    action: "write".into(),
                    outcome: "denied".into(),
                    fields: Value::Null,
                },
                201,
            )
            .unwrap();
        assert_eq!(next.sequence, 3);
        let connection = database.connection().unwrap();
        let text: String = connection
            .query_row(
                "SELECT fields_json FROM audit_events WHERE sequence=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!text.contains("do-not-store"));
    }

    #[test]
    fn audit_tampering_is_rejected_on_reopen() {
        let (dir, database) = database();
        database
            .append_audit(
                AuditEvent {
                    category: "tool".into(),
                    action: "read".into(),
                    outcome: "ok".into(),
                    fields: serde_json::json!({"resource":"opaque"}),
                },
                10,
            )
            .unwrap();
        let path = database.path().to_owned();
        {
            let connection = database.connection().unwrap();
            connection
                .execute(
                    "UPDATE audit_events SET outcome='tampered' WHERE sequence=1",
                    [],
                )
                .unwrap();
        }
        assert!(matches!(
            database.verify_integrity(),
            Err(SecurityDbError::Corrupt(_))
        ));
        drop(database);
        assert!(matches!(
            SecurityDatabase::open(path),
            Err(SecurityDbError::Corrupt(_))
        ));
        assert!(dir.path().exists());
    }

    #[test]
    fn snapshot_restore_is_consistent_and_manifest_excludes_dpapi_secrets() {
        let (dir, database) = database();
        database
            .store_pending_approval(&challenge("approval-backup"))
            .unwrap();
        database
            .append_audit(
                AuditEvent {
                    category: "approval".into(),
                    action: "issue".into(),
                    outcome: "ok".into(),
                    fields: Value::Null,
                },
                100,
            )
            .unwrap();
        let snapshot = dir.path().join("snapshot.db");
        let manifest = database.snapshot_to(&snapshot, 200).unwrap();
        assert!(!manifest.contains_provider_credentials);
        assert!(!manifest.contains_profile_master_key);
        assert_eq!(manifest.audit_head_sequence, 1);
        let verified = SecurityDatabase::verify_snapshot(&snapshot).unwrap();
        assert_eq!(verified.audit_head_hash, manifest.audit_head_hash);
        let restored_path = dir.path().join("restored.db");
        let restored_manifest =
            SecurityDatabase::restore_snapshot(&snapshot, &restored_path, 300).unwrap();
        assert!(!restored_manifest.contains_provider_credentials);
        let restored = SecurityDatabase::open(restored_path).unwrap();
        restored
            .consume_approval(
                "approval-backup",
                "nonce",
                "intent",
                "preflight",
                "hmac-token",
                400,
            )
            .unwrap();
        restored.verify_integrity().unwrap();
    }

    #[test]
    fn export_contains_counts_and_never_secret_material() {
        let (_dir, database) = database();
        database
            .store_pending_approval(&challenge("approval-export"))
            .unwrap();
        let export = database.export_redacted_metadata().unwrap();
        assert_eq!(export.record_counts["pending_approvals"], 1);
        assert!(!export.contains_provider_credentials);
        let json = serde_json::to_string(&export).unwrap();
        assert!(!json.contains("hmac-token"));
        assert!(!json.contains("nonce"));
    }

    #[test]
    fn rejects_future_version_wrong_application_and_corruption() {
        let dir = tempdir().unwrap();
        let future = dir.path().join("future.db");
        let connection = Connection::open(&future).unwrap();
        connection
            .execute_batch(&format!(
                "PRAGMA application_id={APPLICATION_ID}; PRAGMA user_version={};",
                SCHEMA_VERSION + 1
            ))
            .unwrap();
        drop(connection);
        assert!(matches!(
            SecurityDatabase::open(&future),
            Err(SecurityDbError::UnsupportedVersion { .. })
        ));

        let wrong = dir.path().join("wrong.db");
        let connection = Connection::open(&wrong).unwrap();
        connection.execute_batch("CREATE TABLE foreign_data(value TEXT); PRAGMA application_id=1234; PRAGMA user_version=1;").unwrap();
        drop(connection);
        assert!(matches!(
            SecurityDatabase::open(&wrong),
            Err(SecurityDbError::WrongApplication)
        ));

        let corrupt = dir.path().join("corrupt.db");
        fs::write(&corrupt, b"not a sqlite database").unwrap();
        assert!(SecurityDatabase::open(&corrupt).is_err());
    }

    #[test]
    fn crash_rollback_leaves_no_partial_approval_tombstone() {
        let (_dir, database) = database();
        database
            .store_pending_approval(&challenge("approval-crash"))
            .unwrap();
        {
            let mut connection = database.connection().unwrap();
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute(
                "INSERT INTO approval_tombstones(approval_id,disposition,consumed_unix_ms,challenge_expires_unix_ms)
                 VALUES('approval-crash','consumed',200,1000)", [],
            ).unwrap();
            // Drop without commit: SQLite atomically rolls back the simulated crash.
        }
        assert!(!database.is_approval_consumed("approval-crash").unwrap());
        database
            .consume_approval(
                "approval-crash",
                "nonce",
                "intent",
                "preflight",
                "hmac-token",
                201,
            )
            .unwrap();
    }
}
