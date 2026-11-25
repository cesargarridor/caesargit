//! Ejecución de `git` del sistema. Sin shell: siempre `Command::new("git").args(..)`.
use crate::error::{AppError, Result};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

static LOCKS: Lazy<StdMutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = Lazy::new(|| StdMutex::new(HashMap::new()));

fn repo_lock(repo: &Path) -> Arc<Mutex<()>> {
    let key = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    let mut g = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

struct Output {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

async fn run(repo: &Path, args: &[&str], envs: &[(&str, &str)], stdin: Option<&[u8]>, read_only: bool) -> Result<Output> {
    let mut cmd = Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    cmd.args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if read_only {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::io(format!("no se pudo ejecutar git: {e}")))?;
    if let Some(data) = stdin {
        if let Some(mut si) = child.stdin.take() {
            // Ignorar BrokenPipe: git puede cerrar stdin antes; el error real sale por su código.
            let _ = si.write_all(data).await;
            drop(si);
        }
    }
    let out = child.wait_with_output().await.map_err(|e| AppError::io(e.to_string()))?;
    Ok(Output {
        ok: out.status.success(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Sustituye la ruta del repo por `<repo>` y trunca a 2000 caracteres.
pub fn sanitize(repo: &Path, text: &str) -> String {
    let mut s = text.to_string();
    let mut variants = vec![repo.to_string_lossy().to_string()];
    if let Ok(c) = std::fs::canonicalize(repo) {
        variants.push(c.to_string_lossy().to_string());
    }
    variants.sort_by_key(|v| std::cmp::Reverse(v.len()));
    for v in variants.iter().filter(|v| v.len() > 1) {
        s = s.replace(v.as_str(), "<repo>");
    }
    let s = s.trim().to_string();
    if s.chars().count() > 2000 {
        s.chars().take(2000).collect::<String>() + "…"
    } else {
        s
    }
}

fn into_result(repo: &Path, o: Output) -> Result<String> {
    if o.ok {
        return Ok(String::from_utf8_lossy(&o.stdout).into_owned());
    }
    let stdout = String::from_utf8_lossy(&o.stdout);
    let msg = if o.stderr.trim().is_empty() { stdout.to_string() } else { o.stderr.clone() };
    let merged = format!("{} {}", stdout, o.stderr);
    let code = if merged.contains("CONFLICT") || merged.contains("Automatic merge failed") || merged.contains("could not apply") {
        "conflict"
    } else if merged.contains("not a git repository") {
        "not_a_repo"
    } else if merged.contains("index.lock") && merged.contains("File exists") {
        "busy"
    } else {
        "git_failed"
    };
    Err(AppError::new(code, sanitize(repo, &msg)))
}

/// Lectura (GIT_OPTIONAL_LOCKS=0, sin mutex). Devuelve stdout como texto.
pub async fn read(repo: &Path, args: &[&str]) -> Result<String> {
    into_result(repo, run(repo, args, &[], None, true).await?)
}

/// Lectura que devuelve stdout en bruto (contenido de archivos, binarios).
pub async fn read_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let o = run(repo, args, &[], None, true).await?;
    if o.ok {
        Ok(o.stdout)
    } else {
        into_result(repo, o).map(|_| Vec::new())
    }
}

/// Lectura con stdin (p. ej. `git apply --check`, sin escribir).
pub async fn read_stdin(repo: &Path, args: &[&str], stdin: &[u8]) -> Result<String> {
    into_result(repo, run(repo, args, &[], Some(stdin), true).await?)
}

/// Escritura serializada por repo.
pub async fn write(repo: &Path, args: &[&str]) -> Result<String> {
    write_full(repo, args, &[], None).await
}

/// Escritura con stdin (git apply --cached, etc.).
pub async fn write_stdin(repo: &Path, args: &[&str], stdin: &[u8]) -> Result<String> {
    write_full(repo, args, &[], Some(stdin)).await
}

/// Escritura con variables de entorno extra (GIT_SEQUENCE_EDITOR, GIT_EDITOR...).
/// Los valores deben construirse en Rust, nunca con datos del usuario.
pub async fn write_env(repo: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String> {
    write_full(repo, args, envs, None).await
}

async fn write_full(repo: &Path, args: &[&str], envs: &[(&str, &str)], stdin: Option<&[u8]>) -> Result<String> {
    let lock = repo_lock(repo);
    let _g = lock.lock().await;
    into_result(repo, run(repo, args, envs, stdin, false).await?)
}

/// Directorio .git absoluto (para detectar operaciones en curso).
pub async fn git_dir(repo: &Path) -> Result<PathBuf> {
    let out = read(repo, &["rev-parse", "--absolute-git-dir"]).await?;
    Ok(PathBuf::from(out.trim_end_matches(['\n', '\r'])))
}
