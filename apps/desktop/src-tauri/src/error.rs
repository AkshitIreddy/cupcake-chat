use serde::Serialize;
use std::fmt::{Display, Formatter};

pub type HostResult<T> = Result<T, HostError>;

/// Renderer-safe error. Internal OS paths, command lines, secrets, and raw
/// sidecar diagnostics must never be placed in this value.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl HostError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message, false)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("RUNTIME_NOT_READY", message, true)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("HOST_ERROR", message, false)
    }
}

impl Display for HostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for HostError {}

impl From<tauri::Error> for HostError {
    fn from(_: tauri::Error) -> Self {
        Self::internal("The desktop host could not complete the window operation")
    }
}
