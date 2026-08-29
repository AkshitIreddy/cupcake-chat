use thiserror::Error;

pub type Result<T, E = BrokerError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("frame exceeds limit: {actual} bytes (maximum {maximum})")]
    FrameTooLarge { actual: usize, maximum: usize },
    #[error("unexpected end of frame")]
    TruncatedFrame,
    #[error("unsupported protocol version {0}")]
    UnsupportedProtocol(u16),
    #[error("invalid protocol envelope: {0}")]
    InvalidEnvelope(String),
    #[error("sequence violation: expected {expected}, received {actual}")]
    SequenceViolation { expected: u64, actual: u64 },
    #[error("approval is invalid, expired, mismatched, or already consumed")]
    InvalidApproval,
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("grant is invalid, expired, mismatched, or revoked")]
    InvalidGrant,
    #[error("path escapes its granted root")]
    PathEscape,
    #[error("invalid state transition: {from} -> {to}")]
    InvalidTransition { from: String, to: String },
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
    #[error("duplicate identifier: {0}")]
    Duplicate(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("credential vault is unavailable: {0}")]
    VaultUnavailable(String),
    #[error("sandbox execution is unavailable: {0}")]
    SandboxUnavailable(String),
    #[error("integrity verification failed: {0}")]
    Integrity(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
}
