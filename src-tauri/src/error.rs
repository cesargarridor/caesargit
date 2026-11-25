//! AppError serializado como JSON `{code, message}`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    /// invalid_path | invalid_arg | git_failed | not_a_repo | io | conflict | busy
    pub code: String,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
    pub fn invalid_path(m: impl Into<String>) -> Self { Self::new("invalid_path", m) }
    pub fn invalid_arg(m: impl Into<String>) -> Self { Self::new("invalid_arg", m) }
    pub fn git_failed(m: impl Into<String>) -> Self { Self::new("git_failed", m) }
    pub fn not_a_repo(m: impl Into<String>) -> Self { Self::new("not_a_repo", m) }
    pub fn io(m: impl Into<String>) -> Self { Self::new("io", m) }
    pub fn conflict(m: impl Into<String>) -> Self { Self::new("conflict", m) }
    pub fn busy(m: impl Into<String>) -> Self { Self::new("busy", m) }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}
