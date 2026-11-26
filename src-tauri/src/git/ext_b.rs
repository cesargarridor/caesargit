//! Comandos extendidos B (reflog, bisect, patches, submódulos, worktrees, LFS, gitflow, hooks,
//! squash/fixup/drop/move, prevención de conflictos, estadísticas). Paquete R2.
//! Todo pasa por `executor` (sin shell, lecturas sin mutex, escrituras serializadas por repo);
//! refs, shas y rutas se validan con `arg_guard` / `path_guard` y las rutas van tras `--`.
use crate::error::{AppError, Result};
use crate::git::executor;
use crate::git::ext_a::tracked;
use crate::security::arg_guard::*;
use crate::security::path_guard;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

async fn root(repo_path: &str) -> Result<PathBuf> {
    path_guard::open_repo_root(repo_path).await
}

/// Ruta del tempdir lista para ir entre comillas simples dentro de `sh` (separadores `/`).
fn sh_path(p: &Path) -> Result<String> {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.contains('\'') || s.contains('\n') || s.contains('\0') {
        return Err(AppError::io("la ruta temporal contiene caracteres no soportados"));
    }
    Ok(s)
}

async fn has_head(root: &Path) -> bool {
    executor::read(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok()
}

async fn branch_exists(root: &Path, name: &str) -> bool {
    validate_ref(name).is_ok()
        && executor::read(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).await.is_ok()
}

/// Ruta absoluta elegida por el usuario fuera del repo (worktrees, parches): absoluta, sin `..`, sin NUL.
fn validate_external_path(p: &str) -> Result<PathBuf> {
    if p.is_empty() || p.contains('\0') || p.len() > 4096 {
        return Err(AppError::invalid_path("ruta vacía o no válida"));
    }
    let path = Path::new(p);
    if !path.is_absolute() {
        return Err(AppError::invalid_path("la ruta debe ser absoluta"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid_path("la ruta contiene '..'"));
    }
    if path.components().any(|c| matches!(c, Component::Normal(n) if n.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err(AppError::invalid_path("la ruta no puede pasar por un directorio .git"));
    }
    Ok(path.to_path_buf())
}

// ================================================================ (1) Reflog

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub sha: String,
    pub selector: String,
    pub action: String,
    pub message: String,
    pub date: String,
}

fn parse_reflog(text: &str) -> Vec<ReflogEntry> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let mut f = line.split('\x1f');
        let (Some(sha), Some(date), Some(subject)) = (f.next(), f.next(), f.next()) else { continue };
        // %gd con --date=iso-strict da `HEAD@{2026-01-01T10:00:00+00:00}`.
        let date = date.split_once("@{").map(|(_, r)| r.trim_end_matches('}')).unwrap_or(date);
        let (action, message) = match subject.split_once(": ") {
            Some((a, m)) => (a.to_string(), m.to_string()),
            None => (subject.to_string(), String::new()),
        };
        out.push(ReflogEntry { sha: sha.to_string(), selector: format!("HEAD@{{{i}}}"), action, message, date: date.to_string() });
    }
    out
}

#[tauri::command]
pub async fn get_reflog(repo_path: String, limit: Option<usize>) -> Result<Vec<ReflogEntry>> {
    let r = root(&repo_path).await?;
    if !has_head(&r).await {
        return Ok(Vec::new());
    }
    let n = limit.unwrap_or(200).clamp(1, 5000).to_string();
    let out = executor::read(
        &r,
        &["reflog", "show", "--date=iso-strict", "--format=%H%x1f%gd%x1f%gs", "-n", &n, "HEAD", "--"],
    )
    .await?;
    Ok(parse_reflog(&out))
}

// ================================================================ (2) Bisect

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    /// Commit actualmente en HEAD (el que hay que probar).
    pub current: Option<String>,
    /// Commits candidatos que quedan por descartar (None si aún no hay «bad»).
    pub remaining: Option<usize>,
    pub log: Vec<String>,
    /// Se rellena cuando bisect ya encontró el primer commit malo.
    pub first_bad: Option<String>,
    /// Última salida de git (p. ej. «Bisecting: 3 revisions left to test…»).
    pub message: String,
}

async fn bisect_state(root: &Path, message: String) -> Result<BisectStatus> {
    let gd = executor::git_dir(root).await?;
    if !gd.join("BISECT_START").exists() {
        return Ok(BisectStatus { message, ..Default::default() });
    }
    let current = executor::read(root, &["rev-parse", "HEAD"]).await.ok().map(|s| s.trim().to_string());
    let log: Vec<String> =
        executor::read(root, &["bisect", "log"]).await.unwrap_or_default().lines().map(str::to_string).collect();
    let first_bad = log.iter().find_map(|l| {
        l.strip_prefix("# first bad commit: [").and_then(|r| r.split(']').next()).map(str::to_string)
    });
    let mut remaining = None;
    if executor::read(root, &["rev-parse", "--verify", "--quiet", "refs/bisect/bad"]).await.is_ok() {
        let goods = executor::read(root, &["for-each-ref", "--format=%(refname)", "refs/bisect/"]).await.unwrap_or_default();
        let good_refs: Vec<&str> = goods.lines().filter(|l| l.starts_with("refs/bisect/good")).collect();
        let mut args = vec!["rev-list", "--count", "refs/bisect/bad"];
        if !good_refs.is_empty() {
            args.push("--not");
            args.extend(good_refs);
        }
        remaining = executor::read(root, &args).await.ok().and_then(|s| s.trim().parse().ok());
    }
    Ok(BisectStatus { active: true, current, remaining, log, first_bad, message })
}

#[tauri::command]
pub async fn bisect_start(repo_path: String, bad: String, good: String) -> Result<BisectStatus> {
    let r = root(&repo_path).await?;
    validate_ref(&bad)?;
    validate_ref(&good)?;
    let out = executor::write(&r, &["bisect", "start", &bad, &good, "--"]).await?;
    bisect_state(&r, out.trim().to_string()).await
}

#[tauri::command]
pub async fn bisect_mark(repo_path: String, kind: String) -> Result<BisectStatus> {
    let r = root(&repo_path).await?;
    if !["good", "bad", "skip"].contains(&kind.as_str()) {
        return Err(AppError::invalid_arg("tipo de bisect no válido (good|bad|skip)"));
    }
    let gd = executor::git_dir(&r).await?;
    if !gd.join("BISECT_START").exists() {
        return Err(AppError::invalid_arg("no hay ninguna bisect en curso"));
    }
    let out = executor::write(&r, &["bisect", kind.as_str()]).await?;
    bisect_state(&r, out.trim().to_string()).await
}

#[tauri::command]
pub async fn bisect_reset(repo_path: String) -> Result<BisectStatus> {
    let r = root(&repo_path).await?;
    let gd = executor::git_dir(&r).await?;
    if gd.join("BISECT_START").exists() {
        executor::write(&r, &["bisect", "reset"]).await?;
    }
    bisect_state(&r, String::new()).await
}

#[tauri::command]
pub async fn bisect_status(repo_path: String) -> Result<BisectStatus> {
    let r = root(&repo_path).await?;
    bisect_state(&r, String::new()).await
}

// ================================================================ (3) Parches

/// Genera parches. Con `wip = true` devuelve el diff de los cambios sin commitear (vs HEAD, binarios incluidos);
/// si no, un `format-patch` por sha (en el orden dado) concatenados.
#[tauri::command]
pub async fn create_patch(repo_path: String, shas: Option<Vec<String>>, wip: Option<bool>) -> Result<String> {
    let r = root(&repo_path).await?;
    let text = if wip.unwrap_or(false) {
        let mut args = vec!["diff", "--binary", "--no-color"];
        if has_head(&r).await {
            args.push("HEAD");
        } else {
            args.push("--cached");
        }
        args.push("--");
        executor::read(&r, &args).await?
    } else {
        let shas = shas.unwrap_or_default();
        if shas.is_empty() {
            return Err(AppError::invalid_arg("no se indicó ningún commit"));
        }
        let mut acc = String::new();
        for s in &shas {
            validate_sha(s)?;
            acc.push_str(&executor::read(&r, &["format-patch", "--stdout", "--no-signature", "-1", s.as_str()]).await?);
        }
        acc
    };
    if text.trim().is_empty() {
        return Err(AppError::invalid_arg("no hay nada que incluir en el parche"));
    }
    Ok(text)
}

/// Guarda un parche en la ruta elegida por el usuario en el diálogo de guardado (puede estar fuera del repo).
#[tauri::command]
pub async fn save_patch(path: String, content: String) -> Result<()> {
    let p = validate_external_path(&path)?;
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ext != "patch" && ext != "diff" {
        return Err(AppError::invalid_path("el archivo debe tener extensión .patch o .diff"));
    }
    if content.len() > 200 * 1024 * 1024 {
        return Err(AppError::invalid_arg("el parche es demasiado grande"));
    }
    let parent = p.parent().ok_or_else(|| AppError::invalid_path("ruta no válida"))?;
    if !parent.is_dir() {
        return Err(AppError::invalid_path("la carpeta de destino no existe"));
    }
    if let Ok(m) = std::fs::symlink_metadata(&p) {
        if m.file_type().is_symlink() || m.is_dir() {
            return Err(AppError::invalid_path("el destino no es un archivo normal"));
        }
    }
    tokio::fs::write(&p, content).await?;
    Ok(())
}

/// Aplica un parche (con `check` solo lo comprueba; con `index` también lo añade al área de preparación).
#[tauri::command]
pub async fn apply_patch(repo_path: String, patch: String, check: bool, index: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Aplicar parche", async {
        if patch.trim().is_empty() {
            return Err(AppError::invalid_arg("el parche está vacío"));
        }
        let mut args = vec!["apply", "--whitespace=nowarn"];
        if index {
            args.push("--index");
        }
        if check {
            args.push("--check");
            args.push("-");
            executor::read_stdin(&r, &args, patch.as_bytes()).await?;
        } else {
            args.push("-");
            executor::write_stdin(&r, &args, patch.as_bytes()).await?;
        }
        Ok(())
    }).await
}

// ================================================================ (4) Submódulos

static SCP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._-]*:[^\s]+$").unwrap());
static DRIVE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());

/// Solo https://, ssh://, git@host:, file:// y rutas locales. Bloquea `ext::`, `--upload-pack`, hosts que empiezan por `-`.
fn validate_git_url(u: &str) -> Result<&str> {
    let bad = || AppError::invalid_arg("URL no válida: solo https://, ssh://, git@host:ruta, file:// o rutas locales");
    if u.is_empty() || u.len() > 2048 || u.starts_with('-') || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    let lower = u.to_ascii_lowercase();
    if lower.contains("::") || lower.contains("--upload-pack") || lower.contains("--exec") {
        return Err(bad());
    }
    let authority_ok = |rest: &str| {
        let auth = rest.split('/').next().unwrap_or("");
        !auth.is_empty() && !auth.starts_with('-') && !auth.contains("@-")
    };
    if let Some(rest) = lower.strip_prefix("https://").map(|_| &u[8..]) {
        return if authority_ok(rest) { Ok(u) } else { Err(bad()) };
    }
    if lower.starts_with("ssh://") {
        return if authority_ok(&u[6..]) { Ok(u) } else { Err(bad()) };
    }
    if lower.starts_with("file://") {
        let rest = &u[7..];
        return if !rest.is_empty() && !rest.starts_with('-') { Ok(u) } else { Err(bad()) };
    }
    if SCP_RE.is_match(u) && !u.split_once(':').map(|(_, p)| p.starts_with('-')).unwrap_or(false) {
        return Ok(u);
    }
    if Path::new(u).is_absolute() || u.starts_with("./") || u.starts_with("../") || DRIVE_RE.is_match(u) {
        return Ok(u);
    }
    Err(bad())
}

fn is_local_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    !(l.starts_with("https://") || l.starts_with("ssh://") || SCP_RE.is_match(u))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub name: String,
    pub path: String,
    pub url: String,
    pub branch: Option<String>,
    pub sha: String,
    /// ok | uninitialized | modified | conflict
    pub status: String,
}

async fn read_submodules(root: &Path) -> Result<Vec<Submodule>> {
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let cfg = executor::read(root, &["config", "-f", ".gitmodules", "-z", "--list"]).await?;
    let mut subs: Vec<Submodule> = Vec::new();
    for item in cfg.split('\0').filter(|s| !s.is_empty()) {
        let Some((key, val)) = item.split_once('\n') else { continue };
        let Some(rest) = key.strip_prefix("submodule.") else { continue };
        let Some((name, var)) = rest.rsplit_once('.') else { continue };
        let idx = match subs.iter().position(|s| s.name == name) {
            Some(i) => i,
            None => {
                subs.push(Submodule {
                    name: name.to_string(),
                    path: String::new(),
                    url: String::new(),
                    branch: None,
                    sha: String::new(),
                    status: "uninitialized".into(),
                });
                subs.len() - 1
            }
        };
        match var {
            "path" => subs[idx].path = val.to_string(),
            "url" => subs[idx].url = val.to_string(),
            "branch" => subs[idx].branch = Some(val.to_string()),
            _ => {}
        }
    }
    subs.retain(|s| !s.path.is_empty());
    let st = executor::read(root, &["submodule", "status"]).await.unwrap_or_default();
    for line in st.lines() {
        let mut ch = line.chars();
        let Some(flag) = ch.next() else { continue };
        let rest = ch.as_str();
        let Some((sha, tail)) = rest.split_once(' ') else { continue };
        let path = match tail.rfind(" (") {
            Some(i) if tail.ends_with(')') => &tail[..i],
            _ => tail,
        };
        if let Some(s) = subs.iter_mut().find(|s| s.path == path) {
            s.sha = sha.to_string();
            s.status = match flag {
                '-' => "uninitialized",
                '+' => "modified",
                'U' => "conflict",
                _ => "ok",
            }
            .into();
        }
    }
    Ok(subs)
}

#[tauri::command]
pub async fn list_submodules(repo_path: String) -> Result<Vec<Submodule>> {
    let r = root(&repo_path).await?;
    read_submodules(&r).await
}

#[tauri::command]
pub async fn submodule_add(repo_path: String, url: String, path: String, branch: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Añadir submódulo", async {
        validate_git_url(&url)?;
        let rel = path_guard::safe_rel(&r, &path)?;
        let mut args: Vec<&str> = vec!["-c", "protocol.ext.allow=never"];
        // Git bloquea file:// en submódulos por defecto; aquí la URL la ha escrito el usuario a propósito.
        if is_local_url(&url) {
            args.extend(["-c", "protocol.file.allow=always"]);
        }
        args.extend(["submodule", "add"]);
        if let Some(b) = branch.as_deref().filter(|b| !b.is_empty()) {
            validate_branch_name(b)?;
            args.extend(["-b", b]);
        }
        args.extend(["--", url.as_str(), rel.as_str()]);
        executor::write(&r, &args).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn submodule_init(repo_path: String, path: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Inicializar submódulos", async {
        let mut args: Vec<&str> = vec!["submodule", "init"];
        let rel;
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            rel = path_guard::safe_rel(&r, &p)?;
            args.extend(["--", rel.as_str()]);
        }
        executor::write(&r, &args).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn submodule_update(repo_path: String, recursive: bool, remote: bool, path: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Actualizar submódulos", async {
        let mut args: Vec<&str> = vec!["-c", "protocol.ext.allow=never", "submodule", "update", "--init"];
        if recursive {
            args.push("--recursive");
        }
        if remote {
            args.push("--remote");
        }
        let rel;
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            rel = path_guard::safe_rel(&r, &p)?;
            args.extend(["--", rel.as_str()]);
        }
        executor::write(&r, &args).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn submodule_sync(repo_path: String, recursive: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    let mut args = vec!["submodule", "sync"];
    if recursive {
        args.push("--recursive");
    }
    executor::write(&r, &args).await?;
    Ok(())
}

/// deinit + `git rm` (limpia .gitmodules) + borra `.git/modules/<name>`.
#[tauri::command]
pub async fn submodule_remove(repo_path: String, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Eliminar submódulo", async {
        let rel = path_guard::safe_rel(&r, &path)?;
        let subs = read_submodules(&r).await?;
        let sub = subs
            .into_iter()
            .find(|s| s.path == rel)
            .ok_or_else(|| AppError::invalid_arg("esa ruta no es un submódulo"))?;
        executor::write(&r, &["submodule", "deinit", "-f", "--", rel.as_str()]).await?;
        executor::write(&r, &["rm", "-f", "--", rel.as_str()]).await?;
        // Por si `git rm` dejó la sección en .gitmodules.
        let section = format!("submodule.{}", sub.name);
        if r.join(".gitmodules").is_file()
            && executor::read(&r, &["config", "-f", ".gitmodules", "--get-regexp", &format!("^{}\\.", regex::escape(&section))])
                .await
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            executor::write(&r, &["config", "-f", ".gitmodules", "--remove-section", section.as_str()]).await?;
            executor::write(&r, &["add", "--", ".gitmodules"]).await?;
        }
        let gd = executor::git_dir(&r).await?;
        let safe_name = !sub.name.is_empty()
            && Path::new(&sub.name).components().all(|c| matches!(c, Component::Normal(_)));
        if safe_name {
            let moddir = gd.join("modules").join(&sub.name);
            if moddir.is_dir() && moddir.starts_with(gd.join("modules")) {
                tokio::fs::remove_dir_all(&moddir).await?;
            }
        }
        Ok(())
    }).await
}

// ================================================================ (5) Worktrees

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub sha: String,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub is_main: bool,
    pub detached: bool,
}

fn parse_worktrees(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(p) = line.strip_prefix("worktree ") {
            out.push(Worktree { path: p.to_string(), is_main: out.is_empty(), ..Default::default() });
            continue;
        }
        let Some(w) = out.last_mut() else { continue };
        if let Some(s) = line.strip_prefix("HEAD ") {
            w.sha = s.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "detached" {
            w.detached = true;
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
            w.lock_reason = line.strip_prefix("locked ").map(str::to_string);
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
        }
    }
    out
}

async fn read_worktrees(root: &Path) -> Result<Vec<Worktree>> {
    Ok(parse_worktrees(&executor::read(root, &["worktree", "list", "--porcelain"]).await?))
}

fn same_path(a: &str, b: &str) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    ca == cb
}

async fn find_worktree(root: &Path, path: &str) -> Result<Worktree> {
    read_worktrees(root)
        .await?
        .into_iter()
        .find(|w| same_path(&w.path, path))
        .ok_or_else(|| AppError::invalid_arg("esa ruta no es un worktree de este repositorio"))
}

#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>> {
    let r = root(&repo_path).await?;
    read_worktrees(&r).await
}

/// `new_branch = true` crea `branch` (desde `start_point` o HEAD); si no, saca la rama existente.
#[tauri::command]
pub async fn add_worktree(repo_path: String, path: String, branch: String, new_branch: bool, start_point: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Añadir worktree", async {
        let p = validate_external_path(&path)?;
        let ps = p.to_string_lossy().into_owned();
        if new_branch {
            validate_branch_name(&branch)?;
            let mut args = vec!["worktree", "add", "-b", branch.as_str(), "--", ps.as_str()];
            if let Some(sp) = start_point.as_deref().filter(|s| !s.is_empty()) {
                validate_ref(sp)?;
                args.push(sp);
            }
            executor::write(&r, &args).await?;
        } else {
            validate_ref(&branch)?;
            executor::write(&r, &["worktree", "add", "--", ps.as_str(), branch.as_str()]).await?;
        }
        Ok(())
    }).await
}

#[tauri::command]
pub async fn lock_worktree(repo_path: String, path: String, reason: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let w = find_worktree(&r, &path).await?;
    if w.is_main {
        return Err(AppError::invalid_arg("no se puede bloquear el worktree principal"));
    }
    let mut args = vec!["worktree", "lock"];
    if let Some(re) = reason.as_deref().filter(|s| !s.trim().is_empty()) {
        args.extend(["--reason", re]);
    }
    args.extend(["--", w.path.as_str()]);
    executor::write(&r, &args).await?;
    Ok(())
}

#[tauri::command]
pub async fn unlock_worktree(repo_path: String, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let w = find_worktree(&r, &path).await?;
    executor::write(&r, &["worktree", "unlock", "--", w.path.as_str()]).await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_worktree(repo_path: String, path: String, force: bool, delete_branch: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Eliminar worktree", async {
        let w = find_worktree(&r, &path).await?;
        if w.is_main {
            return Err(AppError::invalid_arg("no se puede eliminar el worktree principal"));
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.extend(["--force", "--force"]);
        }
        args.extend(["--", w.path.as_str()]);
        executor::write(&r, &args).await?;
        if delete_branch {
            if let Some(b) = w.branch.as_deref() {
                validate_ref(b)?;
                executor::write(&r, &["branch", if force { "-D" } else { "-d" }, "--", b]).await?;
            }
        }
        Ok(())
    }).await
}

/// Devuelve cuántos worktrees obsoletos había antes de podar.
#[tauri::command]
pub async fn prune_worktrees(repo_path: String) -> Result<usize> {
    let r = root(&repo_path).await?;
    let n = read_worktrees(&r).await?.iter().filter(|w| w.prunable).count();
    executor::write(&r, &["worktree", "prune"]).await?;
    Ok(n)
}

// ================================================================ (6) Git LFS

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsPattern {
    pub pattern: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub path: String,
    pub oid: String,
    /// true = el objeto real está descargado; false = solo el puntero.
    pub downloaded: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    pub installed: bool,
    pub version: String,
    pub patterns: Vec<LfsPattern>,
    pub files: Vec<LfsFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsLock {
    pub id: String,
    pub path: String,
    pub owner: String,
    pub locked_at: String,
}

async fn lfs_version(root: &Path) -> Option<String> {
    executor::read(root, &["lfs", "version"]).await.ok().map(|s| s.trim().to_string())
}

async fn require_lfs(root: &Path) -> Result<()> {
    if lfs_version(root).await.is_none() {
        return Err(AppError::git_failed(
            "Git LFS no está instalado. Instálalo (https://git-lfs.com; brew install git-lfs / winget install GitHub.GitLFS / apt install git-lfs) y reinicia CaesarGit.",
        ));
    }
    Ok(())
}

fn parse_lfs_patterns(text: &str) -> Vec<LfsPattern> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with("Listing tracked patterns") {
            inside = true;
            continue;
        }
        if line.starts_with("Listing excluded patterns") {
            break;
        }
        if !inside || !line.starts_with(char::is_whitespace) || line.trim().is_empty() {
            continue;
        }
        let t = line.trim();
        match t.rfind(" (") {
            Some(i) if t.ends_with(')') => {
                out.push(LfsPattern { pattern: t[..i].to_string(), source: t[i + 2..t.len() - 1].to_string() })
            }
            _ => out.push(LfsPattern { pattern: t.to_string(), source: String::new() }),
        }
    }
    out
}

fn parse_lfs_files(text: &str) -> Vec<LfsFile> {
    text.lines()
        .filter_map(|l| {
            let (oid, rest) = l.split_once(' ')?;
            let flag = rest.chars().next()?;
            let path = rest.get(2..)?;
            Some(LfsFile { path: path.to_string(), oid: oid.to_string(), downloaded: flag == '*' })
        })
        .collect()
}

fn validate_lfs_pattern(p: &str) -> Result<&str> {
    if p.is_empty()
        || p.len() > 500
        || p.starts_with('-')
        || p.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
        || p.split('/').any(|s| s == "..")
    {
        return Err(AppError::invalid_arg("patrón LFS no válido"));
    }
    Ok(p)
}

#[tauri::command]
pub async fn lfs_status(repo_path: String) -> Result<LfsStatus> {
    let r = root(&repo_path).await?;
    let Some(version) = lfs_version(&r).await else { return Ok(LfsStatus::default()) };
    let patterns = parse_lfs_patterns(&executor::read(&r, &["lfs", "track"]).await.unwrap_or_default());
    let files = if has_head(&r).await { parse_lfs_files(&executor::read(&r, &["lfs", "ls-files"]).await.unwrap_or_default()) } else { Vec::new() };
    Ok(LfsStatus { installed: true, version, patterns, files })
}

#[tauri::command]
pub async fn lfs_install(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    executor::write(&r, &["lfs", "install", "--local"]).await
}

#[tauri::command]
pub async fn lfs_track(repo_path: String, pattern: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "LFS: track", async {
        require_lfs(&r).await?;
        validate_lfs_pattern(&pattern)?;
        executor::write(&r, &["lfs", "track", "--", pattern.as_str()]).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn lfs_untrack(repo_path: String, pattern: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "LFS: untrack", async {
        require_lfs(&r).await?;
        validate_lfs_pattern(&pattern)?;
        executor::write(&r, &["lfs", "untrack", "--", pattern.as_str()]).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn lfs_pull(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    executor::write(&r, &["lfs", "pull"]).await
}

#[tauri::command]
pub async fn lfs_fetch(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    executor::write(&r, &["lfs", "fetch"]).await
}

#[tauri::command]
pub async fn lfs_prune(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    executor::write(&r, &["lfs", "prune"]).await
}

#[derive(Deserialize)]
struct RawLock {
    #[serde(default)]
    id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    owner: Option<RawOwner>,
    #[serde(default)]
    locked_at: String,
}
#[derive(Deserialize)]
struct RawOwner {
    #[serde(default)]
    name: String,
}

#[tauri::command]
pub async fn lfs_locks(repo_path: String) -> Result<Vec<LfsLock>> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    let out = executor::read(&r, &["lfs", "locks", "--json"]).await?;
    if out.trim().is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawLock> = serde_json::from_str(out.trim()).map_err(|e| AppError::git_failed(format!("respuesta de git lfs locks no válida: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|l| LfsLock { id: l.id, path: l.path, owner: l.owner.map(|o| o.name).unwrap_or_default(), locked_at: l.locked_at })
        .collect())
}

#[tauri::command]
pub async fn lfs_lock(repo_path: String, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    executor::write(&r, &["lfs", "lock", "--", rel.as_str()]).await?;
    Ok(())
}

#[tauri::command]
pub async fn lfs_unlock(repo_path: String, path: String, force: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    require_lfs(&r).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let mut args = vec!["lfs", "unlock"];
    if force {
        args.push("--force");
    }
    args.extend(["--", rel.as_str()]);
    executor::write(&r, &args).await?;
    Ok(())
}

// ================================================================ (7) Gitflow

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowConfig {
    #[serde(default)]
    pub initialized: bool,
    pub master: String,
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    pub support: String,
    pub version_tag: String,
}

impl Default for FlowConfig {
    fn default() -> Self {
        Self {
            initialized: false,
            master: "master".into(),
            develop: "develop".into(),
            feature: "feature/".into(),
            release: "release/".into(),
            hotfix: "hotfix/".into(),
            support: "support/".into(),
            version_tag: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFinishOpts {
    pub keep_branch: bool,
    pub squash: bool,
    pub no_ff: bool,
    pub tag: bool,
    pub tag_message: Option<String>,
    pub push: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatus {
    pub initialized: bool,
    pub config: FlowConfig,
    pub feature: Vec<String>,
    pub release: Vec<String>,
    pub hotfix: Vec<String>,
    pub support: Vec<String>,
    /// Rama actual si pertenece a algún tipo: {kind, name}.
    pub current: Option<FlowCurrent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCurrent {
    pub kind: String,
    pub name: String,
}

async fn cfg_get(root: &Path, key: &str) -> Option<String> {
    executor::read(root, &["config", "--local", "--get", key]).await.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

async fn load_flow(root: &Path) -> Result<FlowConfig> {
    let d = FlowConfig::default();
    let master = cfg_get(root, "gitflow.branch.master").await;
    let develop = cfg_get(root, "gitflow.branch.develop").await;
    Ok(FlowConfig {
        initialized: master.is_some() && develop.is_some(),
        master: master.unwrap_or(d.master),
        develop: develop.unwrap_or(d.develop),
        feature: cfg_get(root, "gitflow.prefix.feature").await.unwrap_or(d.feature),
        release: cfg_get(root, "gitflow.prefix.release").await.unwrap_or(d.release),
        hotfix: cfg_get(root, "gitflow.prefix.hotfix").await.unwrap_or(d.hotfix),
        support: cfg_get(root, "gitflow.prefix.support").await.unwrap_or(d.support),
        version_tag: cfg_get(root, "gitflow.prefix.versiontag").await.unwrap_or(d.version_tag),
    })
}

async fn require_flow(root: &Path) -> Result<FlowConfig> {
    let c = load_flow(root).await?;
    if !c.initialized {
        return Err(AppError::invalid_arg("Gitflow no está inicializado en este repositorio"));
    }
    Ok(c)
}

fn flow_prefix<'a>(c: &'a FlowConfig, kind: &str) -> Result<&'a str> {
    match kind {
        "feature" => Ok(&c.feature),
        "release" => Ok(&c.release),
        "hotfix" => Ok(&c.hotfix),
        "support" => Ok(&c.support),
        _ => Err(AppError::invalid_arg("tipo de gitflow no válido (feature|release|hotfix|support)")),
    }
}

fn check_prefix(p: &str) -> Result<()> {
    if p.is_empty() {
        return Err(AppError::invalid_arg("el prefijo no puede estar vacío"));
    }
    validate_branch_name(&format!("{p}x"))?;
    Ok(())
}

#[tauri::command]
pub async fn flow_get_config(repo_path: String) -> Result<FlowConfig> {
    let r = root(&repo_path).await?;
    load_flow(&r).await
}

#[tauri::command]
pub async fn flow_init(repo_path: String, config: FlowConfig) -> Result<FlowConfig> {
    let r = root(&repo_path).await?;
    validate_branch_name(&config.master)?;
    validate_branch_name(&config.develop)?;
    if config.master == config.develop {
        return Err(AppError::invalid_arg("las ramas master y develop deben ser distintas"));
    }
    for p in [&config.feature, &config.release, &config.hotfix, &config.support] {
        check_prefix(p)?;
    }
    if !config.version_tag.is_empty() {
        validate_branch_name(&format!("{}1", config.version_tag))?;
    }
    if !branch_exists(&r, &config.master).await {
        return Err(AppError::invalid_arg(format!("la rama «{}» no existe; crea el primer commit antes", config.master)));
    }
    if !branch_exists(&r, &config.develop).await {
        executor::write(&r, &["branch", config.develop.as_str(), config.master.as_str()]).await?;
    }
    let pairs = [
        ("gitflow.branch.master", &config.master),
        ("gitflow.branch.develop", &config.develop),
        ("gitflow.prefix.feature", &config.feature),
        ("gitflow.prefix.release", &config.release),
        ("gitflow.prefix.hotfix", &config.hotfix),
        ("gitflow.prefix.support", &config.support),
        ("gitflow.prefix.versiontag", &config.version_tag),
    ];
    for (k, v) in pairs {
        executor::write(&r, &["config", "--local", k, v.as_str()]).await?;
    }
    load_flow(&r).await
}

#[tauri::command]
pub async fn flow_start(repo_path: String, kind: String, name: String) -> Result<String> {
    let r = root(&repo_path).await?;
    tracked(&r, "Flow: iniciar", async {
        let c = require_flow(&r).await?;
        let prefix = flow_prefix(&c, &kind)?;
        validate_branch_name(&name)?;
        let branch = format!("{prefix}{name}");
        validate_branch_name(&branch)?;
        if branch_exists(&r, &branch).await {
            return Err(AppError::invalid_arg(format!("la rama «{branch}» ya existe")));
        }
        let base = if kind == "feature" || kind == "release" { &c.develop } else { &c.master };
        if !branch_exists(&r, base).await {
            return Err(AppError::invalid_arg(format!("la rama base «{base}» no existe")));
        }
        executor::write(&r, &["checkout", "-b", branch.as_str(), base.as_str()]).await?;
        Ok(branch)
    }).await
}

async fn flow_merge(root: &Path, branch: &str, kind: &str, name: &str, no_ff: bool, squash: bool) -> Result<()> {
    let msg = format!("Merge {kind} '{name}'");
    if squash {
        executor::write(root, &["merge", "--squash", branch]).await?;
        executor::write(root, &["commit", "-m", msg.as_str()]).await?;
    } else {
        let ff = if no_ff { "--no-ff" } else { "--ff" };
        executor::write(root, &["merge", ff, "-m", msg.as_str(), branch]).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn flow_finish(repo_path: String, kind: String, name: String, opts: Option<FlowFinishOpts>) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Flow: finalizar", async {
        let o = opts.unwrap_or_default();
        let c = require_flow(&r).await?;
        let prefix = flow_prefix(&c, &kind)?.to_string();
        validate_branch_name(&name)?;
        let branch = format!("{prefix}{name}");
        if !branch_exists(&r, &branch).await {
            return Err(AppError::invalid_arg(format!("la rama «{branch}» no existe")));
        }
        let mut pushed: Vec<String> = Vec::new();
        let mut tag_name: Option<String> = None;
        match kind.as_str() {
            "feature" => {
                executor::write(&r, &["checkout", c.develop.as_str()]).await?;
                flow_merge(&r, &branch, &kind, &name, o.no_ff, o.squash).await?;
                pushed.push(c.develop.clone());
            }
            "release" | "hotfix" => {
                executor::write(&r, &["checkout", c.master.as_str()]).await?;
                flow_merge(&r, &branch, &kind, &name, true, o.squash).await?;
                if o.tag {
                    let t = format!("{}{}", c.version_tag, name);
                    validate_branch_name(&t)?;
                    let m = o.tag_message.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string).unwrap_or_else(|| format!("{} {}", kind, name));
                    executor::write(&r, &["tag", "-a", "-m", m.as_str(), t.as_str()]).await?;
                    tag_name = Some(t);
                }
                executor::write(&r, &["checkout", c.develop.as_str()]).await?;
                flow_merge(&r, &branch, &kind, &name, true, o.squash).await?;
                pushed.push(c.master.clone());
                pushed.push(c.develop.clone());
            }
            _ => return Err(AppError::invalid_arg("las ramas support no se finalizan")),
        }
        if !o.keep_branch {
            executor::write(&r, &["branch", if o.squash { "-D" } else { "-d" }, "--", branch.as_str()]).await?;
        }
        if o.push {
            let remotes = executor::read(&r, &["remote"]).await?;
            if !remotes.lines().any(|l| l.trim() == "origin") {
                return Err(AppError::invalid_arg("no hay remoto «origin» al que enviar"));
            }
            let mut args: Vec<&str> = vec!["push", "origin"];
            args.extend(pushed.iter().map(String::as_str));
            executor::write(&r, &args).await?;
            if let Some(t) = &tag_name {
                executor::write(&r, &["push", "origin", &format!("refs/tags/{t}")]).await?;
            }
        }
        Ok(())
    }).await
}

#[tauri::command]
pub async fn flow_status(repo_path: String) -> Result<FlowStatus> {
    let r = root(&repo_path).await?;
    let config = load_flow(&r).await?;
    let mut st = FlowStatus { initialized: config.initialized, config: config.clone(), ..Default::default() };
    if !has_head(&r).await {
        return Ok(st);
    }
    let heads = executor::read(&r, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).await?;
    let cur = executor::read(&r, &["branch", "--show-current"]).await.unwrap_or_default().trim().to_string();
    for b in heads.lines() {
        for (kind, prefix, list) in [
            ("feature", &config.feature, &mut st.feature),
            ("release", &config.release, &mut st.release),
            ("hotfix", &config.hotfix, &mut st.hotfix),
            ("support", &config.support, &mut st.support),
        ] {
            if let Some(n) = b.strip_prefix(prefix.as_str()).filter(|n| !n.is_empty()) {
                list.push(n.to_string());
                if b == cur {
                    st.current = Some(FlowCurrent { kind: kind.into(), name: n.to_string() });
                }
            }
        }
    }
    Ok(st)
}

// ================================================================ (8) Hooks

const HOOK_NAMES: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-auto-gc",
    "post-rewrite",
    "post-update",
    "push-to-checkout",
    "reference-transaction",
    "fsmonitor-watchman",
    "sendemail-validate",
    "pre-receive",
    "update",
    "post-receive",
    "proc-receive",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub name: String,
    /// Existe un hook real (activo o desactivado).
    pub exists: bool,
    /// Existe y es ejecutable.
    pub active: bool,
    /// Solo existe el ejemplo `.sample` de git.
    pub is_sample: bool,
    /// Existe como `<nombre>.disabled`.
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTemplate {
    pub name: String,
    pub title: String,
    pub description: String,
    pub content: String,
}

fn check_hook_name(name: &str) -> Result<&str> {
    if HOOK_NAMES.contains(&name) {
        Ok(name)
    } else {
        Err(AppError::invalid_arg("nombre de hook no permitido"))
    }
}

async fn hooks_dir(root: &Path) -> Result<PathBuf> {
    let out = executor::read(root, &["rev-parse", "--git-path", "hooks"]).await?;
    let p = PathBuf::from(out.trim_end_matches(['\n', '\r']));
    Ok(if p.is_absolute() { p } else { root.join(p) })
}

fn is_exec(p: &Path) -> bool {
    let Ok(m) = std::fs::metadata(p) else { return false };
    if !m.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn make_exec(p: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = p;
    Ok(())
}

fn suffixed(dir: &Path, name: &str, suffix: &str) -> PathBuf {
    dir.join(format!("{name}{suffix}"))
}

#[tauri::command]
pub async fn list_hooks(repo_path: String) -> Result<Vec<HookInfo>> {
    let r = root(&repo_path).await?;
    let dir = hooks_dir(&r).await?;
    Ok(HOOK_NAMES
        .iter()
        .map(|n| {
            let real = dir.join(n);
            let real_exists = real.is_file();
            let disabled = suffixed(&dir, n, ".disabled").is_file();
            HookInfo {
                name: (*n).to_string(),
                exists: real_exists || disabled,
                active: is_exec(&real),
                is_sample: !real_exists && !disabled && suffixed(&dir, n, ".sample").is_file(),
                disabled,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn read_hook(repo_path: String, name: String) -> Result<String> {
    let r = root(&repo_path).await?;
    check_hook_name(&name)?;
    let dir = hooks_dir(&r).await?;
    for suf in ["", ".disabled", ".sample"] {
        let p = suffixed(&dir, &name, suf);
        if p.is_file() {
            return Ok(String::from_utf8_lossy(&tokio::fs::read(&p).await?).into_owned());
        }
    }
    Err(AppError::invalid_arg("el hook no existe"))
}

/// Escribe el hook (fin de línea LF, chmod +x en unix). Si estaba desactivado se mantiene desactivado.
#[tauri::command]
pub async fn write_hook(repo_path: String, name: String, content: String) -> Result<()> {
    let r = root(&repo_path).await?;
    check_hook_name(&name)?;
    if content.len() > 1024 * 1024 {
        return Err(AppError::invalid_arg("el hook es demasiado grande"));
    }
    let dir = hooks_dir(&r).await?;
    tokio::fs::create_dir_all(&dir).await?;
    let real = dir.join(&name);
    let dis = suffixed(&dir, &name, ".disabled");
    let target = if !real.exists() && dis.is_file() { dis } else { real };
    tokio::fs::write(&target, content.replace("\r\n", "\n")).await?;
    make_exec(&target)?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_hook(repo_path: String, name: String, enabled: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    check_hook_name(&name)?;
    let dir = hooks_dir(&r).await?;
    let real = dir.join(&name);
    let dis = suffixed(&dir, &name, ".disabled");
    let sample = suffixed(&dir, &name, ".sample");
    if enabled {
        if real.is_file() {
            make_exec(&real)?;
        } else if dis.is_file() {
            tokio::fs::rename(&dis, &real).await?;
            make_exec(&real)?;
        } else if sample.is_file() {
            tokio::fs::copy(&sample, &real).await?;
            make_exec(&real)?;
        } else {
            return Err(AppError::invalid_arg("el hook no existe"));
        }
    } else if real.is_file() {
        if dis.exists() {
            tokio::fs::remove_file(&dis).await?;
        }
        tokio::fs::rename(&real, &dis).await?;
    } else if !dis.is_file() {
        return Err(AppError::invalid_arg("el hook no existe"));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_hook(repo_path: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    check_hook_name(&name)?;
    let dir = hooks_dir(&r).await?;
    let mut any = false;
    for suf in ["", ".disabled"] {
        let p = suffixed(&dir, &name, suf);
        if p.is_file() {
            tokio::fs::remove_file(&p).await?;
            any = true;
        }
    }
    if !any {
        return Err(AppError::invalid_arg("el hook no existe"));
    }
    Ok(())
}

#[tauri::command]
pub async fn hook_templates() -> Result<Vec<HookTemplate>> {
    let t = |name: &str, title: &str, description: &str, content: &str| HookTemplate {
        name: name.into(),
        title: title.into(),
        description: description.into(),
        content: content.into(),
    };
    Ok(vec![
        t(
            "pre-commit",
            "Bloquear marcadores de conflicto y espacios finales",
            "Rechaza el commit si hay marcadores <<<<<<< o espacios al final de línea en lo preparado.",
            "#!/bin/sh\n# pre-commit: evita commitear marcadores de conflicto o espacios finales\nif git diff --cached --check; then\n  exit 0\nfi\necho \"pre-commit: corrige los problemas indicados antes de commitear\" >&2\nexit 1\n",
        ),
        t(
            "commit-msg",
            "Exigir Conventional Commits",
            "El mensaje debe empezar por feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert.",
            "#!/bin/sh\n# commit-msg: valida el formato «tipo(ámbito): descripción»\nfirst=$(head -n 1 \"$1\")\ncase \"$first\" in\n  Merge*|Revert*|fixup!*|squash!*) exit 0 ;;\nesac\nif echo \"$first\" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?!?: .+'; then\n  exit 0\nfi\necho \"commit-msg: usa el formato 'tipo(ámbito): descripción' (feat, fix, docs, ...)\" >&2\nexit 1\n",
        ),
        t(
            "pre-push",
            "Impedir push directo a main/master",
            "Aborta el push si apunta a la rama main o master del remoto.",
            "#!/bin/sh\n# pre-push: protege main y master\nwhile read local_ref local_sha remote_ref remote_sha; do\n  case \"$remote_ref\" in\n    refs/heads/main|refs/heads/master)\n      echo \"pre-push: push directo a ${remote_ref#refs/heads/} bloqueado\" >&2\n      exit 1 ;;\n  esac\ndone\nexit 0\n",
        ),
    ])
}

// ================================================================ (9) Squash / fixup / drop / move

async fn resolve_commit(root: &Path, sha: &str) -> Result<String> {
    validate_sha(sha)?;
    let out = executor::read(root, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")])
        .await
        .map_err(|_| AppError::invalid_arg("el commit no existe"))?;
    Ok(out.trim().to_string())
}

/// Padre del commit (None si es raíz).
async fn parent_of(root: &Path, full: &str) -> Option<String> {
    executor::read(root, &["rev-parse", "--verify", "--quiet", &format!("{full}^")]).await.ok().map(|s| s.trim().to_string())
}

/// Commits desde `base` (exclusive; None = raíz) hasta HEAD, del más antiguo al más nuevo. Exige historia lineal.
async fn linear_range(root: &Path, base: Option<&str>) -> Result<Vec<String>> {
    let spec = base.map(|b| format!("{b}..HEAD"));
    let mut args = vec!["rev-list", "--reverse", "--topo-order"];
    let mut merges = vec!["rev-list", "--merges", "--count"];
    match spec.as_deref() {
        Some(s) => {
            args.push(s);
            merges.push(s);
        }
        None => {
            args.push("HEAD");
            merges.push("HEAD");
        }
    }
    let n: usize = executor::read(root, &merges).await?.trim().parse().unwrap_or(0);
    if n > 0 {
        return Err(AppError::invalid_arg("hay commits de merge en ese tramo; reescribirlo aplanaría la historia"));
    }
    Ok(executor::read(root, &args).await?.lines().map(str::to_string).collect())
}

fn rebase_base_args(base: &Option<String>) -> Vec<&str> {
    let mut v = vec!["rebase", "-i"];
    match base {
        Some(b) => v.push(b.as_str()),
        None => v.push("--root"),
    }
    v
}

/// Rebase interactivo scriptado (mismo patrón que `commands::rebase_interactive`): el todo y el mensaje
/// se escriben en un tempdir y los editores solo los copian. Nada del usuario entra en los scripts.
async fn scripted_rebase(root: &Path, base: &Option<String>, todo: &str, message: Option<&str>) -> Result<()> {
    let dir = tempfile::Builder::new().prefix("caesargit-rebase").tempdir()?;
    let d = sh_path(dir.path())?;
    tokio::fs::write(dir.path().join("todo"), todo).await?;
    tokio::fs::write(dir.path().join("seq.sh"), format!("cat '{d}/todo' > \"$1\"\n")).await?;
    if let Some(m) = message {
        let mut text = m.trim_end().to_string();
        text.push('\n');
        tokio::fs::write(dir.path().join("msg"), text).await?;
    }
    tokio::fs::write(dir.path().join("editor.sh"), format!("if [ -f '{d}/msg' ]; then cat '{d}/msg' > \"$1\"; fi\n")).await?;
    let seq_env = format!("sh '{d}/seq.sh'");
    let ed_env = format!("sh '{d}/editor.sh'");
    let args = rebase_base_args(base);
    executor::write_env(root, &args, &[("GIT_SEQUENCE_EDITOR", &seq_env), ("GIT_EDITOR", &ed_env)]).await?;
    Ok(())
}

#[tauri::command]
pub async fn squash_commits(repo_path: String, shas: Vec<String>, message: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Combinar commits", async {
        if shas.len() < 2 {
            return Err(AppError::invalid_arg("elige al menos 2 commits para combinar"));
        }
        let mut fulls = Vec::new();
        for s in &shas {
            let f = resolve_commit(&r, s).await?;
            if fulls.contains(&f) {
                return Err(AppError::invalid_arg("commit repetido"));
            }
            fulls.push(f);
        }
        let line: Vec<String> = executor::read(&r, &["rev-list", "--first-parent", "HEAD"]).await?.lines().map(str::to_string).collect();
        let mut pos: Vec<usize> = Vec::new();
        for f in &fulls {
            pos.push(line.iter().position(|l| l == f).ok_or_else(|| AppError::invalid_arg("el commit no está en la historia de HEAD"))?);
        }
        pos.sort_unstable();
        if pos.windows(2).any(|w| w[1] != w[0] + 1) {
            return Err(AppError::invalid_arg("los commits deben ser consecutivos"));
        }
        let oldest = line[*pos.last().unwrap_or(&0)].clone();
        let base = parent_of(&r, &oldest).await;
        let commits = linear_range(&r, base.as_deref()).await?;
        let mut todo = String::new();
        for c in &commits {
            let verb = if fulls.contains(c) && *c != oldest { "squash" } else { "pick" };
            todo.push_str(&format!("{verb} {c}\n"));
        }
        let msg = Some(message.as_str()).filter(|m| !m.trim().is_empty());
        scripted_rebase(&r, &base, &todo, msg).await
    }).await
}

#[tauri::command]
pub async fn fixup_commit(repo_path: String, sha: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Fixup", async {
        let full = resolve_commit(&r, &sha).await?;
        if executor::read(&r, &["merge-base", "--is-ancestor", full.as_str(), "HEAD"]).await.is_err() {
            return Err(AppError::invalid_arg("el commit no está en la historia de HEAD"));
        }
        if executor::read(&r, &["diff", "--cached", "--quiet"]).await.is_ok() {
            return Err(AppError::invalid_arg("no hay cambios preparados (stage) para el fixup"));
        }
        let base = parent_of(&r, &full).await;
        linear_range(&r, base.as_deref()).await?;
        executor::write(&r, &["commit", "--fixup", full.as_str()]).await?;
        let mut args = rebase_base_args(&base);
        args.insert(2, "--autostash");
        args.insert(2, "--autosquash");
        executor::write_env(&r, &args, &[("GIT_SEQUENCE_EDITOR", "true"), ("GIT_EDITOR", "true")]).await?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn drop_commit(repo_path: String, sha: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Eliminar commit", async {
        let full = resolve_commit(&r, &sha).await?;
        if executor::read(&r, &["merge-base", "--is-ancestor", full.as_str(), "HEAD"]).await.is_err() {
            return Err(AppError::invalid_arg("el commit no está en la historia de HEAD"));
        }
        let base = parent_of(&r, &full).await;
        let commits = linear_range(&r, base.as_deref()).await?;
        let mut todo = String::new();
        for c in &commits {
            todo.push_str(&format!("{} {c}\n", if *c == full { "drop" } else { "pick" }));
        }
        scripted_rebase(&r, &base, &todo, None).await
    }).await
}

/// `direction`: "up" lo acerca a HEAD (más nuevo, sube en la lista); "down" lo acerca a la raíz.
#[tauri::command]
pub async fn move_commit(repo_path: String, sha: String, direction: String) -> Result<()> {
    let r = root(&repo_path).await?;
    tracked(&r, "Mover commit", async {
        let full = resolve_commit(&r, &sha).await?;
        if executor::read(&r, &["merge-base", "--is-ancestor", full.as_str(), "HEAD"]).await.is_err() {
            return Err(AppError::invalid_arg("el commit no está en la historia de HEAD"));
        }
        // `first` es el más antiguo de la pareja que se intercambia.
        let first = match direction.as_str() {
            "up" => full.clone(),
            "down" => parent_of(&r, &full).await.ok_or_else(|| AppError::invalid_arg("ya es el commit más antiguo"))?,
            _ => return Err(AppError::invalid_arg("dirección no válida (up|down)")),
        };
        let base = parent_of(&r, &first).await;
        let mut commits = linear_range(&r, base.as_deref()).await?;
        if commits.len() < 2 || commits[0] != first {
            return Err(AppError::invalid_arg("ya es el commit más reciente"));
        }
        commits.swap(0, 1);
        let todo: String = commits.iter().map(|c| format!("pick {c}\n")).collect();
        scripted_rebase(&r, &base, &todo, None).await
    }).await
}

// ================================================================ (10) Prevención de conflictos

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCheck {
    pub will_conflict: bool,
    pub files: Vec<String>,
    /// La lista de archivos se truncó (muchos conflictos).
    pub truncated: bool,
}

/// Simula `merge source` sobre HEAD con `git merge-tree --write-tree` sin tocar el árbol de trabajo.
#[tauri::command]
pub async fn check_merge_conflicts(repo_path: String, source: String) -> Result<MergeCheck> {
    let r = root(&repo_path).await?;
    validate_ref(&source)?;
    match executor::read(&r, &["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", source.as_str()]).await {
        Ok(_) => Ok(MergeCheck { will_conflict: false, files: Vec::new(), truncated: false }),
        Err(e) => {
            // Exit 1 = conflictos: stdout = «<tree>\n<archivo>\n…». Un error real trae «fatal:/error:».
            let mut lines = e.message.lines();
            let first = lines.next().unwrap_or("").trim();
            let is_tree = first.len() >= 40 && first.chars().all(|c| c.is_ascii_hexdigit());
            if !is_tree {
                return Err(e);
            }
            let truncated = e.message.ends_with('…');
            let mut files: Vec<String> = Vec::new();
            let mut rest: Vec<&str> = lines.take_while(|l| !l.is_empty()).collect();
            if truncated {
                rest.pop();
            }
            for f in rest {
                if !files.iter().any(|x| x == f) {
                    files.push(f.to_string());
                }
            }
            Ok(MergeCheck { will_conflict: true, files, truncated })
        }
    }
}

// ================================================================ (11) Estadísticas

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    pub commits: usize,
    pub branches: usize,
    pub remote_branches: usize,
    pub tags: usize,
    pub contributors: Vec<Contributor>,
}

async fn count_refs(root: &Path, prefix: &str, skip_head: bool) -> usize {
    executor::read(root, &["for-each-ref", "--format=%(refname)", prefix])
        .await
        .map(|s| s.lines().filter(|l| !(skip_head && l.ends_with("/HEAD"))).count())
        .unwrap_or(0)
}

fn parse_shortlog(text: &str) -> Vec<Contributor> {
    text.lines()
        .filter_map(|l| {
            let (n, who) = l.trim_start().split_once('\t')?;
            let commits = n.trim().parse().ok()?;
            let (name, email) = match who.rsplit_once(" <") {
                Some((a, b)) => (a.to_string(), b.trim_end_matches('>').to_string()),
                None => (who.to_string(), String::new()),
            };
            Some(Contributor { name, email, commits })
        })
        .collect()
}

#[tauri::command]
pub async fn repo_stats(repo_path: String) -> Result<RepoStats> {
    let r = root(&repo_path).await?;
    let mut st = RepoStats {
        branches: count_refs(&r, "refs/heads/", false).await,
        remote_branches: count_refs(&r, "refs/remotes/", true).await,
        tags: count_refs(&r, "refs/tags/", false).await,
        ..Default::default()
    };
    if has_head(&r).await {
        st.commits = executor::read(&r, &["rev-list", "--count", "HEAD"]).await?.trim().parse().unwrap_or(0);
        let mut c = parse_shortlog(&executor::read(&r, &["shortlog", "-sne", "HEAD"]).await.unwrap_or_default());
        c.sort_by_key(|a| std::cmp::Reverse(a.commits));
        c.truncate(10);
        st.contributors = c;
    }
    Ok(st)
}

// ================================================================ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    fn init() -> (tempfile::TempDir, String) {
        let td = tempfile::tempdir().unwrap();
        let d = td.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.name", "Test"]);
        sh(d, &["config", "user.email", "t@example.com"]);
        sh(d, &["config", "commit.gpgsign", "false"]);
        sh(d, &["config", "protocol.file.allow", "always"]);
        let p = d.to_string_lossy().into_owned();
        (td, p)
    }

    fn commit_file(d: &Path, file: &str, content: &str, msg: &str) -> String {
        std::fs::write(d.join(file), content).unwrap();
        sh(d, &["add", "--", file]);
        sh(d, &["commit", "-q", "-m", msg]);
        sh(d, &["rev-parse", "HEAD"])
    }

    fn subjects(d: &Path) -> Vec<String> {
        sh(d, &["log", "--format=%s"]).lines().map(str::to_string).collect()
    }

    #[test]
    fn urls() {
        for ok in ["https://github.com/a/b.git", "ssh://git@host/a.git", "git@github.com:a/b.git", "file:///tmp/x", "/tmp/x", "./sub", "../sub", "C:\\repos\\x"] {
            assert!(validate_git_url(ok).is_ok(), "{ok}");
        }
        for bad in ["ext::sh -c touch /tmp/x", "--upload-pack=evil", "-oProxy", "http://x/y", "ssh://-oProxyCommand=x/y", "git@-host:x", "ftp://x", "", "https://a b", "ext::x", "foo"] {
            assert!(validate_git_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parsers() {
        let w = parse_worktrees("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\nlocked razón\nprunable gone\n");
        assert_eq!(w.len(), 2);
        assert!(w[0].is_main && w[0].branch.as_deref() == Some("main"));
        assert!(w[1].locked && w[1].prunable && w[1].detached && w[1].lock_reason.as_deref() == Some("razón"));
        let p = parse_lfs_patterns("Listing tracked patterns\n    *.psd (.gitattributes)\nListing excluded patterns\n");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].pattern, "*.psd");
        assert_eq!(p[0].source, ".gitattributes");
        let f = parse_lfs_files("1234567890 * a/b.bin\nabcdef1234 - c.bin\n");
        assert!(f[0].downloaded && !f[1].downloaded && f[1].path == "c.bin");
        let c = parse_shortlog("    12\tAna Pérez <ana@x.com>\n     3\tBob <b@x.com>\n");
        assert_eq!(c[0].commits, 12);
        assert_eq!(c[1].email, "b@x.com");
    }

    #[tokio::test]
    async fn reflog_y_stats() {
        let (td, p) = init();
        let d = td.path();
        assert!(get_reflog(p.clone(), None).await.unwrap().is_empty());
        commit_file(d, "a.txt", "1", "uno");
        commit_file(d, "a.txt", "2", "dos");
        sh(d, &["tag", "v1"]);
        sh(d, &["branch", "otra"]);
        let rl = get_reflog(p.clone(), Some(10)).await.unwrap();
        assert_eq!(rl.len(), 2);
        assert_eq!(rl[0].selector, "HEAD@{0}");
        assert_eq!(rl[0].action, "commit");
        assert_eq!(rl[0].message, "dos");
        assert!(rl[0].date.starts_with("20"), "{}", rl[0].date);
        assert_eq!(get_reflog(p.clone(), Some(1)).await.unwrap().len(), 1);
        let st = repo_stats(p.clone()).await.unwrap();
        assert_eq!((st.commits, st.branches, st.tags), (2, 2, 1));
        assert_eq!(st.contributors[0].commits, 2);
        assert_eq!(st.contributors[0].name, "Test");
    }

    #[tokio::test]
    async fn bisect_completo() {
        let (td, p) = init();
        let d = td.path();
        let c1 = commit_file(d, "f.txt", "1", "c1");
        commit_file(d, "f.txt", "2", "c2");
        let c3 = commit_file(d, "bug.txt", "bug", "c3 introduce bug");
        commit_file(d, "f.txt", "4", "c4");
        let c5 = commit_file(d, "f.txt", "5", "c5");
        assert!(bisect_mark(p.clone(), "good".into()).await.is_err());
        let st = bisect_start(p.clone(), c5.clone(), c1).await.unwrap();
        assert!(st.active && st.current.is_some() && st.remaining.is_some());
        let mut st = st;
        for _ in 0..6 {
            if st.first_bad.is_some() {
                break;
            }
            let kind = if d.join("bug.txt").exists() { "bad" } else { "good" };
            st = bisect_mark(p.clone(), kind.into()).await.unwrap();
        }
        assert_eq!(st.first_bad.as_deref(), Some(c3.as_str()));
        assert!(!st.log.is_empty());
        assert!(bisect_status(p.clone()).await.unwrap().active);
        assert!(bisect_mark(p.clone(), "foo".into()).await.is_err());
        let st = bisect_reset(p.clone()).await.unwrap();
        assert!(!st.active);
        assert_eq!(sh(d, &["rev-parse", "HEAD"]), c5);
    }

    #[tokio::test]
    async fn parches() {
        let (td, p) = init();
        let d = td.path();
        commit_file(d, "a.txt", "uno\n", "c1");
        let c2 = commit_file(d, "a.txt", "uno\ndos\n", "c2");
        let patch = create_patch(p.clone(), Some(vec![c2.clone()]), None).await.unwrap();
        assert!(patch.contains("Subject: [PATCH] c2"));
        assert!(create_patch(p.clone(), Some(vec![]), None).await.is_err());
        assert!(create_patch(p.clone(), Some(vec!["--help".into()]), None).await.is_err());
        // wip
        std::fs::write(d.join("a.txt"), "uno\ndos\ntres\n").unwrap();
        let wip = create_patch(p.clone(), None, Some(true)).await.unwrap();
        assert!(wip.contains("+tres"));
        sh(d, &["checkout", "-q", "--", "a.txt"]);
        // aplicar en un clon
        let td2 = tempfile::tempdir().unwrap();
        let d2 = td2.path().join("clon");
        sh(td2.path(), &["clone", "-q", &p, d2.to_str().unwrap()]);
        sh(&d2, &["config", "user.name", "T"]);
        sh(&d2, &["config", "user.email", "t@x.com"]);
        sh(&d2, &["reset", "-q", "--hard", "HEAD~1"]);
        let p2 = d2.to_string_lossy().into_owned();
        apply_patch(p2.clone(), patch.clone(), true, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(d2.join("a.txt")).unwrap(), "uno\n");
        apply_patch(p2.clone(), patch.clone(), false, true).await.unwrap();
        assert_eq!(std::fs::read_to_string(d2.join("a.txt")).unwrap(), "uno\ndos\n");
        assert_eq!(sh(&d2, &["diff", "--cached", "--name-only"]), "a.txt");
        // ya aplicado: la comprobación falla
        assert!(apply_patch(p2.clone(), patch.clone(), true, false).await.is_err());
        assert!(apply_patch(p2, "basura".into(), true, false).await.is_err());
        // guardar
        let out = td2.path().join("x.patch");
        save_patch(out.to_string_lossy().into_owned(), patch.clone()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), patch);
        assert!(save_patch(td2.path().join("x.txt").to_string_lossy().into_owned(), "a".into()).await.is_err());
        assert!(save_patch(format!("{}/../y.patch", td2.path().display()), "a".into()).await.is_err());
        assert!(save_patch("rel.patch".into(), "a".into()).await.is_err());
        assert!(save_patch(td2.path().join("no/existe/z.diff").to_string_lossy().into_owned(), "a".into()).await.is_err());
        assert!(save_patch(d.join(".git/hooks/p.patch").to_string_lossy().into_owned(), "a".into()).await.is_err());
    }

    #[tokio::test]
    async fn submodulos() {
        let inner = tempfile::tempdir().unwrap();
        let di = inner.path();
        sh(di, &["init", "-q", "-b", "main"]);
        sh(di, &["config", "user.name", "T"]);
        sh(di, &["config", "user.email", "t@x.com"]);
        commit_file(di, "lib.txt", "lib", "lib");
        let url = format!("file://{}", di.display());
        let (td, p) = init();
        let d = td.path();
        commit_file(d, "a.txt", "1", "c1");
        assert!(list_submodules(p.clone()).await.unwrap().is_empty());
        assert!(submodule_add(p.clone(), "ext::sh -c id".into(), "libs/x".into(), None).await.is_err());
        assert!(submodule_add(p.clone(), url.clone(), "../fuera".into(), None).await.is_err());
        submodule_add(p.clone(), url.clone(), "libs/inner".into(), None).await.unwrap();
        let l = list_submodules(p.clone()).await.unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].path.as_str(), l[0].status.as_str(), l[0].url.as_str()), ("libs/inner", "ok", url.as_str()));
        assert_eq!(l[0].sha.len(), 40);
        sh(d, &["commit", "-q", "-m", "add sub"]);
        submodule_sync(p.clone(), true).await.unwrap();
        // desinicializar y volver a inicializar/actualizar
        sh(d, &["submodule", "deinit", "-f", "--all"]);
        assert_eq!(list_submodules(p.clone()).await.unwrap()[0].status, "uninitialized");
        submodule_init(p.clone(), None).await.unwrap();
        submodule_update(p.clone(), true, false, None).await.unwrap();
        assert_eq!(list_submodules(p.clone()).await.unwrap()[0].status, "ok");
        assert!(d.join("libs/inner/lib.txt").exists());
        assert!(submodule_remove(p.clone(), "a.txt".into()).await.is_err());
        submodule_remove(p.clone(), "libs/inner".into()).await.unwrap();
        assert!(list_submodules(p.clone()).await.unwrap().is_empty());
        assert!(!d.join("libs/inner").exists());
        assert!(!d.join(".git/modules/libs/inner").exists());
        let gm = std::fs::read_to_string(d.join(".gitmodules")).unwrap_or_default();
        assert!(!gm.contains("inner"));
    }

    #[tokio::test]
    async fn worktrees() {
        let (td, p) = init();
        let d = td.path();
        commit_file(d, "a.txt", "1", "c1");
        let wt_dir = tempfile::tempdir().unwrap();
        let wp = wt_dir.path().join("wt1");
        let wps = wp.to_string_lossy().into_owned();
        assert!(add_worktree(p.clone(), "relativa".into(), "x".into(), true, None).await.is_err());
        add_worktree(p.clone(), wps.clone(), "feat".into(), true, None).await.unwrap();
        let l = list_worktrees(p.clone()).await.unwrap();
        assert_eq!(l.len(), 2);
        assert!(l[0].is_main && !l[1].is_main);
        assert_eq!(l[1].branch.as_deref(), Some("feat"));
        assert!(remove_worktree(p.clone(), d.to_string_lossy().into_owned(), true, false).await.is_err());
        lock_worktree(p.clone(), wps.clone(), Some("probando".into())).await.unwrap();
        assert!(list_worktrees(p.clone()).await.unwrap()[1].locked);
        assert!(remove_worktree(p.clone(), wps.clone(), false, false).await.is_err());
        unlock_worktree(p.clone(), wps.clone()).await.unwrap();
        // existente
        let wp2 = wt_dir.path().join("wt2");
        sh(d, &["branch", "otra"]);
        add_worktree(p.clone(), wp2.to_string_lossy().into_owned(), "otra".into(), false, None).await.unwrap();
        assert_eq!(list_worktrees(p.clone()).await.unwrap().len(), 3);
        remove_worktree(p.clone(), wps, false, true).await.unwrap();
        assert!(!wp.exists());
        assert!(!sh(d, &["branch", "--list", "feat"]).contains("feat"));
        // obsoleto: borrar el directorio a mano y podar
        std::fs::remove_dir_all(&wp2).unwrap();
        assert!(list_worktrees(p.clone()).await.unwrap().iter().any(|w| w.prunable));
        assert_eq!(prune_worktrees(p.clone()).await.unwrap(), 1);
        assert_eq!(list_worktrees(p.clone()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn lfs_sin_instalar_o_instalado() {
        let (td, p) = init();
        commit_file(td.path(), "a.txt", "1", "c1");
        let st = lfs_status(p.clone()).await.unwrap();
        if st.installed {
            assert!(lfs_track(p.clone(), "*.psd".into()).await.is_ok());
        } else {
            let e = lfs_track(p.clone(), "*.psd".into()).await.unwrap_err();
            assert_eq!(e.code, "git_failed");
            assert!(e.message.contains("Git LFS"));
            assert!(lfs_pull(p.clone()).await.is_err());
            assert!(lfs_locks(p.clone()).await.is_err());
        }
        assert!(validate_lfs_pattern("-x").is_err());
        assert!(validate_lfs_pattern("a b").is_err());
        assert!(validate_lfs_pattern("*.psd").is_ok());
    }

    fn flow_cfg() -> FlowConfig {
        FlowConfig { master: "main".into(), version_tag: "v".into(), ..Default::default() }
    }

    #[tokio::test]
    async fn gitflow() {
        let (td, p) = init();
        let d = td.path();
        assert!(!flow_get_config(p.clone()).await.unwrap().initialized);
        assert!(flow_start(p.clone(), "feature".into(), "x".into()).await.is_err());
        commit_file(d, "a.txt", "1", "base");
        let mut bad = flow_cfg();
        bad.feature = "-x/".into();
        assert!(flow_init(p.clone(), bad).await.is_err());
        let c = flow_init(p.clone(), flow_cfg()).await.unwrap();
        assert!(c.initialized);
        assert_eq!(sh(d, &["config", "--get", "gitflow.prefix.feature"]), "feature/");
        assert_eq!(sh(d, &["config", "--get", "gitflow.branch.develop"]), "develop");
        assert_eq!(sh(d, &["config", "--get", "gitflow.prefix.versiontag"]), "v");

        // feature
        assert_eq!(flow_start(p.clone(), "feature".into(), "login".into()).await.unwrap(), "feature/login");
        assert!(flow_start(p.clone(), "feature".into(), "login".into()).await.is_err());
        commit_file(d, "f.txt", "f", "feat login");
        let st = flow_status(p.clone()).await.unwrap();
        assert_eq!(st.feature, vec!["login"]);
        assert_eq!(st.current.as_ref().unwrap().kind, "feature");
        flow_finish(p.clone(), "feature".into(), "login".into(), Some(FlowFinishOpts { no_ff: true, ..Default::default() })).await.unwrap();
        assert_eq!(sh(d, &["branch", "--show-current"]), "develop");
        assert!(sh(d, &["branch", "--list", "feature/login"]).is_empty());
        assert!(d.join("f.txt").exists());
        assert_eq!(sh(d, &["log", "-1", "--format=%s"]), "Merge feature 'login'");

        // release con tag
        flow_start(p.clone(), "release".into(), "1.0".into()).await.unwrap();
        commit_file(d, "v.txt", "1.0", "bump");
        flow_finish(
            p.clone(),
            "release".into(),
            "1.0".into(),
            Some(FlowFinishOpts { tag: true, tag_message: Some("Versión 1.0".into()), ..Default::default() }),
        )
        .await
        .unwrap();
        assert_eq!(sh(d, &["tag", "--list", "v1.0"]), "v1.0");
        assert!(sh(d, &["tag", "-n1", "--list", "v1.0"]).contains("Versión 1.0"));
        assert!(sh(d, &["show", "main:v.txt"]).contains("1.0"));
        assert!(sh(d, &["show", "develop:v.txt"]).contains("1.0"));
        assert!(sh(d, &["branch", "--list", "release/1.0"]).is_empty());

        // hotfix con squash y keep
        flow_start(p.clone(), "hotfix".into(), "h1".into()).await.unwrap();
        commit_file(d, "h.txt", "h", "fix");
        flow_finish(p.clone(), "hotfix".into(), "h1".into(), Some(FlowFinishOpts { keep_branch: true, ..Default::default() })).await.unwrap();
        assert!(!sh(d, &["branch", "--list", "hotfix/h1"]).is_empty());
        let st = flow_status(p.clone()).await.unwrap();
        assert_eq!(st.hotfix, vec!["h1"]);
        assert!(flow_finish(p.clone(), "support".into(), "s".into(), None).await.is_err());

        // feature con squash
        flow_start(p.clone(), "feature".into(), "sq".into()).await.unwrap();
        commit_file(d, "s1.txt", "1", "s1");
        commit_file(d, "s2.txt", "2", "s2");
        flow_finish(p.clone(), "feature".into(), "sq".into(), Some(FlowFinishOpts { squash: true, ..Default::default() })).await.unwrap();
        assert!(sh(d, &["branch", "--list", "feature/sq"]).is_empty());
        assert!(d.join("s2.txt").exists());
        assert_eq!(sh(d, &["log", "-1", "--format=%s"]), "Merge feature 'sq'");
        // push sin remoto
        flow_start(p.clone(), "feature".into(), "np".into()).await.unwrap();
        let e = flow_finish(p.clone(), "feature".into(), "np".into(), Some(FlowFinishOpts { push: true, ..Default::default() })).await.unwrap_err();
        assert_eq!(e.code, "invalid_arg");
    }

    #[tokio::test]
    async fn hooks() {
        let (td, p) = init();
        commit_file(td.path(), "a.txt", "1", "c1");
        let l = list_hooks(p.clone()).await.unwrap();
        assert!(l.iter().any(|h| h.name == "pre-commit" && h.is_sample && !h.exists));
        assert!(write_hook(p.clone(), "../evil".into(), "x".into()).await.is_err());
        assert!(write_hook(p.clone(), "no-existe".into(), "x".into()).await.is_err());
        write_hook(p.clone(), "pre-commit".into(), "#!/bin/sh\r\nexit 1\r\n".into()).await.unwrap();
        let h = list_hooks(p.clone()).await.unwrap().into_iter().find(|h| h.name == "pre-commit").unwrap();
        assert!(h.exists && h.active && !h.is_sample && !h.disabled);
        assert_eq!(read_hook(p.clone(), "pre-commit".into()).await.unwrap(), "#!/bin/sh\nexit 1\n");
        #[cfg(unix)]
        {
            // el hook realmente bloquea el commit
            std::fs::write(td.path().join("b.txt"), "b").unwrap();
            sh(td.path(), &["add", "b.txt"]);
            let o = std::process::Command::new("git").args(["commit", "-q", "-m", "x"]).current_dir(td.path()).output().unwrap();
            assert!(!o.status.success());
        }
        toggle_hook(p.clone(), "pre-commit".into(), false).await.unwrap();
        let h = list_hooks(p.clone()).await.unwrap().into_iter().find(|h| h.name == "pre-commit").unwrap();
        assert!(h.exists && !h.active && h.disabled);
        write_hook(p.clone(), "pre-commit".into(), "#!/bin/sh\nexit 0\n".into()).await.unwrap();
        assert!(!list_hooks(p.clone()).await.unwrap().iter().find(|h| h.name == "pre-commit").unwrap().active);
        toggle_hook(p.clone(), "pre-commit".into(), true).await.unwrap();
        assert!(list_hooks(p.clone()).await.unwrap().iter().find(|h| h.name == "pre-commit").unwrap().active);
        delete_hook(p.clone(), "pre-commit".into()).await.unwrap();
        assert!(delete_hook(p.clone(), "pre-commit".into()).await.is_err());
        assert!(read_hook(p.clone(), "pre-commit".into()).await.unwrap().contains("pre-commit")); // el .sample
        let t = hook_templates().await.unwrap();
        for n in ["pre-commit", "commit-msg", "pre-push"] {
            assert!(t.iter().any(|x| x.name == n && x.content.starts_with("#!/bin/sh")));
        }
    }

    fn five(d: &Path) -> Vec<String> {
        (1..=5).map(|i| commit_file(d, &format!("f{i}.txt"), &i.to_string(), &format!("c{i}"))).collect()
    }

    #[tokio::test]
    async fn squash_fixup_drop_move() {
        let (td, p) = init();
        let d = td.path();
        let c = five(d);
        // no consecutivos / pocos / repetidos
        assert!(squash_commits(p.clone(), vec![c[0].clone(), c[2].clone()], "x".into()).await.is_err());
        assert!(squash_commits(p.clone(), vec![c[0].clone()], "x".into()).await.is_err());
        squash_commits(p.clone(), vec![c[3].clone(), c[2].clone(), c[1].clone()], "c2+c3+c4 juntos".into()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c2+c3+c4 juntos", "c1"]);
        assert!(d.join("f2.txt").exists() && d.join("f3.txt").exists() && d.join("f4.txt").exists());
        // squash incluyendo la raíz
        let all = sh(d, &["rev-list", "--reverse", "HEAD"]).lines().take(2).map(str::to_string).collect::<Vec<_>>();
        squash_commits(p.clone(), all, "base".into()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "base"]);

        // drop
        let (td, p) = init();
        let d = td.path();
        let c = five(d);
        drop_commit(p.clone(), c[2].clone()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c4", "c2", "c1"]);
        assert!(!d.join("f3.txt").exists());
        let root_sha = sh(d, &["rev-list", "--max-parents=0", "HEAD"]);
        drop_commit(p.clone(), root_sha).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c4", "c2"]);

        // move (archivos distintos: sin conflicto)
        let (td, p) = init();
        let d = td.path();
        let c = five(d);
        move_commit(p.clone(), c[3].clone(), "down".into()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c3", "c4", "c2", "c1"]);
        let c4 = sh(d, &["log", "--format=%H %s"]).lines().find(|l| l.ends_with("c4")).unwrap()[..40].to_string();
        move_commit(p.clone(), c4, "up".into()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c4", "c3", "c2", "c1"]);
        let top = sh(d, &["rev-parse", "HEAD"]);
        assert!(move_commit(p.clone(), top, "up".into()).await.is_err());
        let root_sha = sh(d, &["rev-list", "--max-parents=0", "HEAD"]);
        assert!(move_commit(p.clone(), root_sha.clone(), "down".into()).await.is_err());
        move_commit(p.clone(), root_sha, "up".into()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c4", "c3", "c1", "c2"]);
        assert!(move_commit(p.clone(), "abcdef12".into(), "left".into()).await.is_err());

        // fixup
        let (td, p) = init();
        let d = td.path();
        let c = five(d);
        assert!(fixup_commit(p.clone(), c[1].clone()).await.is_err()); // nada preparado
        std::fs::write(d.join("f2.txt"), "corregido").unwrap();
        std::fs::write(d.join("f5.txt"), "sin preparar").unwrap();
        sh(d, &["add", "f2.txt"]);
        fixup_commit(p.clone(), c[1].clone()).await.unwrap();
        assert_eq!(subjects(d), vec!["c5", "c4", "c3", "c2", "c1"]);
        let first_two = sh(d, &["show", "--format=", "--name-only", "HEAD~3"]);
        assert_eq!(first_two, "f2.txt");
        assert_eq!(sh(d, &["show", "HEAD~3:f2.txt"]), "corregido");
        // los cambios sin preparar se conservan
        assert_eq!(std::fs::read_to_string(d.join("f5.txt")).unwrap(), "sin preparar");
        // sha inválido
        assert!(fixup_commit(p.clone(), "--help".into()).await.is_err());
    }

    #[tokio::test]
    async fn merge_conflicts() {
        let (td, p) = init();
        let d = td.path();
        commit_file(d, "a.txt", "base\n", "base");
        commit_file(d, "b.txt", "base\n", "base b");
        sh(d, &["checkout", "-q", "-b", "x"]);
        commit_file(d, "a.txt", "rama\n", "en x");
        sh(d, &["checkout", "-q", "main"]);
        let ok = check_merge_conflicts(p.clone(), "x".into()).await.unwrap();
        assert!(!ok.will_conflict);
        commit_file(d, "a.txt", "main\n", "en main");
        let c = check_merge_conflicts(p.clone(), "x".into()).await.unwrap();
        assert!(c.will_conflict);
        assert_eq!(c.files, vec!["a.txt"]);
        // no ha tocado el árbol de trabajo
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "main\n");
        assert_eq!(sh(d, &["status", "--porcelain"]), "");
        assert!(check_merge_conflicts(p.clone(), "no-existe".into()).await.is_err());
        assert!(check_merge_conflicts(p.clone(), "--exec=x".into()).await.is_err());
    }

    #[tokio::test]
    async fn undo_redo_squash_y_flow() {
        use crate::git::ext_a::{redo_action, undo_action};
        let (td, p) = init();
        let d = td.path();
        let c = five(d);
        let head0 = sh(d, &["rev-parse", "HEAD"]);
        squash_commits(p.clone(), vec![c[3].clone(), c[2].clone()], "juntos".into()).await.unwrap();
        let head1 = sh(d, &["rev-parse", "HEAD"]);
        assert_ne!(head0, head1);
        undo_action(p.clone()).await.unwrap();
        assert_eq!(sh(d, &["rev-parse", "HEAD"]), head0);
        assert_eq!(subjects(d), vec!["c5", "c4", "c3", "c2", "c1"]);
        redo_action(p.clone()).await.unwrap();
        assert_eq!(sh(d, &["rev-parse", "HEAD"]), head1);

        let (td, p) = init();
        let d = td.path();
        commit_file(d, "a.txt", "1", "base");
        flow_init(p.clone(), flow_cfg()).await.unwrap();
        let before = sh(d, &["branch", "--show-current"]);
        flow_start(p.clone(), "feature".into(), "u".into()).await.unwrap();
        assert_eq!(sh(d, &["branch", "--show-current"]), "feature/u");
        undo_action(p.clone()).await.unwrap();
        assert_eq!(sh(d, &["branch", "--show-current"]), before);
        assert!(sh(d, &["branch", "--list", "feature/u"]).is_empty());
        redo_action(p.clone()).await.unwrap();
        assert_eq!(sh(d, &["branch", "--show-current"]), "feature/u");
    }
}
