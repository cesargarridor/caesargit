//! Validación de refs, SHAs, ramas y remotos antes de pasarlos a git.
use crate::error::{AppError, Result};
use once_cell::sync::Lazy;
use regex::Regex;

static REF_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._/@{}^~:+-]+$").unwrap());
static SHA_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-fA-F]{4,64}$").unwrap());
static REMOTE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+$").unwrap());

fn bad(what: &str, v: &str) -> AppError {
    let shown: String = v.chars().take(60).collect();
    AppError::invalid_arg(format!("{what} no válido: {shown:?}"))
}

/// Ref genérica (rama, tag, HEAD~2, origin/main, stash@{0}). No admite `..`.
pub fn validate_ref(s: &str) -> Result<&str> {
    if s.is_empty()
        || s.len() > 255
        || s.starts_with('-')
        || s.contains("..")
        || !REF_RE.is_match(s)
    {
        return Err(bad("referencia", s));
    }
    Ok(s)
}

/// Rango explícito `a..b` o `a...b`, cada extremo validado como ref.
pub fn validate_range(s: &str) -> Result<&str> {
    let (a, b) = s.split_once("...").or_else(|| s.split_once("..")).ok_or_else(|| bad("rango", s))?;
    validate_ref(a)?;
    validate_ref(b)?;
    Ok(s)
}

/// SHA hexadecimal (4 a 64 caracteres).
pub fn validate_sha(s: &str) -> Result<&str> {
    if !SHA_RE.is_match(s) {
        return Err(bad("sha", s));
    }
    Ok(s)
}

/// Nombre de rama/tag nuevo según las reglas de `git check-ref-format`.
pub fn validate_branch_name(s: &str) -> Result<&str> {
    let invalid = s.is_empty()
        || s.len() > 255
        || s.starts_with('-')
        || s.starts_with('/')
        || s.ends_with('/')
        || s.ends_with('.')
        || s.ends_with(".lock")
        || s.contains("..")
        || s.contains("//")
        || s.contains("@{")
        || s == "@"
        || s.split('/').any(|p| p.starts_with('.') || p.ends_with(".lock"))
        || s.chars().any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c));
    if invalid {
        return Err(bad("nombre de rama", s));
    }
    Ok(s)
}

/// Nombre de remoto.
pub fn validate_remote(s: &str) -> Result<&str> {
    if s.is_empty() || s.len() > 100 || s.starts_with('-') || s.starts_with('.') || !REMOTE_RE.is_match(s) {
        return Err(bad("remoto", s));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs() {
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("origin/feature/x").is_ok());
        assert!(validate_ref("HEAD~2").is_ok());
        assert!(validate_ref("stash@{0}").is_ok());
        assert!(validate_ref("--upload-pack=evil").is_err());
        assert!(validate_ref("-x").is_err());
        assert!(validate_ref("a b").is_err());
        assert!(validate_ref("a..b").is_err());
        assert!(validate_ref("a;rm").is_err());
        assert!(validate_ref("").is_err());
    }

    #[test]
    fn ranges() {
        assert!(validate_range("main..feature").is_ok());
        assert!(validate_range("main...feature").is_ok());
        assert!(validate_range("--exec=x..b").is_err());
        assert!(validate_range("main").is_err());
    }

    #[test]
    fn shas() {
        assert!(validate_sha("abcdef1234").is_ok());
        assert!(validate_sha("xyz").is_err());
        assert!(validate_sha("abc").is_err());
        assert!(validate_sha("--help").is_err());
    }

    #[test]
    fn branches() {
        assert!(validate_branch_name("feature/new-thing").is_ok());
        assert!(validate_branch_name("-bad").is_err());
        assert!(validate_branch_name("a b").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("a.lock").is_err());
        assert!(validate_branch_name("a/").is_err());
        assert!(validate_branch_name("a~1").is_err());
        assert!(validate_branch_name("@").is_err());
        assert!(validate_branch_name("x/.hidden").is_err());
    }

    #[test]
    fn remotes() {
        assert!(validate_remote("origin").is_ok());
        assert!(validate_remote("--exec").is_err());
        assert!(validate_remote("a/b").is_err());
        assert!(validate_remote("").is_err());
    }
}
