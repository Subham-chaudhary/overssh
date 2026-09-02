//! `AppError`: the single error type returned by every Tauri command.
//!
//! Serializes to exactly the shape the frontend expects (see `docs/GUIDE.md` §5.1):
//! `{ kind, message, fingerprint?, keyPath? }`. The `kind` tag matches the TS
//! `ErrorKind` union verbatim (serde's default enum-variant naming is already
//! PascalCase, so no renaming is needed there); only the `key_path` field needs an
//! explicit rename to camelCase.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Error)]
#[serde(tag = "kind")]
pub enum AppError {
    #[error("{message}")]
    NeedPassword { message: String },

    #[error("{message}")]
    NeedPassphrase {
        message: String,
        #[serde(rename = "keyPath")]
        key_path: String,
    },

    #[error("{message}")]
    HostKeyUnknown { message: String, fingerprint: String },

    #[error("{message}")]
    HostKeyChanged { message: String },

    #[error("{message}")]
    AuthFailed { message: String },

    #[error("{message}")]
    Connection { message: String },

    #[error("{message}")]
    NotFound { message: String },

    #[error("{message}")]
    PermissionDenied { message: String },

    #[error("{message}")]
    Conflict { message: String },

    #[error("{message}")]
    TooLarge { message: String },

    #[error("{message}")]
    Config { message: String },

    #[error("{message}")]
    Io { message: String },

    #[error("{message}")]
    Other { message: String },
}

impl AppError {
    #[allow(dead_code)] // convenience constructor for future callers
    pub fn other(message: impl Into<String>) -> Self {
        AppError::Other { message: message.into() }
    }

    pub fn config(message: impl Into<String>) -> Self {
        AppError::Config { message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        AppError::NotFound { message: message.into() }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        AppError::Conflict { message: message.into() }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound { message: e.to_string() },
            std::io::ErrorKind::PermissionDenied => {
                AppError::PermissionDenied { message: e.to_string() }
            }
            _ => AppError::Io { message: e.to_string() },
        }
    }
}

/// Errors from the `russh` client (transport / key-exchange / auth plumbing).
/// This is also used as `client::Handler::Error`, so it must impl `From<russh::Error>`.
impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Connection { message: e.to_string() }
    }
}

/// Errors from the `russh-sftp` client, mapped per docs/GUIDE.md §6:
/// `NoSuchFile` -> `NotFound`, `PermissionDenied` -> `PermissionDenied`, else `Other`/`Io`.
impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as SftpError;
        use russh_sftp::protocol::StatusCode;

        match &e {
            SftpError::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => AppError::NotFound { message: e.to_string() },
                StatusCode::PermissionDenied => {
                    AppError::PermissionDenied { message: e.to_string() }
                }
                _ => AppError::Other { message: e.to_string() },
            },
            SftpError::IO(_) | SftpError::Timeout => AppError::Io { message: e.to_string() },
            _ => AppError::Other { message: e.to_string() },
        }
    }
}
