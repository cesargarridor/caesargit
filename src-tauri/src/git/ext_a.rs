//! Comandos extendidos A (repo, remotos, undo/redo, config, apertura externa). Paquete R1.
//!
//! Undo/Redo: antes de cada comando de escritura que cambia el estado local (`tracked`) se
//! toma una instantánea (HEAD, refs/heads, refs/tags, stashes, árbol del índice y árbol del
//! working tree incluyendo archivos sin seguimiento). Si el comando cambió algo, la
//! instantánea previa entra en la pila de undo del repo. Undo = restaurar refs + HEAD +
//! `read-tree`; el estado anterior a deshacer pasa a la pila de redo.
use crate::error::{AppError, Result};
use crate::git::commands::{self, root};
use crate::git::models::*;
use crate::git::{executor, parsers};
use crate::security::arg_guard::*;
use crate::security::path_guard;
use once_cell::sync::Lazy;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter};

// ================================================================ Undo / Redo

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    head_ref: Option<String>,
    head_sha: Option<String>,
    refs: BTreeMap<String, String>,
    stashes: Vec<(String, String)>,
    itree: Option<String>,
    wtree: String,
}

#[derive(Debug, Clone)]
struct Entry {
    label: String,
    snap: Snapshot,
}

#[derive(Default)]
struct Stacks {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
}

const UNDO_CAP: usize = 100;
static STACKS: Lazy<StdMutex<HashMap<PathBuf, Stacks>>> = Lazy::new(|| StdMutex::new(HashMap::new()));
static UNDO_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

fn with_stacks<T>(root: &Path, f: impl FnOnce(&mut Stacks) -> T) -> T {
    let mut g = STACKS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.entry(root.to_path_buf()).or_default())
}

fn trimmed(s: String) -> Option<String> {
    let t = s.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

async fn list_refs(root: &Path) -> Result<BTreeMap<String, String>> {
    let out = executor::read(root, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]).await?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once(' '))
        .map(|(sha, name)| (name.to_string(), sha.to_string()))
        .collect())
}

async fn list_stashes_raw(root: &Path) -> Vec<(String, String)> {
    executor::read(root, &["stash", "list", "--format=%H%x00%gs"])
        .await
        .map(|o| {
            o.lines()
                .filter_map(|l| l.split_once('\0'))
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Árbol del working tree completo (incluye archivos sin seguimiento, respeta .gitignore)
/// construido con un índice temporal: no toca el índice real.
async fn worktree_tree(root: &Path) -> Result<String> {
    let gd = executor::git_dir(root).await?;
    let td = tempfile::tempdir()?;
    let idx = td.path().join("index");
    let real = gd.join("index");
    if real.exists() {
        std::fs::copy(&real, &idx)?;
    }
    let idx_s = idx.to_string_lossy().into_owned();
    let envs = [("GIT_INDEX_FILE", idx_s.as_str())];
    executor::read_env(root, &["add", "-A"], &envs).await?;
    let t = executor::read_env(root, &["write-tree"], &envs).await?;
    trimmed(t).ok_or_else(|| AppError::git_failed("write-tree vacío"))
}

async fn snapshot(root: &Path) -> Result<Snapshot> {
    let head_ref = executor::read(root, &["symbolic-ref", "-q", "HEAD"]).await.ok().and_then(trimmed);
    let head_sha = executor::read(root, &["rev-parse", "-q", "--verify", "HEAD"]).await.ok().and_then(trimmed);
    let refs = list_refs(root).await?;
    let stashes = list_stashes_raw(root).await;
    let itree = executor::read(root, &["write-tree"]).await.ok().and_then(trimmed);
    let wtree = worktree_tree(root).await?;
    Ok(Snapshot { head_ref, head_sha, refs, stashes, itree, wtree })
}

async fn restore_stashes(root: &Path, want: &[(String, String)]) -> Result<()> {
    if list_stashes_raw(root).await == want {
        return Ok(());
    }
    if executor::read(root, &["rev-parse", "-q", "--verify", "refs/stash"]).await.is_ok() {
        executor::write(root, &["stash", "clear"]).await?;
    }
    // `want` va del más nuevo al más antiguo; se almacenan del más antiguo al más nuevo.
    for (sha, msg) in want.iter().rev() {
        executor::write(root, &["stash", "store", "-m", msg, sha]).await?;
    }
    Ok(())
}

async fn restore(root: &Path, snap: &Snapshot) -> Result<()> {
    // Una operación a medias (merge/rebase/cherry-pick/revert) se aborta antes de restaurar.
    let gd = executor::git_dir(root).await?;
    if let Some(op) = parsers::detect_operation(&gd) {
        let _ = executor::write(root, &[op.as_str(), "--abort"]).await;
    }
    let cur = list_refs(root).await?;
    for (name, sha) in &snap.refs {
        if cur.get(name) != Some(sha) {
            executor::write(root, &["update-ref", name, sha]).await?;
        }
    }
    match (&snap.head_ref, &snap.head_sha) {
        (Some(r), _) => {
            executor::write(root, &["symbolic-ref", "HEAD", r]).await?;
        }
        (None, Some(sha)) => {
            executor::write(root, &["update-ref", "--no-deref", "HEAD", sha]).await?;
        }
        (None, None) => {}
    }
    for name in cur.keys() {
        if !snap.refs.contains_key(name) {
            executor::write(root, &["update-ref", "-d", name]).await?;
        }
    }
    executor::write(root, &["read-tree", "--reset", "-u", &snap.wtree]).await?;
    if let Some(it) = &snap.itree {
        executor::write(root, &["read-tree", "--reset", it]).await?;
    }
    restore_stashes(root, &snap.stashes).await
}

/// Ejecuta `fut` y, si cambió el estado local del repo, registra una entrada de undo.
pub async fn tracked<T>(root: &Path, label: &str, fut: impl Future<Output = Result<T>>) -> Result<T> {
    let before = snapshot(root).await.ok();
    let res = fut.await;
    if let Some(b) = before {
        if let Ok(a) = snapshot(root).await {
            if a != b {
                with_stacks(root, |s| {
                    s.undo.push(Entry { label: label.to_string(), snap: b });
                    if s.undo.len() > UNDO_CAP {
                        s.undo.remove(0);
                    }
                    s.redo.clear();
                });
            }
        }
    }
    res
}

#[tauri::command]
pub async fn undo_state(repo_path: String) -> Result<UndoState> {
    let r = root(&repo_path).await?;
    Ok(with_stacks(&r, |s| UndoState {
        undo_label: s.undo.last().map(|e| e.label.clone()),
        redo_label: s.redo.last().map(|e| e.label.clone()),
    }))
}

/// Deshace la última acción. Devuelve su etiqueta.
#[tauri::command]
pub async fn undo_action(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    let _g = UNDO_LOCK.lock().await;
    let entry = with_stacks(&r, |s| s.undo.pop()).ok_or_else(|| AppError::invalid_arg("no hay nada que deshacer"))?;
    let current = snapshot(&r).await?;
    if let Err(e) = restore(&r, &entry.snap).await {
        with_stacks(&r, |s| s.undo.push(entry));
        return Err(e);
    }
    let label = entry.label.clone();
    with_stacks(&r, |s| s.redo.push(Entry { label: entry.label, snap: current }));
    Ok(label)
}

/// Rehace la última acción deshecha. Devuelve su etiqueta.
#[tauri::command]
pub async fn redo_action(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    let _g = UNDO_LOCK.lock().await;
    let entry = with_stacks(&r, |s| s.redo.pop()).ok_or_else(|| AppError::invalid_arg("no hay nada que rehacer"))?;
    let current = snapshot(&r).await?;
    if let Err(e) = restore(&r, &entry.snap).await {
        with_stacks(&r, |s| s.redo.push(entry));
        return Err(e);
    }
    let label = entry.label.clone();
    with_stacks(&r, |s| s.undo.push(Entry { label: entry.label, snap: current }));
    Ok(label)
}

// ================================================================ utilidades

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Oculta credenciales embebidas (`https://user:pass@host`) en una URL.
fn mask_url(u: &str) -> String {
    if let Some(i) = u.find("://") {
        let rest = &u[i + 3..];
        if let Some(at) = rest.find('@') {
            let slash = rest.find('/').unwrap_or(rest.len());
            if at < slash {
                let user = rest[..at].split(':').next().unwrap_or("");
                return format!("{}://{}@{}", &u[..i], user, &rest[at + 1..]);
            }
        }
    }
    u.to_string()
}

/// Impide tocar `.git` (hooks, config) desde lectura/escritura de archivos.
fn reject_dot_git(rel: &Path) -> Result<()> {
    if rel.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git")) {
        return Err(AppError::invalid_path("no se permite acceder a .git"));
    }
    Ok(())
}

async fn rel_inside(root: &Path, path: &str) -> Result<(String, PathBuf)> {
    let rel = path_guard::safe_rel(root, path)?;
    reject_dot_git(Path::new(&rel))?;
    let full = path_guard::safe_join(root, &rel)?;
    Ok((rel, full))
}

fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

const MAX_BLOB: u64 = 20 * 1024 * 1024;
const MAX_TEXT: u64 = 10 * 1024 * 1024;

fn validate_rev(rev: &str) -> Result<()> {
    validate_ref(rev)?;
    if rev.contains(':') {
        return Err(AppError::invalid_arg("revisión no válida"));
    }
    Ok(())
}

async fn blob_bytes(root: &Path, rev: &str, path: &str, limit: u64) -> Result<(Vec<u8>, String)> {
    let (rel, full) = rel_inside(root, path).await?;
    match rev {
        "WORKTREE" => {
            let meta = tokio::fs::metadata(&full).await?;
            if meta.len() > limit {
                return Err(AppError::invalid_arg("el archivo supera el límite de tamaño"));
            }
            Ok((tokio::fs::read(&full).await?, rel))
        }
        _ => {
            let spec = if rev == "INDEX" {
                format!(":{rel}")
            } else {
                validate_rev(rev)?;
                format!("{rev}:{rel}")
            };
            let size = executor::read(root, &["cat-file", "-s", &spec]).await?;
            if size.trim().parse::<u64>().unwrap_or(u64::MAX) > limit {
                return Err(AppError::invalid_arg("el archivo supera el límite de tamaño"));
            }
            Ok((executor::read_bytes(root, &["show", &spec]).await?, rel))
        }
    }
}

// ================================================================ repo: clone / init

fn phase_percent(msg: &str) -> Option<u32> {
    let (phase, rest) = msg.split_once(':')?;
    let pct: u32 = rest.trim().split('%').next()?.trim().parse().ok()?;
    let pct = pct.min(100);
    let p = phase.trim_start_matches("remote:").trim().to_ascii_lowercase();
    let (lo, hi) = if p.starts_with("counting") || p.starts_with("enumerating") {
        (0, 10)
    } else if p.starts_with("compressing") {
        (10, 20)
    } else if p.starts_with("receiving") {
        (20, 80)
    } else if p.starts_with("resolving") {
        (80, 95)
    } else if p.starts_with("updating") {
        (95, 100)
    } else {
        (0, 100)
    };
    Some(lo + (hi - lo) * pct / 100)
}

async fn clone_inner(
    url: &str,
    dest: &str,
    depth: Option<u32>,
    recursive: bool,
    branch: Option<&str>,
    mut emit: impl FnMut(GitProgress),
) -> Result<String> {
    validate_url(url)?;
    if dest.is_empty() || dest.contains('\0') {
        return Err(AppError::invalid_path("carpeta de destino vacía"));
    }
    let d = PathBuf::from(dest);
    if !d.is_absolute() || d.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::invalid_path("el destino debe ser una ruta absoluta sin '..'"));
    }
    if d.exists() {
        let empty = d.is_dir() && std::fs::read_dir(&d).map(|mut i| i.next().is_none()).unwrap_or(false);
        if !empty {
            return Err(AppError::invalid_path("la carpeta de destino ya existe y no está vacía"));
        }
    }
    let parent = d.parent().ok_or_else(|| AppError::invalid_path("destino no válido"))?;
    tokio::fs::create_dir_all(parent).await?;
    let mut a: Vec<String> = vec!["-c".into(), "protocol.ext.allow=never".into(), "clone".into(), "--progress".into()];
    if let Some(n) = depth.filter(|n| *n > 0) {
        a.push(format!("--depth={n}"));
    }
    if recursive {
        a.push("--recurse-submodules".into());
    }
    if let Some(b) = branch.filter(|b| !b.is_empty()) {
        validate_ref(b)?;
        a.push("--branch".into());
        a.push(b.to_string());
    }
    a.push("--".into());
    a.push(url.to_string());
    a.push(d.to_string_lossy().into_owned());
    let refs: Vec<&str> = a.iter().map(String::as_str).collect();
    let dest_key = display_path(&d);
    let mut last = 0u32;
    executor::run_streaming(parent, &refs, |line| {
        if let Some(p) = phase_percent(line) {
            last = p;
        }
        emit(GitProgress { repo_path: Some(dest_key.clone()), op: "clone".into(), percent: last, message: line.to_string() });
    })
    .await?;
    emit(GitProgress { repo_path: Some(dest_key), op: "clone".into(), percent: 100, message: "Clonado".into() });
    let canon = std::fs::canonicalize(&d)?;
    Ok(display_path(&canon))
}

/// Clona `url` en `dest` emitiendo `git-progress`. Devuelve la ruta final del repo.
#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    url: String,
    dest: String,
    depth: Option<u32>,
    recursive: Option<bool>,
    branch: Option<String>,
) -> Result<String> {
    clone_inner(&url, &dest, depth, recursive.unwrap_or(false), branch.as_deref(), |p| {
        let _ = app.emit("git-progress", p);
    })
    .await
}

const GITIGNORE_TEMPLATES: &[(&str, &str)] = &[
    ("Node", "node_modules/\nnpm-debug.log*\nyarn-error.log*\ndist/\nbuild/\n.env\n.env.local\ncoverage/\n.cache/\n"),
    ("Python", "__pycache__/\n*.py[cod]\n*.egg-info/\n.venv/\nvenv/\n.env\ndist/\nbuild/\n.pytest_cache/\n.mypy_cache/\n"),
    ("Rust", "/target\n**/*.rs.bk\n"),
    ("Go", "*.exe\n*.test\n*.out\n/bin/\n/vendor/\n"),
    ("Java", "*.class\n*.jar\n*.war\ntarget/\nbuild/\n.gradle/\nout/\n"),
    ("Swift", ".build/\n*.xcodeproj/xcuserdata/\nDerivedData/\n.swiftpm/\n"),
    ("macOS", ".DS_Store\n.AppleDouble\n.LSOverride\n._*\n"),
    ("Windows", "Thumbs.db\nehthumbs.db\nDesktop.ini\n$RECYCLE.BIN/\n"),
    ("JetBrains", ".idea/\n*.iml\n"),
    ("VisualStudioCode", ".vscode/*\n!.vscode/settings.json\n!.vscode/tasks.json\n!.vscode/launch.json\n"),
];

const LICENSES: &[&str] = &["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense"];

fn current_year() -> i64 {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    // Algoritmo civil_from_days (Hinnant).
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y + 1
    } else {
        y
    }
}

fn license_text(name: &str, holder: &str, year: i64) -> Result<String> {
    let bsd_tail = "Redistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this\n   list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice,\n   this list of conditions and the following disclaimer in the documentation\n   and/or other materials provided with the distribution.\n";
    let bsd_disc = "\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n";
    Ok(match name {
        "MIT" => format!("MIT License\n\nCopyright (c) {year} {holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n"),
        "BSD-2-Clause" => format!("BSD 2-Clause License\n\nCopyright (c) {year}, {holder}\nAll rights reserved.\n\n{bsd_tail}{bsd_disc}"),
        "BSD-3-Clause" => format!(
            "BSD 3-Clause License\n\nCopyright (c) {year}, {holder}\nAll rights reserved.\n\n{}\n3. Neither the name of the copyright holder nor the names of its\n   contributors may be used to endorse or promote products derived from\n   this software without specific prior written permission.\n{bsd_disc}",
            bsd_tail.trim_end()
        ),
        "ISC" => format!("ISC License\n\nCopyright (c) {year}, {holder}\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n"),
        "Unlicense" => "This is free and unencumbered software released into the public domain.\n\nAnyone is free to copy, modify, publish, use, compile, sell, or\ndistribute this software, either in source code form or as a compiled\nbinary, for any purpose, commercial or non-commercial, and by any\nmeans.\n\nIn jurisdictions that recognize copyright laws, the author or authors\nof this software dedicate any and all copyright interest in the\nsoftware to the public domain. We make this dedication for the benefit\nof the public at large and to the detriment of our heirs and\nsuccessors. We intend this dedication to be an overt act of\nrelinquishment in perpetuity of all present and future rights to this\nsoftware under copyright law.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.\nIN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR\nOTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,\nARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR\nOTHER DEALINGS IN THE SOFTWARE.\n\nFor more information, please refer to <https://unlicense.org>\n".to_string(),
        _ => return Err(AppError::invalid_arg("licencia no soportada")),
    })
}

/// Nombres de plantillas de `.gitignore` y licencias disponibles en `init_repo`.
#[tauri::command]
pub async fn init_templates() -> Result<InitTemplates> {
    Ok(InitTemplates {
        gitignore: GITIGNORE_TEMPLATES.iter().map(|(n, _)| n.to_string()).collect(),
        licenses: LICENSES.iter().map(|s| s.to_string()).collect(),
    })
}

/// Crea (si falta) la carpeta e inicializa un repo. Devuelve la ruta final.
#[tauri::command]
pub async fn init_repo(path: String, default_branch: Option<String>, gitignore_template: Option<String>, license: Option<String>) -> Result<String> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::invalid_path("ruta vacía"));
    }
    let d = PathBuf::from(&path);
    if !d.is_absolute() || d.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::invalid_path("la ruta debe ser absoluta sin '..'"));
    }
    let branch = default_branch.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "main".into());
    validate_branch_name(&branch)?;
    let gi = match gitignore_template.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => Some(
            GITIGNORE_TEMPLATES
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(t))
                .map(|(_, c)| *c)
                .ok_or_else(|| AppError::invalid_arg("plantilla de .gitignore no soportada"))?,
        ),
        None => None,
    };
    let lic = license.filter(|l| !l.is_empty());
    if let Some(l) = lic.as_deref() {
        license_text(l, "x", 2000)?;
    }
    tokio::fs::create_dir_all(&d).await?;
    let canon = std::fs::canonicalize(&d)?;
    executor::write(&canon, &["init", "-b", &branch]).await?;
    if let Some(c) = gi {
        let f = canon.join(".gitignore");
        if !f.exists() {
            tokio::fs::write(&f, c).await?;
        }
    }
    if let Some(l) = lic.as_deref() {
        let holder = executor::read(&canon, &["config", "user.name"]).await.ok().and_then(trimmed).unwrap_or_else(|| "The authors".into());
        let f = canon.join("LICENSE");
        if !f.exists() {
            tokio::fs::write(&f, license_text(l, &holder, current_year())?).await?;
        }
    }
    Ok(display_path(&canon))
}

// ================================================================ remotos

#[tauri::command]
pub async fn list_remotes(repo_path: String) -> Result<Vec<RemoteInfo>> {
    let r = root(&repo_path).await?;
    let names = executor::read(&r, &["remote"]).await?;
    let mut out = Vec::new();
    for n in names.lines().map(str::trim).filter(|n| !n.is_empty()) {
        validate_remote(n)?;
        let fetch = executor::read(&r, &["remote", "get-url", n]).await.map(|s| s.trim().to_string()).unwrap_or_default();
        let push = executor::read(&r, &["remote", "get-url", "--push", n]).await.map(|s| s.trim().to_string()).unwrap_or_else(|_| fetch.clone());
        out.push(RemoteInfo { name: n.to_string(), fetch_url: mask_url(&fetch), push_url: mask_url(&push) });
    }
    Ok(out)
}

#[tauri::command]
pub async fn add_remote(repo_path: String, name: String, url: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&name)?;
    validate_url(&url)?;
    executor::write(&r, &["remote", "add", &name, &url]).await?;
    Ok(())
}

/// `push=true` cambia solo la URL de push.
#[tauri::command]
pub async fn set_remote_url(repo_path: String, name: String, url: String, push: Option<bool>) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&name)?;
    validate_url(&url)?;
    let mut a = vec!["remote", "set-url"];
    if push.unwrap_or(false) {
        a.push("--push");
    }
    a.extend([name.as_str(), url.as_str()]);
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_remote(repo_path: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&name)?;
    executor::write(&r, &["remote", "remove", &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_remote(repo_path: String, old: String, new: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&old)?;
    validate_remote(&new)?;
    executor::write(&r, &["remote", "rename", &old, &new]).await?;
    Ok(())
}

// ================================================================ ramas / tags / red

#[tauri::command]
pub async fn set_upstream(repo_path: String, branch: String, remote_branch: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&branch)?;
    validate_ref(&remote_branch)?;
    let flag = format!("--set-upstream-to={remote_branch}");
    executor::write(&r, &["branch", &flag, &branch]).await?;
    Ok(())
}

#[tauri::command]
pub async fn unset_upstream(repo_path: String, branch: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&branch)?;
    executor::write(&r, &["branch", "--unset-upstream", &branch]).await?;
    Ok(())
}

/// Avanza `name` (solo fast-forward) a `target` o, si falta, a su upstream, sin hacer checkout.
#[tauri::command]
pub async fn fast_forward_branch(repo_path: String, name: String, target: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&name)?;
    let target = match target.filter(|t| !t.is_empty()) {
        Some(t) => {
            validate_ref(&t)?;
            t
        }
        None => {
            let spec = format!("{name}@{{upstream}}");
            let up = executor::read(&r, &["rev-parse", "--abbrev-ref", &spec])
                .await
                .map_err(|_| AppError::invalid_arg("la rama no tiene upstream configurado"))?;
            up.trim().to_string()
        }
    };
    validate_ref(&target)?;
    let cur = executor::read(&r, &["symbolic-ref", "--short", "-q", "HEAD"]).await.ok().and_then(trimmed);
    tracked(&r, &format!("Fast-forward {name}"), async {
        if cur.as_deref() == Some(name.as_str()) {
            executor::write(&r, &["merge", "--ff-only", &target]).await?;
        } else {
            let local = format!("refs/heads/{name}");
            if executor::read(&r, &["show-ref", "--verify", "--quiet", &local]).await.is_err() {
                return Err(AppError::invalid_arg("la rama local no existe"));
            }
            if executor::read(&r, &["merge-base", "--is-ancestor", &local, &target]).await.is_err() {
                return Err(AppError::invalid_arg("no es posible fast-forward: las ramas han divergido"));
            }
            let tsha = executor::read(&r, &["rev-parse", "--verify", &format!("{target}^{{commit}}")]).await?;
            executor::write(&r, &["update-ref", &local, tsha.trim()]).await?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn push_branch(repo_path: String, remote: String, local: String, remote_branch: String, force: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&remote)?;
    validate_ref(&local)?;
    validate_branch_name(&remote_branch)?;
    let spec = format!("{local}:refs/heads/{remote_branch}");
    let mut a = vec!["push"];
    if force {
        a.push("--force-with-lease");
    }
    a.extend([remote.as_str(), spec.as_str()]);
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_branches(repo_path: String, names: Vec<String>, force: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    if names.is_empty() {
        return Err(AppError::invalid_arg("no se indicó ninguna rama"));
    }
    for n in &names {
        validate_ref(n)?;
    }
    tracked(&r, &format!("Borrar {} ramas", names.len()), async {
        let mut errors = Vec::new();
        for n in &names {
            if let Err(e) = executor::write(&r, &["branch", if force { "-D" } else { "-d" }, n]).await {
                errors.push(format!("{n}: {}", e.message));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::git_failed(errors.join("\n")))
        }
    })
    .await
}

#[tauri::command]
pub async fn delete_remote_tag(repo_path: String, remote: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&remote)?;
    validate_branch_name(&name)?;
    let spec = format!(":refs/tags/{name}");
    executor::write(&r, &["push", &remote, &spec]).await?;
    Ok(())
}

#[tauri::command]
pub async fn push_all_tags(repo_path: String, remote: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let remote = match remote.filter(|x| !x.is_empty()) {
        Some(x) => x,
        None => {
            let remotes = executor::read(&r, &["remote"]).await?;
            let list: Vec<&str> = remotes.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            let pick = if list.contains(&"origin") {
                "origin"
            } else {
                *list.first().ok_or_else(|| AppError::invalid_arg("el repositorio no tiene remotos"))?
            };
            pick.to_string()
        }
    };
    validate_remote(&remote)?;
    executor::write(&r, &["push", &remote, "--tags"]).await?;
    Ok(())
}

// ================================================================ operación en curso / conflictos

#[tauri::command]
pub async fn op_skip(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let op = commands::current_op(&r).await?;
    if op == "merge" {
        return Err(AppError::invalid_arg("un merge no se puede omitir (--skip)"));
    }
    executor::write_env(&r, &[op.as_str(), "--skip"], &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")]).await?;
    Ok(())
}

/// Resuelve un conflicto quedándose con `ours` o `theirs` y lo marca como resuelto.
#[tauri::command]
pub async fn resolve_with_side(repo_path: String, path: String, side: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    reject_dot_git(Path::new(&rel))?;
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(AppError::invalid_arg("side debe ser ours o theirs")),
    };
    match executor::write(&r, &["checkout", flag, "--", &rel]).await {
        Ok(_) => {
            executor::write(&r, &["add", "--", &rel]).await?;
        }
        Err(_) => {
            // Conflicto delete/modify: el lado elegido borró el archivo.
            executor::write(&r, &["rm", "-q", "--", &rel]).await?;
        }
    }
    Ok(())
}

// ================================================================ stash

/// Aplica solo `path` del stash `index` (sin dejarlo en stage).
#[tauri::command]
pub async fn stash_apply_file(repo_path: String, index: u32, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    reject_dot_git(Path::new(&rel))?;
    let st = format!("stash@{{{index}}}");
    let st3 = format!("stash@{{{index}}}^3");
    tracked(&r, "Aplicar archivo de stash", async {
        if executor::write(&r, &["checkout", &st, "--", &rel]).await.is_err() {
            // Archivo sin seguimiento: vive en el tercer padre del stash.
            executor::write(&r, &["checkout", &st3, "--", &rel]).await?;
        }
        if commands::has_head(&r).await {
            executor::write(&r, &["reset", "-q", "HEAD", "--", &rel]).await?;
        } else {
            executor::write(&r, &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", &rel]).await?;
        }
        Ok(())
    })
    .await
}

/// Cambia el mensaje del stash `index` conservando el orden.
#[tauri::command]
pub async fn stash_rename(repo_path: String, index: u32, message: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let msg = message.trim();
    if msg.is_empty() || message.contains('\0') || message.contains('\n') {
        return Err(AppError::invalid_arg("mensaje de stash no válido"));
    }
    let mut list = list_stashes_raw(&r).await;
    let i = index as usize;
    if i >= list.len() {
        return Err(AppError::invalid_arg("el stash no existe"));
    }
    let branch = list[i]
        .1
        .strip_prefix("WIP on ")
        .or_else(|| list[i].1.strip_prefix("On "))
        .and_then(|s| s.split_once(':'))
        .map(|(b, _)| b.to_string())
        .unwrap_or_else(|| "(no branch)".into());
    list[i].1 = format!("On {branch}: {msg}");
    tracked(&r, "Renombrar stash", restore_stashes(&r, &list)).await
}

#[tauri::command]
pub async fn clean_untracked(repo_path: String, paths: Option<Vec<String>>) -> Result<()> {
    let r = root(&repo_path).await?;
    let rs = match paths.filter(|p| !p.is_empty()) {
        Some(p) => {
            let rs = p.iter().map(|x| path_guard::safe_rel(&r, x)).collect::<Result<Vec<_>>>()?;
            for x in &rs {
                reject_dot_git(Path::new(x))?;
            }
            rs
        }
        None => Vec::new(),
    };
    let mut a = vec!["clean", "-f", "-d"];
    if !rs.is_empty() {
        a.push("--");
        a.extend(rs.iter().map(String::as_str));
    }
    tracked(&r, "Limpiar archivos sin seguimiento", async {
        executor::write(&r, &a).await?;
        Ok(())
    })
    .await
}

fn escape_ignore(s: &str) -> String {
    let mut pat = String::new();
    for (i, c) in s.chars().enumerate() {
        if (i == 0 && (c == '#' || c == '!')) || matches!(c, '*' | '?' | '[' | '\\') {
            pat.push('\\');
        }
        pat.push(c);
    }
    pat
}

/// Añade un patrón a `.gitignore` o a `.git/info/exclude`. `kind`: file | folder | extension.
#[tauri::command]
pub async fn ignore_pattern(repo_path: String, path: String, kind: String, target: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    reject_dot_git(Path::new(&rel))?;
    if rel.contains('\n') || rel.contains('\r') {
        return Err(AppError::invalid_path("la ruta contiene saltos de línea"));
    }
    let line = match kind.as_str() {
        "file" => format!("/{}", escape_ignore(&rel)),
        "folder" => {
            let full = path_guard::safe_join(&r, &rel)?;
            let dir = if full.is_dir() { rel.clone() } else { rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default() };
            if dir.is_empty() {
                return Err(AppError::invalid_arg("el archivo está en la raíz: no hay carpeta que ignorar"));
            }
            format!("/{}/", escape_ignore(&dir))
        }
        "extension" => {
            let name = rel.rsplit('/').next().unwrap_or(&rel);
            match name.rsplit_once('.') {
                Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => format!("*.{}", escape_ignore(ext)),
                _ => return Err(AppError::invalid_arg("el archivo no tiene extensión")),
            }
        }
        _ => return Err(AppError::invalid_arg("kind debe ser file, folder o extension")),
    };
    let file = match target.as_str() {
        "gitignore" => path_guard::safe_join(&r, ".gitignore")?,
        "local" => {
            let p = executor::read(&r, &["rev-parse", "--git-path", "info/exclude"]).await?;
            let p = PathBuf::from(p.trim_end_matches(['\n', '\r']));
            let p = if p.is_absolute() { p } else { r.join(p) };
            if let Some(parent) = p.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            p
        }
        _ => return Err(AppError::invalid_arg("target debe ser gitignore o local")),
    };
    let mut content = match tokio::fs::read_to_string(&file).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if content.lines().any(|l| l.trim_end() == line) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&line);
    content.push('\n');
    tokio::fs::write(&file, content).await?;
    Ok(())
}

// ================================================================ archivos y blobs

/// Contenido binario en base64 (límite 20 MB). `rev`: sha/ref, `INDEX` o `WORKTREE`.
#[tauri::command]
pub async fn get_file_blob_base64(repo_path: String, rev: String, path: String) -> Result<BlobData> {
    let r = root(&repo_path).await?;
    let (bytes, rel) = blob_bytes(&r, &rev, &path, MAX_BLOB).await?;
    Ok(BlobData { size: bytes.len() as u64, mime: mime_of(&rel).to_string(), base64: base64(&bytes) })
}

/// Texto de un archivo en una revisión (`INDEX` y `WORKTREE` también valen). Máx. 10 MB.
#[tauri::command]
pub async fn show_file(repo_path: String, rev: String, path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    let (bytes, _) = blob_bytes(&r, &rev, &path, MAX_TEXT).await?;
    if bytes.contains(&0) {
        return Err(AppError::invalid_arg("el archivo es binario"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn read_file(repo_path: String, path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    let (bytes, _) = blob_bytes(&r, "WORKTREE", &path, MAX_TEXT).await?;
    if bytes.contains(&0) {
        return Err(AppError::invalid_arg("el archivo es binario"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn write_file(repo_path: String, path: String, content: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let (_, full) = rel_inside(&r, &path).await?;
    if content.len() as u64 > MAX_TEXT {
        return Err(AppError::invalid_arg("el contenido supera el límite de tamaño"));
    }
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent).await?;
        // Revalida tras crear carpetas (symlinks).
        let canon = std::fs::canonicalize(parent)?;
        if !canon.starts_with(&r) {
            return Err(AppError::invalid_path("la ruta queda fuera del repositorio"));
        }
    }
    tokio::fs::write(&full, content.as_bytes()).await?;
    Ok(())
}

// ================================================================ configuración

fn parse_config_z(out: &str) -> HashMap<String, String> {
    out.split('\0')
        .filter(|r| !r.is_empty())
        .map(|r| match r.split_once('\n') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.to_string()),
            None => (r.to_ascii_lowercase(), String::new()),
        })
        .collect()
}

#[tauri::command]
pub async fn get_repo_config(repo_path: String) -> Result<Vec<ConfigEntry>> {
    let r = root(&repo_path).await?;
    let local = parse_config_z(&executor::read(&r, &["config", "--local", "--list", "-z"]).await.unwrap_or_default());
    let eff = parse_config_z(&executor::read(&r, &["config", "--list", "-z"]).await.unwrap_or_default());
    Ok(CONFIG_KEYS
        .iter()
        .map(|k| ConfigEntry { key: k.to_string(), local: local.get(*k).cloned(), effective: eff.get(*k).cloned() })
        .collect())
}

/// `value=None` elimina la clave del `.git/config` del repo.
#[tauri::command]
pub async fn set_repo_config(repo_path: String, key: String, value: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_config_key(&key)?;
    match value {
        Some(v) => {
            validate_config_value(&key, &v)?;
            executor::write(&r, &["config", "--local", "--", &key, &v]).await?;
        }
        None => {
            // Código 5 = la clave no existía: nada que borrar.
            let _ = executor::write(&r, &["config", "--local", "--unset", "--", &key]).await;
        }
    }
    Ok(())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Plantilla de commit (`commit.template`) dividida en resumen y descripción.
#[tauri::command]
pub async fn get_commit_template(repo_path: String) -> Result<Option<CommitTemplate>> {
    let r = root(&repo_path).await?;
    let Ok(p) = executor::read(&r, &["config", "--type=path", "--get", "commit.template"]).await else {
        return Ok(None);
    };
    let p = p.trim_end_matches(['\n', '\r']);
    if p.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(p);
    let path = if path.is_absolute() { path } else { r.join(path) };
    let Ok(canon) = std::fs::canonicalize(&path) else { return Ok(None) };
    let in_home = home_dir().and_then(|h| std::fs::canonicalize(h).ok()).is_some_and(|h| canon.starts_with(&h));
    let sensitive = canon.components().any(|c| matches!(c.as_os_str().to_str(), Some(".ssh" | ".gnupg" | ".aws" | ".kube" | ".docker")));
    if !(canon.starts_with(&r) || in_home) || sensitive {
        return Err(AppError::invalid_path("la plantilla de commit debe estar en el repo o en tu carpeta personal"));
    }
    let meta = tokio::fs::metadata(&canon).await?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&tokio::fs::read(&canon).await?).into_owned();
    let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).collect();
    let body = lines.join("\n");
    let body = body.trim_matches('\n');
    if body.trim().is_empty() {
        return Ok(None);
    }
    let (summary, description) = match body.split_once('\n') {
        Some((s, d)) => (s.trim().to_string(), d.trim().to_string()),
        None => (body.trim().to_string(), String::new()),
    };
    Ok(Some(CommitTemplate { summary, description }))
}

// ================================================================ editar mensaje

/// Cambia el mensaje de `sha`. HEAD: `commit --amend`; antiguos: rebase scriptado (sin merges en medio).
#[tauri::command]
pub async fn edit_commit_message(repo_path: String, sha: String, message: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    if message.trim().is_empty() || message.contains('\0') {
        return Err(AppError::invalid_arg("el mensaje no puede estar vacío"));
    }
    let mut msg = message.trim().to_string();
    msg.push('\n');
    let full = executor::read(&r, &["rev-parse", "--verify", &format!("{sha}^{{commit}}")])
        .await
        .map_err(|_| AppError::invalid_arg("commit no encontrado"))?;
    let full = full.trim().to_string();
    let head = executor::read(&r, &["rev-parse", "--verify", "HEAD"]).await?;
    tracked(&r, "Editar mensaje de commit", async {
        if head.trim() == full {
            // `--only` sin rutas: solo cambia el mensaje, lo que haya en stage no entra.
            executor::write_stdin(&r, &["commit", "--amend", "--only", "--allow-empty", "-F", "-"], msg.as_bytes()).await?;
            return Ok(());
        }
        if executor::read(&r, &["merge-base", "--is-ancestor", &full, "HEAD"]).await.is_err() {
            return Err(AppError::invalid_arg("el commit no está en la rama actual"));
        }
        let parent = executor::read(&r, &["rev-parse", "--verify", &format!("{full}^")])
            .await
            .map_err(|_| AppError::invalid_arg("no se puede editar el mensaje del commit inicial"))?;
        let parent = parent.trim().to_string();
        let range = format!("{parent}..HEAD");
        let merges = executor::read(&r, &["rev-list", "--merges", &range]).await?;
        if !merges.trim().is_empty() {
            return Err(AppError::invalid_arg("hay merges entre ese commit y HEAD: no se puede reescribir con seguridad"));
        }
        let list = executor::read(&r, &["log", "--reverse", "--format=%H%x00%s", &range]).await?;
        let mut items: Vec<RebaseTodoItem> = list
            .lines()
            .filter_map(|l| l.split_once('\0'))
            .map(|(s, subj)| RebaseTodoItem { action: "pick".into(), sha: s.to_string(), subject: subj.to_string(), new_message: None })
            .collect();
        let first = items.iter_mut().find(|i| i.sha == full).ok_or_else(|| AppError::invalid_arg("commit no encontrado en el rango"))?;
        first.action = "reword".into();
        first.new_message = Some(msg.clone());
        commands::scripted_rebase(&r, &parent, &items, true).await
    })
    .await
}

// ================================================================ apertura externa

/// Abre una terminal en el repo. En Windows es la única función con consola visible (CREATE_NEW_CONSOLE).
#[tauri::command]
pub async fn open_in_terminal(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let dir = display_path(&r);
    if cfg!(target_os = "macos") {
        executor::spawn_detached("open", &["-a", "Terminal", &dir], None, false)
    } else if cfg!(windows) {
        match executor::spawn_detached("wt.exe", &["-d", &dir], None, false) {
            Ok(()) => Ok(()),
            Err(_) => executor::spawn_detached("cmd.exe", &[], Some(&r), true),
        }
    } else {
        let wd = format!("--working-directory={dir}");
        let wd2 = format!("--workdir={dir}");
        let candidates: Vec<(&str, Vec<&str>)> = vec![
            ("x-terminal-emulator", vec![]),
            ("gnome-terminal", vec![wd.as_str()]),
            ("konsole", vec![wd2.as_str()]),
            ("xfce4-terminal", vec![wd.as_str()]),
            ("alacritty", vec![wd.as_str()]),
            ("kitty", vec!["--directory", dir.as_str()]),
            ("xterm", vec![]),
        ];
        for (prog, args) in candidates {
            if executor::spawn_detached(prog, &args, Some(&r), false).is_ok() {
                return Ok(());
            }
        }
        Err(AppError::io("no se encontró ningún emulador de terminal"))
    }
}

/// Muestra el repo (o `path` dentro de él) en el gestor de archivos.
#[tauri::command]
pub async fn reveal_in_file_manager(repo_path: String, path: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let target = match path.filter(|p| !p.is_empty()) {
        Some(p) => path_guard::safe_join(&r, &p)?,
        None => r.clone(),
    };
    let t = display_path(&target);
    let is_file = target.is_file();
    if cfg!(target_os = "macos") {
        if is_file {
            executor::spawn_detached("open", &["-R", &t], None, false)
        } else {
            executor::spawn_detached("open", &[&t], None, false)
        }
    } else if cfg!(windows) {
        if is_file {
            executor::spawn_detached("explorer.exe", &[&format!("/select,{t}")], None, false)
        } else {
            executor::spawn_detached("explorer.exe", &[&t], None, false)
        }
    } else {
        let dir = if is_file { target.parent().map(display_path).unwrap_or(t) } else { t };
        executor::spawn_detached("xdg-open", &[&dir], None, false)
    }
}

/// Editores admitidos: (clave, app de macOS, ejecutable CLI).
const EDITORS: &[(&str, &str, &str)] = &[
    ("code", "Visual Studio Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("windsurf", "Windsurf", "windsurf"),
    ("zed", "Zed", "zed"),
    ("subl", "Sublime Text", "subl"),
    ("idea", "IntelliJ IDEA", "idea"),
    ("webstorm", "WebStorm", "webstorm"),
    ("pycharm", "PyCharm", "pycharm"),
];

/// Abre `path` en un editor de la lista blanca o, sin `editor`, en el editor de texto del sistema.
#[tauri::command]
pub async fn open_in_editor(repo_path: String, path: String, editor: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let (_, full) = rel_inside(&r, &path).await?;
    let f = display_path(&full);
    match editor.as_deref().filter(|e| !e.is_empty()) {
        Some(key) => {
            let (_, app, cli) = EDITORS.iter().find(|(k, _, _)| *k == key).ok_or_else(|| AppError::invalid_arg("editor no soportado"))?;
            if cfg!(target_os = "macos") {
                executor::spawn_detached("open", &["-a", app, &f], None, false)
            } else if cfg!(windows) {
                executor::spawn_detached(&format!("{cli}.cmd"), &[&f], Some(&r), false)
            } else {
                executor::spawn_detached(cli, &[&f], Some(&r), false)
            }
        }
        None => {
            // `open -t` / notepad abren el archivo como texto: nunca lo ejecutan.
            if cfg!(target_os = "macos") {
                executor::spawn_detached("open", &["-t", &f], None, false)
            } else if cfg!(windows) {
                executor::spawn_detached("notepad.exe", &[&f], None, false)
            } else {
                executor::spawn_detached("xdg-open", &[&f], None, false)
            }
        }
    }
}

async fn tool_configured(root: &Path, key: &str) -> bool {
    executor::read(root, &["config", "--get", key]).await.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

#[tauri::command]
pub async fn run_difftool(repo_path: String, path: String, staged: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    let (rel, _) = rel_inside(&r, &path).await?;
    if !tool_configured(&r, "diff.tool").await {
        return Err(AppError::invalid_arg("no hay herramienta de diff configurada (diff.tool)"));
    }
    let mut a = vec!["difftool", "--no-prompt"];
    if staged {
        a.push("--staged");
    }
    a.extend(["--", &rel]);
    executor::spawn_detached("git", &a, Some(&r), false)
}

#[tauri::command]
pub async fn run_mergetool(repo_path: String, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let (rel, _) = rel_inside(&r, &path).await?;
    if !tool_configured(&r, "merge.tool").await {
        return Err(AppError::invalid_arg("no hay herramienta de merge configurada (merge.tool)"));
    }
    executor::spawn_detached("git", &["mergetool", "--no-prompt", "--", &rel], Some(&r), false)
}

// ================================================================ registro / comparar / autores

/// Últimos comandos git ejecutados (más recientes primero). `limit` por defecto 200.
#[tauri::command]
pub async fn get_activity_log(limit: Option<u32>) -> Result<Vec<ActivityEntry>> {
    Ok(executor::activity_log(limit.unwrap_or(200).clamp(1, 500) as usize))
}

async fn check_rev(root: &Path, r: &str) -> Result<()> {
    validate_ref(r)?;
    executor::read(root, &["rev-parse", "--verify", "-q", &format!("{r}^{{commit}}")])
        .await
        .map(|_| ())
        .map_err(|_| AppError::invalid_arg(format!("revisión no encontrada: {r}")))
}

/// Archivos que difieren entre `a` y `b` (`git diff a b`), sin hunks.
#[tauri::command]
pub async fn compare_refs(repo_path: String, a: String, b: String) -> Result<Vec<DiffFile>> {
    let r = root(&repo_path).await?;
    check_rev(&r, &a).await?;
    check_rev(&r, &b).await?;
    let out = executor::read(&r, &["diff", "--no-color", "--no-ext-diff", "-M", &a, &b]).await?;
    let mut files = parsers::parse_diff(&out);
    for f in &mut files {
        f.hunks.clear();
    }
    Ok(files)
}

/// Diff de un archivo entre `a` y `b` (con hunks).
#[tauri::command]
pub async fn compare_file_diff(
    repo_path: String,
    a: String,
    b: String,
    path: String,
    ignore_whitespace: Option<bool>,
    context_lines: Option<u32>,
    word_diff: Option<bool>,
) -> Result<DiffFile> {
    let r = root(&repo_path).await?;
    check_rev(&r, &a).await?;
    check_rev(&r, &b).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let ctx = commands::context_arg(context_lines);
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M"];
    if let Some(c) = ctx.as_deref() {
        args.push(c);
    }
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
    args.extend([a.as_str(), b.as_str(), "--", rel.as_str()]);
    let out = executor::read(&r, &args).await?;
    let mut f = parsers::parse_diff(&out).into_iter().next().unwrap_or_else(|| commands::empty_diff(&rel));
    if word_diff.unwrap_or(false) {
        parsers::apply_word_diff(std::slice::from_mut(&mut f));
    }
    Ok(f)
}

/// ¿`a` es ancestro de `b`?
#[tauri::command]
pub async fn is_ancestor(repo_path: String, a: String, b: String) -> Result<bool> {
    let r = root(&repo_path).await?;
    check_rev(&r, &a).await?;
    check_rev(&r, &b).await?;
    Ok(executor::read(&r, &["merge-base", "--is-ancestor", &a, &b]).await.is_ok())
}

#[tauri::command]
pub async fn list_authors(repo_path: String) -> Result<Vec<AuthorInfo>> {
    let r = root(&repo_path).await?;
    if !commands::has_head(&r).await {
        return Ok(vec![]);
    }
    let out = executor::read(&r, &["shortlog", "-s", "-n", "-e", "--all"]).await?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let (n, rest) = l.trim().split_once('\t')?;
            let rest = rest.trim();
            let (name, email) = match rest.rfind(" <") {
                Some(i) => (rest[..i].trim().to_string(), rest[i + 2..].trim_end_matches('>').to_string()),
                None => (rest.to_string(), String::new()),
            };
            Some(AuthorInfo { name, email, count: n.trim().parse().ok()? })
        })
        .collect())
}

// ================================================================ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands as c;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn init() -> (tempfile::TempDir, String) {
        let td = tempfile::tempdir().unwrap();
        let d = td.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.name", "Test"]);
        sh(d, &["config", "user.email", "t@example.com"]);
        sh(d, &["config", "commit.gpgsign", "false"]);
        let p = d.to_string_lossy().into_owned();
        (td, p)
    }

    async fn commit_file(p: &str, d: &Path, name: &str, content: &str, msg: &str) -> String {
        std::fs::write(d.join(name), content).unwrap();
        c::stage_all(p.into()).await.unwrap();
        c::commit(p.into(), msg.into(), String::new(), false, None, None, None, None).await.unwrap()
    }

    fn head(d: &Path) -> String {
        sh(d, &["rev-parse", "HEAD"]).trim().to_string()
    }

    #[tokio::test]
    async fn undo_redo_commit_checkout_stage() {
        let (td, p) = init();
        let d = td.path();
        let first = commit_file(&p, d, "a.txt", "uno\n", "primero").await;
        // commit: undo/redo
        let second = commit_file(&p, d, "b.txt", "b\n", "segundo").await;
        let st = undo_state(p.clone()).await.unwrap();
        assert_eq!(st.undo_label.as_deref(), Some("Commit"));
        assert!(st.redo_label.is_none());
        undo_action(p.clone()).await.unwrap(); // deshace commit
        assert_eq!(head(d), first);
        undo_action(p.clone()).await.unwrap(); // deshace stage todo
        let status = c::get_status(p.clone()).await.unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(!status.files[0].staged && status.files[0].worktree == '?');
        assert!(d.join("b.txt").exists(), "el archivo sin seguimiento se conserva");
        redo_action(p.clone()).await.unwrap(); // rehace stage
        assert!(c::get_status(p.clone()).await.unwrap().files[0].staged);
        redo_action(p.clone()).await.unwrap(); // rehace commit
        assert_eq!(head(d), second);
        assert!(redo_action(p.clone()).await.is_err());

        // checkout con rama nueva
        c::create_branch(p.clone(), "feat".into(), None, true).await.unwrap();
        commit_file(&p, d, "c.txt", "c\n", "en feat").await;
        c::checkout(p.clone(), "main".into(), false).await.unwrap();
        assert!(!d.join("c.txt").exists());
        let lbl = undo_action(p.clone()).await.unwrap();
        assert_eq!(lbl, "Checkout main");
        assert!(d.join("c.txt").exists());
        assert_eq!(sh(d, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat");
        redo_action(p.clone()).await.unwrap();
        assert_eq!(sh(d, &["symbolic-ref", "--short", "HEAD"]).trim(), "main");

        // borrar rama + deshacer la recupera
        c::delete_branch(p.clone(), "feat".into(), true).await.unwrap();
        assert!(sh(d, &["branch", "--list", "feat"]).trim().is_empty());
        undo_action(p.clone()).await.unwrap();
        assert!(!sh(d, &["branch", "--list", "feat"]).trim().is_empty());

        // descartar cambios con archivo sin seguimiento
        std::fs::write(d.join("nuevo.txt"), "hola\n").unwrap();
        std::fs::write(d.join("a.txt"), "cambiado\n").unwrap();
        c::discard_all(p.clone()).await.unwrap();
        assert!(!d.join("nuevo.txt").exists());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "uno\n");
        undo_action(p.clone()).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("nuevo.txt")).unwrap(), "hola\n");
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "cambiado\n");

        // un comando que no cambia nada no deja entrada
        let before = undo_state(p.clone()).await.unwrap().undo_label;
        let _ = c::checkout(p.clone(), "no-existe".into(), false).await;
        assert_eq!(undo_state(p.clone()).await.unwrap().undo_label, before);
    }

    #[tokio::test]
    async fn undo_stash_y_merge_conflicto() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "1\n", "base").await;
        std::fs::write(d.join("a.txt"), "2\n").unwrap();
        c::stash_push(p.clone(), Some("uno".into()), None, None, None, None).await.unwrap();
        assert_eq!(c::list_stashes(p.clone()).await.unwrap().len(), 1);
        c::stash_drop(p.clone(), 0).await.unwrap();
        assert!(c::list_stashes(p.clone()).await.unwrap().is_empty());
        undo_action(p.clone()).await.unwrap(); // recupera el stash
        assert_eq!(c::list_stashes(p.clone()).await.unwrap().len(), 1);
        undo_action(p.clone()).await.unwrap(); // deshace el stash: el cambio vuelve
        assert!(c::list_stashes(p.clone()).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "2\n");
        c::discard_all(p.clone()).await.unwrap();

        // merge con conflicto: undo aborta y vuelve al estado previo
        c::create_branch(p.clone(), "x".into(), None, true).await.unwrap();
        commit_file(&p, d, "a.txt", "x\n", "en x").await;
        c::checkout(p.clone(), "main".into(), false).await.unwrap();
        let on_main = commit_file(&p, d, "a.txt", "m\n", "en main").await;
        assert!(c::merge_branch(p.clone(), "x".into(), None).await.is_err());
        assert_eq!(c::get_status(p.clone()).await.unwrap().operation.as_deref(), Some("merge"));
        undo_action(p.clone()).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert!(st.operation.is_none() && st.files.is_empty());
        assert_eq!(head(d), on_main);
    }

    #[tokio::test]
    async fn merge_modes_y_cherry_pick_multiple() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "1\n", "base").await;
        c::create_branch(p.clone(), "f".into(), None, true).await.unwrap();
        let s1 = commit_file(&p, d, "f1.txt", "1\n", "f1").await;
        let s2 = commit_file(&p, d, "f2.txt", "2\n", "f2").await;
        c::checkout(p.clone(), "main".into(), false).await.unwrap();

        // ff-only avanza
        c::merge_branch(p.clone(), "f".into(), Some("ff-only".into())).await.unwrap();
        assert_eq!(head(d), s2);
        sh(d, &["reset", "--hard", "-q", "HEAD~2"]);

        // no-ff crea merge commit aunque pueda ff
        c::merge_branch(p.clone(), "f".into(), Some("no-ff".into())).await.unwrap();
        let parents = sh(d, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3);
        sh(d, &["reset", "--hard", "-q", "HEAD~1"]);

        // squash: deja los cambios en stage sin commit
        c::merge_branch(p.clone(), "f".into(), Some("squash".into())).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().all(|f| f.staged));
        sh(d, &["reset", "--hard", "-q", "HEAD"]);
        assert!(c::merge_branch(p.clone(), "f".into(), Some("raro".into())).await.is_err());

        // cherry-pick de varios (en orden inverso al pedirlos: se ordenan topológicamente)
        sh(d, &["checkout", "-q", "-b", "dest", "main"]);
        c::cherry_pick(p.clone(), vec![s2.clone(), s1.clone()]).await.unwrap();
        let log = sh(d, &["log", "--format=%s", "-3"]);
        assert_eq!(log.lines().collect::<Vec<_>>(), vec!["f2", "f1", "base"]);
        assert_eq!(undo_state(p.clone()).await.unwrap().undo_label.as_deref(), Some("Cherry-pick de 2 commits"));

        // revert múltiple y --no-commit
        c::revert_commit(p.clone(), vec![s1.clone(), s2.clone()], Some(true)).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.len(), 2);
        sh(d, &["reset", "--hard", "-q"]);
        c::revert_commit(p.clone(), vec![s2.clone()], None).await.unwrap();
        assert_eq!(sh(d, &["log", "--format=%s", "-1"]).trim(), "Revert \"f2\"");
    }

    #[tokio::test]
    async fn stash_untracked_y_paths() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "1\n", "base").await;
        commit_file(&p, d, "b.txt", "1\n", "base2").await;
        std::fs::write(d.join("a.txt"), "2\n").unwrap();
        std::fs::write(d.join("b.txt"), "2\n").unwrap();
        std::fs::write(d.join("u.txt"), "u\n").unwrap();
        // solo paths
        c::stash_push(p.clone(), Some("solo a".into()), None, None, None, Some(vec!["a.txt".into()])).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["b.txt", "u.txt"]);
        // sin untracked
        c::stash_push(p.clone(), Some("sin u".into()), Some(false), None, None, None).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, "u.txt");
        // con untracked (por defecto)
        c::stash_push(p.clone(), Some("con u".into()), None, None, None, None).await.unwrap();
        assert!(c::get_status(p.clone()).await.unwrap().files.is_empty());
        assert!(!d.join("u.txt").exists());
        // aplicar un archivo del stash (el untracked está en ^3)
        stash_apply_file(p.clone(), 0, "u.txt".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("u.txt")).unwrap(), "u\n");
        assert_eq!(std::fs::read_to_string(d.join("b.txt")).unwrap(), "1\n");
        sh(d, &["clean", "-fdq"]);
        // renombrar conserva orden
        stash_rename(p.clone(), 1, "renombrado".into()).await.unwrap();
        let l = c::list_stashes(p.clone()).await.unwrap();
        assert_eq!(l.len(), 3);
        assert!(l[1].message.contains("renombrado"), "{:?}", l[1].message);
        assert!(l[0].message.contains("con u") && l[2].message.contains("solo a"));
        undo_action(p.clone()).await.unwrap();
        assert!(c::list_stashes(p.clone()).await.unwrap()[1].message.contains("sin u"));
        // stash solo staged
        std::fs::write(d.join("a.txt"), "3\n").unwrap();
        std::fs::write(d.join("b.txt"), "3\n").unwrap();
        c::stage_paths(p.clone(), vec!["a.txt".into()]).await.unwrap();
        c::stash_push(p.clone(), None, None, None, Some(true), None).await.unwrap();
        let st = c::get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["b.txt"]);
    }

    #[tokio::test]
    async fn clone_local_y_remotes() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "1\n", "base").await;
        let dest_root = tempfile::tempdir().unwrap();
        let dest = dest_root.path().join("clon").to_string_lossy().into_owned();
        let mut events = Vec::new();
        let out = clone_inner(&p, &dest, None, false, None, |e| events.push(e)).await.unwrap();
        assert!(Path::new(&out).join(".git").exists());
        assert!(events.last().is_some_and(|e| e.percent == 100 && e.op == "clone"));
        // destino no vacío
        assert!(clone_inner(&p, &dest, None, false, None, |_| {}).await.is_err());
        // URL maliciosa
        assert!(clone_inner("--upload-pack=touch /tmp/x", &dest, None, false, None, |_| {}).await.is_err());
        assert!(clone_inner("ext::sh -c id", &dest, None, false, None, |_| {}).await.is_err());

        // remotos
        let cp = out.clone();
        let rs = list_remotes(cp.clone()).await.unwrap();
        assert_eq!(rs.len(), 1);
        assert_eq!(rs[0].name, "origin");
        add_remote(cp.clone(), "up".into(), "https://user:secret@example.com/a/b.git".into()).await.unwrap();
        let rs = list_remotes(cp.clone()).await.unwrap();
        let up = rs.iter().find(|r| r.name == "up").unwrap();
        assert_eq!(up.fetch_url, "https://user@example.com/a/b.git");
        set_remote_url(cp.clone(), "up".into(), "https://example.com/c/d.git".into(), None).await.unwrap();
        set_remote_url(cp.clone(), "up".into(), "https://example.com/push.git".into(), Some(true)).await.unwrap();
        let up = list_remotes(cp.clone()).await.unwrap().into_iter().find(|r| r.name == "up").unwrap();
        assert_eq!((up.fetch_url.as_str(), up.push_url.as_str()), ("https://example.com/c/d.git", "https://example.com/push.git"));
        rename_remote(cp.clone(), "up".into(), "otro".into()).await.unwrap();
        remove_remote(cp.clone(), "otro".into()).await.unwrap();
        assert_eq!(list_remotes(cp.clone()).await.unwrap().len(), 1);
        assert!(add_remote(cp.clone(), "x".into(), "--exec=1".into()).await.is_err());

        // upstream, fast-forward sin checkout, push de rama / tags
        let cdir = PathBuf::from(&cp);
        sh(&cdir, &["config", "user.name", "T"]);
        sh(&cdir, &["config", "user.email", "t@e.com"]);
        sh(&cdir, &["config", "commit.gpgsign", "false"]);
        sh(&cdir, &["checkout", "-q", "-b", "rama"]);
        unset_upstream(cp.clone(), "main".into()).await.unwrap();
        set_upstream(cp.clone(), "main".into(), "origin/main".into()).await.unwrap();
        let s2 = commit_file(&p, d, "b.txt", "2\n", "nuevo en origen").await;
        c::fetch(cp.clone(), false, false).await.unwrap();
        fast_forward_branch(cp.clone(), "main".into(), None).await.unwrap();
        assert_eq!(sh(&cdir, &["rev-parse", "main"]).trim(), s2);
        assert_eq!(sh(&cdir, &["symbolic-ref", "--short", "HEAD"]).trim(), "rama", "sin checkout");
        // origin es un repo no-bare con main en checkout: se empuja a otra rama
        push_branch(cp.clone(), "origin".into(), "rama".into(), "pub".into(), false).await.unwrap();
        assert!(!sh(d, &["branch", "--list", "pub"]).trim().is_empty());
        c::create_tag(cp.clone(), "v1".into(), None, None).await.unwrap();
        push_all_tags(cp.clone(), None).await.unwrap();
        assert!(!sh(d, &["tag", "--list", "v1"]).trim().is_empty());
        delete_remote_tag(cp.clone(), "origin".into(), "v1".into()).await.unwrap();
        assert!(sh(d, &["tag", "--list", "v1"]).trim().is_empty());
        delete_branches(cp.clone(), vec!["main".into(), "no-existe".into()], true).await.unwrap_err();
        assert!(sh(&cdir, &["branch", "--list", "main"]).trim().is_empty(), "main se borró aunque otra fallase");
        // push con opciones
        c::push(cp.clone(), false, true, Some(true), Some(false), Some(true), None).await.unwrap();
        c::push(cp.clone(), false, false, None, None, None, Some("lease".into())).await.unwrap();
        assert!(c::push(cp.clone(), false, false, None, None, None, Some("x".into())).await.is_err());
    }

    #[tokio::test]
    async fn init_repo_con_plantillas() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("nuevo/sub").to_string_lossy().into_owned();
        let out = init_repo(dir.clone(), Some("trunk".into()), Some("rust".into()), Some("MIT".into())).await.unwrap();
        let o = Path::new(&out);
        assert_eq!(sh(o, &["symbolic-ref", "--short", "HEAD"]).trim(), "trunk");
        assert!(std::fs::read_to_string(o.join(".gitignore")).unwrap().contains("/target"));
        assert!(std::fs::read_to_string(o.join("LICENSE")).unwrap().starts_with("MIT License"));
        assert!(init_repo(dir.clone(), Some("-x".into()), None, None).await.is_err());
        assert!(init_repo(dir, None, Some("nope".into()), None).await.is_err());
        let t = init_templates().await.unwrap();
        assert!(t.gitignore.contains(&"Node".to_string()) && t.licenses.contains(&"ISC".to_string()));
        for l in t.licenses.iter().filter(|l| *l != "Unlicense") {
            assert!(license_text(l, "Yo", 2026).unwrap().contains("Yo"));
        }
    }

    #[tokio::test]
    async fn grafo_filtros_stashes_y_diff() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "uno dos\n", "primero").await;
        commit_file(&p, d, "b.txt", "b\n", "segundo").await;
        sh(d, &["checkout", "-q", "-b", "f"]);
        commit_file(&p, d, "c.txt", "c\n", "en f").await;
        sh(d, &["checkout", "-q", "main"]);
        let g = |inc: Option<Vec<String>>, exc: Option<Vec<String>>, grep: Option<String>, path: Option<String>, px: Option<String>, st: Option<bool>| {
            let p = p.clone();
            async move { c::get_graph(p, 0, 50, false, inc, exc, None, path, grep, None, px, None, st).await.unwrap() }
        };
        assert_eq!(g(None, None, None, None, None, None).await.rows.len(), 3);
        assert_eq!(g(None, Some(vec!["f".into()]), None, None, None, None).await.rows.len(), 2);
        assert_eq!(g(Some(vec!["f".into()]), None, None, None, None, None).await.rows.len(), 3);
        assert_eq!(g(None, None, Some("segundo".into()), None, None, None).await.rows.len(), 1);
        assert_eq!(g(None, None, None, Some("c.txt".into()), None, None).await.rows.len(), 1);
        assert_eq!(g(None, None, None, None, Some("uno dos".into()), None).await.rows.len(), 1);
        // stashes como nodos
        std::fs::write(d.join("a.txt"), "cambio\n").unwrap();
        std::fs::write(d.join("u.txt"), "u\n").unwrap();
        c::stash_push(p.clone(), Some("s".into()), None, None, None, None).await.unwrap();
        let page = g(None, None, None, None, None, Some(true)).await;
        assert_eq!(page.rows.len(), 4, "3 commits + 1 stash (sin commits internos)");
        let stash_row = page.rows.iter().find(|r| r.commit.refs.iter().any(|x| x.kind == "stash")).unwrap();
        assert_eq!(stash_row.commit.parents.len(), 1);
        assert_eq!(g(None, None, None, None, None, None).await.rows.len(), 3);
        assert!(c::get_graph(p.clone(), 0, 10, false, Some(vec!["--all".into()]), None, None, None, None, None, None, None, None).await.is_err());

        // diff: contexto y palabras
        std::fs::write(d.join("a.txt"), "uno TRES\n").unwrap();
        let df = c::get_file_diff(p.clone(), "a.txt".into(), false, false, Some(0), Some(true)).await.unwrap();
        let del = &df.hunks[0].lines[0];
        assert_eq!(del.kind, "del");
        assert!(del.words.as_ref().unwrap().iter().any(|w| w.changed && w.text == "dos"));
        let df = c::get_file_diff(p.clone(), "a.txt".into(), false, false, None, None).await.unwrap();
        assert!(df.hunks[0].lines[0].words.is_none());
        // status: detached / worktree
        let st = c::get_status(p.clone()).await.unwrap();
        assert!(!st.detached && st.worktree_name.is_none());
        sh(d, &["stash", "-q", "-u"]);
        sh(d, &["checkout", "-q", "--detach"]);
        assert!(c::get_status(p.clone()).await.unwrap().detached);
        let wt = td.path().parent().unwrap().join("wt-test-r1");
        let _ = std::fs::remove_dir_all(&wt);
        sh(d, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "wt"]);
        let st = c::get_status(wt.to_string_lossy().into_owned()).await.unwrap();
        assert_eq!(st.worktree_name.as_deref(), Some("wt-test-r1"));
        let _ = std::fs::remove_dir_all(wt);
    }

    #[tokio::test]
    async fn busqueda_y_commit_opciones() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "alfa\n", "primero").await;
        std::fs::write(d.join("b.txt"), "beta\n").unwrap();
        c::stage_all(p.clone()).await.unwrap();
        c::commit(p.clone(), "segundo".into(), "detalle".into(), false, Some(true), Some(true), Some(vec!["Ana <ana@x.com>".into()]), Some(false))
            .await
            .unwrap();
        let body = sh(d, &["log", "-1", "--format=%B"]);
        assert!(body.contains("Co-authored-by: Ana <ana@x.com>") && body.contains("Signed-off-by: Test <t@example.com>"));
        assert!(c::commit(p.clone(), "x".into(), String::new(), false, None, None, Some(vec!["sin-correo".into()]), None).await.is_err());
        let s = |q: &str, scope: &str| {
            let p = p.clone();
            let (q, scope) = (q.to_string(), scope.to_string());
            async move { c::search_commits(p, q, Some(scope), None, None).await.unwrap() }
        };
        assert_eq!(s("segundo", "message").await.len(), 1);
        assert_eq!(s("Test", "author").await.len(), 2);
        assert_eq!(s("b.txt", "file").await.len(), 1);
        assert_eq!(s("alfa", "pickaxeS").await.len(), 1);
        assert_eq!(s("be.a", "pickaxeG").await.len(), 1);
        let sha = head(d);
        assert_eq!(s(&sha[..8], "sha").await.len(), 1);
        assert!(c::search_commits(p.clone(), "x".into(), Some("raro".into()), None, None).await.is_err());
        assert_eq!(c::search_commits(p.clone(), String::new(), None, Some("2000-01-01".into()), None).await.unwrap().len(), 2);
        assert_eq!(c::search_commits(p.clone(), String::new(), None, None, Some("2000-01-01".into())).await.unwrap().len(), 0);
        let authors = list_authors(p.clone()).await.unwrap();
        assert_eq!((authors[0].name.as_str(), authors[0].count), ("Test", 2));
    }

    #[tokio::test]
    async fn archivos_config_ignore_y_edicion() {
        let (td, p) = init();
        let d = td.path();
        let first = commit_file(&p, d, "a.txt", "uno\n", "primero").await;
        commit_file(&p, d, "img.png", "\u{89}PNG", "img").await;
        commit_file(&p, d, "b.txt", "dos\n", "tercero").await;
        // blobs
        let b = get_file_blob_base64(p.clone(), "HEAD".into(), "img.png".into()).await.unwrap();
        assert_eq!(b.mime, "image/png");
        assert_eq!(b.size, 5);
        assert_eq!(b.base64, "wolQTkc=");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
        assert!(get_file_blob_base64(p.clone(), "--x".into(), "a.txt".into()).await.is_err());
        assert!(get_file_blob_base64(p.clone(), "HEAD:a.txt".into(), "a.txt".into()).await.is_err());
        assert_eq!(show_file(p.clone(), first.clone(), "a.txt".into()).await.unwrap(), "uno\n");
        assert!(show_file(p.clone(), "HEAD".into(), "../x".into()).await.is_err());
        // read/write con guardas
        write_file(p.clone(), "sub/n.txt".into(), "hola".into()).await.unwrap();
        assert_eq!(read_file(p.clone(), "sub/n.txt".into()).await.unwrap(), "hola");
        assert!(write_file(p.clone(), "../fuera.txt".into(), "x".into()).await.is_err());
        assert!(write_file(p.clone(), ".git/hooks/pre-commit".into(), "x".into()).await.is_err());
        assert!(read_file(p.clone(), ".git/config".into()).await.is_err());
        // config
        set_repo_config(p.clone(), "user.name".into(), Some("Otro".into())).await.unwrap();
        set_repo_config(p.clone(), "user.signingkey".into(), Some("-x".into())).await.unwrap();
        let cfg = get_repo_config(p.clone()).await.unwrap();
        assert_eq!(cfg.iter().find(|e| e.key == "user.name").unwrap().local.as_deref(), Some("Otro"));
        assert_eq!(cfg.iter().find(|e| e.key == "user.signingkey").unwrap().local.as_deref(), Some("-x"));
        set_repo_config(p.clone(), "user.name".into(), None).await.unwrap();
        set_repo_config(p.clone(), "user.name".into(), None).await.unwrap();
        assert!(set_repo_config(p.clone(), "core.sshCommand".into(), Some("touch x".into())).await.is_err());
        assert!(set_repo_config(p.clone(), "gpg.format".into(), Some("raro".into())).await.is_err());
        // plantilla
        std::fs::write(d.join("tpl.txt"), "feat: \n\n# comentario\ncuerpo\n").unwrap();
        assert!(get_commit_template(p.clone()).await.unwrap().is_none());
        set_repo_config(p.clone(), "commit.template".into(), Some("tpl.txt".into())).await.unwrap();
        let t = get_commit_template(p.clone()).await.unwrap().unwrap();
        assert_eq!((t.summary.as_str(), t.description.as_str()), ("feat:", "cuerpo"));
        // ignore
        ignore_pattern(p.clone(), "sub/n.txt".into(), "extension".into(), "gitignore".into()).await.unwrap();
        ignore_pattern(p.clone(), "sub/n.txt".into(), "folder".into(), "local".into()).await.unwrap();
        ignore_pattern(p.clone(), "a.txt".into(), "file".into(), "gitignore".into()).await.unwrap();
        assert!(ignore_pattern(p.clone(), "a.txt".into(), "folder".into(), "gitignore".into()).await.is_err());
        let gi = std::fs::read_to_string(d.join(".gitignore")).unwrap();
        assert!(gi.contains("*.txt") && gi.contains("/a.txt"));
        assert!(std::fs::read_to_string(d.join(".git/info/exclude")).unwrap().contains("/sub/"));
        // editar mensaje: HEAD (sin colar lo staged) y antiguo
        std::fs::write(d.join("z.dat"), "z\n").unwrap();
        c::stage_paths(p.clone(), vec!["z.dat".into()]).await.unwrap();
        let h = head(d);
        edit_commit_message(p.clone(), h.clone(), "tercero editado".into()).await.unwrap();
        assert_eq!(sh(d, &["log", "-1", "--format=%s"]).trim(), "tercero editado");
        assert!(sh(d, &["show", "--stat", "--format=", "HEAD"]).contains("b.txt"));
        assert!(!sh(d, &["show", "--stat", "--format=", "HEAD"]).contains("z.dat"));
        assert!(c::get_status(p.clone()).await.unwrap().files.iter().any(|f| f.path == "z.dat" && f.staged));
        sh(d, &["reset", "-q"]);
        std::fs::remove_file(d.join("z.dat")).unwrap();
        let img = sh(d, &["rev-list", "--reverse", "HEAD"]).lines().nth(1).unwrap().to_string();
        edit_commit_message(p.clone(), img, "imagen nueva".into()).await.unwrap();
        let subjects = sh(d, &["log", "--format=%s"]);
        assert_eq!(subjects.lines().collect::<Vec<_>>(), vec!["tercero editado", "imagen nueva", "primero"]);
        assert!(edit_commit_message(p.clone(), first, "no".into()).await.is_err(), "commit inicial");
        // comparar
        let cmp = compare_refs(p.clone(), "HEAD~2".into(), "HEAD".into()).await.unwrap();
        assert_eq!(cmp.len(), 2);
        let fd = compare_file_diff(p.clone(), "HEAD~2".into(), "HEAD".into(), "b.txt".into(), None, None, Some(true)).await.unwrap();
        assert_eq!(fd.additions, 1);
        assert!(is_ancestor(p.clone(), "HEAD~1".into(), "HEAD".into()).await.unwrap());
        assert!(!is_ancestor(p.clone(), "HEAD".into(), "HEAD~1".into()).await.unwrap());
        assert!(is_ancestor(p.clone(), "nada".into(), "HEAD".into()).await.is_err());
        // limpiar sin seguimiento
        std::fs::write(d.join("junk.tmp"), "x").unwrap();
        clean_untracked(p.clone(), Some(vec!["junk.tmp".into()])).await.unwrap();
        assert!(!d.join("junk.tmp").exists());
        undo_action(p.clone()).await.unwrap();
        assert!(d.join("junk.tmp").exists());
        // registro de actividad
        let log = get_activity_log(Some(50)).await.unwrap();
        assert!(!log.is_empty() && log.iter().all(|e| !e.command.contains(&p)));
        assert!(log.iter().any(|e| e.kind == "write" && e.command.starts_with("git ")));
    }

    #[tokio::test]
    async fn conflicto_lados_y_skip() {
        let (td, p) = init();
        let d = td.path();
        commit_file(&p, d, "a.txt", "1\n", "base").await;
        sh(d, &["checkout", "-q", "-b", "x"]);
        commit_file(&p, d, "a.txt", "x\n", "en x").await;
        sh(d, &["checkout", "-q", "main"]);
        commit_file(&p, d, "a.txt", "m\n", "en main").await;
        assert!(c::merge_branch(p.clone(), "x".into(), None).await.is_err());
        assert!(op_skip(p.clone()).await.is_err());
        resolve_with_side(p.clone(), "a.txt".into(), "theirs".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "x\n");
        c::op_continue(p.clone()).await.unwrap();
        assert!(resolve_with_side(p.clone(), "a.txt".into(), "raro".into()).await.is_err());
        // rebase + skip
        sh(d, &["checkout", "-q", "-b", "y", "HEAD~1"]);
        commit_file(&p, d, "a.txt", "y\n", "en y").await;
        assert!(c::rebase_onto(p.clone(), "main".into(), Some(false)).await.is_err());
        assert_eq!(c::get_status(p.clone()).await.unwrap().operation.as_deref(), Some("rebase"));
        op_skip(p.clone()).await.unwrap();
        assert!(c::get_status(p.clone()).await.unwrap().operation.is_none());
    }
}
