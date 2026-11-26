//! Ejecución de `git` del sistema. Sin shell: siempre `Command::new("git").args(..)`.
use crate::error::{AppError, Result};
use crate::git::models::ActivityEntry;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex;

static LOCKS: Lazy<StdMutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = Lazy::new(|| StdMutex::new(HashMap::new()));

fn repo_lock(repo: &Path) -> Arc<Mutex<()>> {
    let key = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    let mut g = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// CREATE_NO_WINDOW: ningún proceso hijo abre una consola en Windows.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// CREATE_NEW_CONSOLE: solo para `open_in_terminal` (la intención es una terminal visible).
#[cfg(windows)]
pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

const ACTIVITY_CAP: usize = 500;
static ACTIVITY: Lazy<StdMutex<VecDeque<ActivityEntry>>> = Lazy::new(|| StdMutex::new(VecDeque::new()));
static ACTIVITY_ID: AtomicU64 = AtomicU64::new(1);
/// `esquema://<userinfo>@`: el userinfo completo (usuario, usuario:contraseña o un token usado como
/// usuario, con `@` incluidos en la contraseña) llega hasta la última `@` antes del primer `/`.
static CRED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s]*)@").unwrap());

/// Oculta credenciales embebidas en URLs dentro de `text`. Con `usuario:clave@` se conserva el
/// usuario y se descarta la clave (aunque contenga `@`): `https://u:p@ss@h` -> `https://u@h`.
/// Sin `:` el userinfo puede ser un token usado como usuario: `https://tok@h` -> `https://***@h`.
/// El usuario `git` de ssh (no es un secreto) se conserva.
pub fn mask_credentials(text: &str) -> String {
    CRED_RE
        .replace_all(text, |c: &regex::Captures| {
            match c[2].split_once(':') {
                Some((user, _)) => format!("{}{}@", &c[1], user),
                None if &c[2] == "git" => c[0].to_string(),
                None => format!("{}***@", &c[1]),
            }
        })
        .into_owned()
}

/// Tiempo máximo de un comando git local (generoso: hooks, repos enormes).
const LOCAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Tiempo máximo de un comando git de red (fetch/pull/push/clone...). Muy generoso.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// Sin salida de progreso durante este tiempo, un `run_streaming` se da por colgado.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Límite de stdout en memoria (los blobs grandes ya se limitan antes en cada comando).
const MAX_STDOUT: usize = 1024 * 1024 * 1024;
const MAX_STDERR: usize = 16 * 1024 * 1024;

/// Subcomando git (saltando `-c clave=valor`) para decidir el tiempo máximo.
fn timeout_for(args: &[&str]) -> Duration {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if *a == "-c" || *a == "-C" {
            it.next();
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        return if matches!(*a, "fetch" | "pull" | "push" | "clone" | "ls-remote" | "submodule" | "remote" | "lfs" | "archive") {
            NETWORK_TIMEOUT
        } else {
            LOCAL_TIMEOUT
        };
    }
    LOCAL_TIMEOUT
}

/// Variables del entorno del padre que cambiarían a qué repo/objetos/diff apunta git.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
];

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(r: Option<R>, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    if let Some(r) = r {
        let n = r.take(cap as u64 + 1).read_to_end(&mut out).await?;
        if n > cap {
            return Err(std::io::Error::other("la salida de git es demasiado grande"));
        }
    }
    Ok(out)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Texto de comando apto para el registro de actividad: sin rutas del repo ni credenciales de URLs.
fn describe(repo: &Path, program: &str, args: &[&str]) -> String {
    let mut parts = vec![program.to_string()];
    for a in args {
        let a = mask_credentials(a);
        if a.is_empty() || a.chars().any(char::is_whitespace) {
            parts.push(format!("\"{}\"", a.replace('\n', " ")));
        } else {
            parts.push(a);
        }
    }
    let mut t = sanitize(repo, &parts.join(" "));
    if t.chars().count() > 500 {
        t = t.chars().take(500).collect::<String>() + "…";
    }
    t
}

fn record(repo: &Path, command: String, read_only: bool, ts: i64, started: Instant, ok: bool, error: Option<String>) {
    let entry = ActivityEntry {
        id: ACTIVITY_ID.fetch_add(1, Ordering::Relaxed),
        timestamp_ms: ts,
        repo: repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: if read_only { "read" } else { "write" }.into(),
        command,
        ok,
        duration_ms: started.elapsed().as_millis() as u64,
        error: error.map(|e| e.chars().take(300).collect()),
    };
    let mut g = ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    if g.len() >= ACTIVITY_CAP {
        g.pop_front();
    }
    g.push_back(entry);
}

/// Últimos `limit` comandos ejecutados (más recientes primero).
pub fn activity_log(limit: usize) -> Vec<ActivityEntry> {
    let g = ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    g.iter().rev().take(limit).cloned().collect()
}

struct Output {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

async fn run(repo: &Path, args: &[&str], envs: &[(&str, &str)], stdin: Option<&[u8]>, read_only: bool) -> Result<Output> {
    let (ts, started) = (now_ms(), Instant::now());
    let res = run_inner(repo, args, envs, stdin, read_only).await;
    let command = describe(repo, "git", args);
    match &res {
        Ok(o) => record(repo, command, read_only, ts, started, o.ok, if o.ok { None } else { Some(sanitize(repo, o.stderr.lines().next().unwrap_or(""))) }),
        Err(e) => record(repo, command, read_only, ts, started, false, Some(e.message.clone())),
    }
    res
}

async fn run_inner(repo: &Path, args: &[&str], envs: &[(&str, &str)], stdin: Option<&[u8]>, read_only: bool) -> Result<Output> {
    let mut cmd = Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    // Seguridad: un repo ajeno no debe ejecutar código con solo abrirlo (core.fsmonitor en .git/config),
    // (no se fuerza GIT_LITERAL_PATHSPECS global: `git stash -u` usa pathspec mágico internamente).
    cmd.arg("-c").arg("core.fsmonitor=false");
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
    // Windows: sin esto cada invocación de git abre una ventana de consola. CREATE_NO_WINDOW
    // (0x08000000); los procesos hijos de git (sh, credential helpers, editores) heredan la consola oculta.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    for k in SCRUBBED_ENV {
        cmd.env_remove(k);
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
    let (so, se) = (child.stdout.take(), child.stderr.take());
    let limit = timeout_for(args);
    let work = async {
        let (o, e) = tokio::try_join!(read_capped(so, MAX_STDOUT), read_capped(se, MAX_STDERR))?;
        let st = child.wait().await?;
        Ok::<_, std::io::Error>((o, e, st))
    };
    // Al agotarse el tiempo (o el límite de salida) se suelta `child` y `kill_on_drop` lo mata.
    match tokio::time::timeout(limit, work).await {
        Err(_) => Err(AppError::io(format!("git tardó más de {} minutos y se canceló", limit.as_secs() / 60))),
        Ok(Err(e)) => Err(AppError::io(e.to_string())),
        Ok(Ok((stdout, stderr, st))) => Ok(Output { ok: st.success(), stdout, stderr: String::from_utf8_lossy(&stderr).into_owned() }),
    }
}

/// Sustituye la ruta del repo por `<repo>` y trunca a 2000 caracteres.
pub fn sanitize(repo: &Path, text: &str) -> String {
    let mut s = mask_credentials(text);
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

/// Lectura con variables de entorno extra (p. ej. `GIT_INDEX_FILE` temporal). No toma el mutex.
pub async fn read_env(repo: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String> {
    into_result(repo, run(repo, args, envs, None, true).await?)
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

/// Versión mínima de git recomendada (parches de clonado local/recursivo de 2024).
pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 45, 1);

/// Extrae `(major, minor, patch)` de la salida de `git --version` («git version 2.50.1 (Apple Git-155)»).
pub fn parse_git_version(out: &str) -> Option<(u32, u32, u32)> {
    let v = out.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut it = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

/// Directorio .git absoluto (para detectar operaciones en curso).
pub async fn git_dir(repo: &Path) -> Result<PathBuf> {
    let out = read(repo, &["rev-parse", "--absolute-git-dir"]).await?;
    Ok(PathBuf::from(out.trim_end_matches(['\n', '\r'])))
}

/// Ejecuta git emitiendo cada segmento de stderr (separado por `\r` o `\n`) a `on_line`.
/// Para operaciones con `--progress` (clone). `cwd` debe existir. Sin mutex de repo.
pub async fn run_streaming(cwd: &Path, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<()> {
    let (ts, started) = (now_ms(), Instant::now());
    let mut cmd = Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    // Seguridad: un repo ajeno no debe ejecutar código con solo abrirlo (core.fsmonitor en .git/config),
    // (no se fuerza GIT_LITERAL_PATHSPECS global: `git stash -u` usa pathspec mágico internamente).
    cmd.arg("-c").arg("core.fsmonitor=false");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    for k in SCRUBBED_ENV {
        cmd.env_remove(k);
    }
    let command = describe(cwd, "git", args);
    let mut child = cmd.spawn().map_err(|e| AppError::io(format!("no se pudo ejecutar git: {e}")))?;
    let mut err = child.stderr.take().ok_or_else(|| AppError::io("sin stderr"))?;
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    let mut tail = String::new();
    let mut flush = |seg: &[u8], on_line: &mut dyn FnMut(&str)| {
        let t = String::from_utf8_lossy(seg);
        let t = t.trim();
        if t.is_empty() {
            return;
        }
        on_line(t);
        if !t.contains('%') && tail.len() < 4000 {
            tail.push_str(t);
            tail.push('\n');
        }
    };
    loop {
        // Sin ninguna salida durante `STREAM_IDLE_TIMEOUT` se da por colgado (al salir se mata el proceso).
        let n = tokio::time::timeout(STREAM_IDLE_TIMEOUT, err.read(&mut buf))
            .await
            .map_err(|_| AppError::io("git no dio señales de vida y se canceló"))?
            .map_err(|e| AppError::io(e.to_string()))?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                flush(&pending, &mut on_line);
                pending.clear();
            } else {
                pending.push(b);
            }
        }
    }
    flush(&pending, &mut on_line);
    let status = child.wait().await.map_err(|e| AppError::io(e.to_string()))?;
    record(cwd, command, false, ts, started, status.success(), if status.success() { None } else { Some(sanitize(cwd, &tail)) });
    if status.success() {
        Ok(())
    } else {
        Err(AppError::git_failed(sanitize(cwd, &tail)))
    }
}

/// Lanza un proceso externo sin esperar a su fin (terminal, editor, gestor de archivos, difftool).
/// Sin shell. En Windows usa CREATE_NO_WINDOW salvo `new_console` (terminal visible).
pub fn spawn_detached(program: &str, args: &[&str], cwd: Option<&Path>, new_console: bool) -> Result<()> {
    let _ = new_console;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(if new_console { CREATE_NEW_CONSOLE } else { CREATE_NO_WINDOW });
    }
    let (ts, started) = (now_ms(), Instant::now());
    let base = cwd.unwrap_or_else(|| Path::new(""));
    let command = describe(base, program, args);
    match cmd.spawn() {
        Ok(mut child) => {
            record(base, command, false, ts, started, true, None);
            // Recoge el proceso al terminar para no dejar zombis.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => {
            record(base, command, false, ts, started, false, Some(e.to_string()));
            Err(AppError::io(format!("no se pudo lanzar {program}: {e}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B-05: los comandos de red tienen un límite largo y los locales uno más corto.
    #[test]
    fn b05_timeouts_por_tipo_de_comando() {
        assert_eq!(timeout_for(&["fetch", "--all"]), NETWORK_TIMEOUT);
        assert_eq!(timeout_for(&["-c", "x=y", "push", "origin"]), NETWORK_TIMEOUT);
        assert_eq!(timeout_for(&["clone", "u", "d"]), NETWORK_TIMEOUT);
        assert_eq!(timeout_for(&["status"]), LOCAL_TIMEOUT);
        assert!(LOCAL_TIMEOUT >= Duration::from_secs(600) && NETWORK_TIMEOUT >= Duration::from_secs(3600));
    }

    /// B-05: la salida se acota en memoria.
    #[tokio::test]
    async fn b05_salida_acotada() {
        let data = vec![b'x'; 2048];
        assert_eq!(read_capped(Some(&data[..]), 4096).await.unwrap().len(), 2048);
        assert!(read_capped(Some(&data[..]), 1024).await.is_err());
        assert!(read_capped(None::<&[u8]>, 1024).await.unwrap().is_empty());
    }

    /// B-05: un git colgado se cancela por tiempo (se prueba con la espera interna).
    #[tokio::test]
    async fn b05_timeout_mata_proceso() {
        let mut cmd = Command::new("git");
        cmd.args(["-c", "alias.sleepy=!sleep 30", "sleepy"]).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().unwrap();
        let (so, se) = (child.stdout.take(), child.stderr.take());
        let work = async {
            let _ = tokio::try_join!(read_capped(so, 1024), read_capped(se, 1024))?;
            child.wait().await
        };
        let t = Instant::now();
        assert!(tokio::time::timeout(Duration::from_millis(300), work).await.is_err());
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
