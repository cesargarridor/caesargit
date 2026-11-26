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

static URL_SCHEME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(https?|ssh|git|file)://[^\s]+$").unwrap());
static SCP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s:][^\s]*$").unwrap());
static DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9A-Za-z :.+/_-]{1,60}$").unwrap());

/// URL de remoto/clone: https/http/ssh/git/file, scp-like `user@host:path` o ruta local absoluta.
/// Bloquea transportes `ext::`/`fd::` y cualquier cosa que empiece por `-`.
pub fn validate_url(s: &str) -> Result<&str> {
    let local = (s.starts_with('/') || s.chars().nth(1) == Some(':') && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
        && !s.chars().any(|c| c.is_control());
    let ok = !s.is_empty()
        && s.len() <= 2048
        && !s.starts_with('-')
        && !s.chars().any(|c| c.is_control() || c == '\0')
        && !s.contains("::")
        && (URL_SCHEME_RE.is_match(s) || SCP_RE.is_match(s) || local);
    if ok {
        Ok(s)
    } else {
        Err(bad("URL", s))
    }
}

/// Texto libre de búsqueda para pasar como `--grep=`/`-S`/pathspec (sin NUL ni saltos de línea).
pub fn validate_search_text(s: &str) -> Result<&str> {
    if s.is_empty() || s.len() > 200 || s.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(bad("texto de búsqueda", s));
    }
    Ok(s)
}

/// Fecha para `--since/--until` (`2024-01-31`, `2 weeks ago`, ...).
pub fn validate_date(s: &str) -> Result<&str> {
    if !DATE_RE.is_match(s) {
        return Err(bad("fecha", s));
    }
    Ok(s)
}

/// Claves de configuración que la app permite leer/escribir (nada que ejecute programas).
pub const CONFIG_KEYS: &[&str] = &[
    "user.name",
    "user.email",
    "user.signingkey",
    "commit.gpgsign",
    "tag.gpgsign",
    "gpg.format",
    "pull.rebase",
    "pull.ff",
    "fetch.prune",
    "push.autosetupremote",
    "push.default",
    "core.autocrlf",
    "core.eol",
    "core.filemode",
    "core.ignorecase",
    "core.longpaths",
    "init.defaultbranch",
    "commit.template",
    "merge.ff",
    "rebase.autostash",
    "rebase.autosquash",
    "diff.tool",
    "merge.tool",
];

/// Clave de la lista blanca.
pub fn validate_config_key(s: &str) -> Result<&str> {
    let l = s.to_ascii_lowercase();
    if CONFIG_KEYS.contains(&l.as_str()) {
        Ok(s)
    } else {
        Err(bad("clave de configuración", s))
    }
}

/// Valor de configuración (una línea, sin NUL).
pub fn validate_config_value(key: &str, v: &str) -> Result<()> {
    if v.len() > 1024 || v.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(bad("valor de configuración", v));
    }
    if key.eq_ignore_ascii_case("gpg.format") && !["openpgp", "ssh", "x509"].contains(&v) {
        return Err(bad("gpg.format", v));
    }
    Ok(())
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
    fn urls_y_config() {
        assert!(validate_url("https://github.com/a/b.git").is_ok());
        assert!(validate_url("git@github.com:a/b.git").is_ok());
        assert!(validate_url("/tmp/repo").is_ok());
        assert!(validate_url("C:\\repos\\x").is_ok());
        assert!(validate_url("--upload-pack=x").is_err());
        assert!(validate_url("ext::sh -c touch% /tmp/pwn").is_err());
        assert!(validate_url("https://a b").is_err());
        assert!(validate_config_key("user.name").is_ok());
        assert!(validate_config_key("core.editor").is_err());
        assert!(validate_config_key("core.sshCommand").is_err());
        assert!(validate_config_value("gpg.format", "ssh").is_ok());
        assert!(validate_config_value("gpg.format", "x").is_err());
        assert!(validate_date("2 weeks ago").is_ok());
        assert!(validate_date("--x;").is_err());
    }

    #[test]
    fn remotes() {
        assert!(validate_remote("origin").is_ok());
        assert!(validate_remote("--exec").is_err());
        assert!(validate_remote("a/b").is_err());
        assert!(validate_remote("").is_err());
    }
}
