//! Comandos Tauri (agente C). Cada comando abre/valida el repo, valida los argumentos
//! del usuario con `arg_guard`, pone las rutas tras `--` (vía `path_guard::safe_rel`) y
//! ejecuta `git` con `executor` (lecturas sin mutex, escrituras serializadas por repo).
use crate::error::{AppError, Result};
use crate::git::models::*;
use crate::git::{conflict, executor, graph_engine, parsers, patcher};
use crate::security::arg_guard::*;
use crate::security::path_guard;
use crate::watcher::repo_watcher;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- helpers

async fn root(repo_path: &str) -> Result<PathBuf> {
    path_guard::open_repo_root(repo_path).await
}

async fn rels(root: &Path, paths: &[String]) -> Result<Vec<String>> {
    if paths.is_empty() {
        return Err(AppError::invalid_arg("no se indicó ninguna ruta"));
    }
    paths.iter().map(|p| path_guard::safe_rel(root, p)).collect()
}

fn log_format_arg() -> String {
    format!("--format={}", parsers::LOG_FORMAT)
}

async fn has_head(root: &Path) -> bool {
    executor::read(root, &["rev-parse", "-q", "--verify", "HEAD"]).await.is_ok()
}

async fn status_of(root: &Path) -> Result<RepoStatus> {
    let out = executor::read(root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?;
    let mut st = parsers::parse_status(&out);
    let gd = executor::git_dir(root).await?;
    st.operation = parsers::detect_operation(&gd);
    Ok(st)
}

async fn file_change(root: &Path, rel: &str) -> Result<Option<FileChange>> {
    let out = executor::read(root, &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", rel]).await?;
    Ok(parsers::parse_status(&out).files.into_iter().next())
}

async fn parents_count(root: &Path, sha: &str) -> Result<usize> {
    let out = executor::read(root, &["rev-list", "--parents", "-n", "1", sha]).await?;
    Ok(out.split_whitespace().count().saturating_sub(1))
}

fn empty_diff(path: &str) -> DiffFile {
    DiffFile {
        path: path.to_string(),
        old_path: None,
        status: "modified".into(),
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: vec![],
    }
}

/// Diff sintético de un archivo sin seguimiento (todo añadido).
async fn untracked_diff(root: &Path, rel: &str) -> Result<DiffFile> {
    let full = path_guard::safe_join(root, rel)?;
    let meta = tokio::fs::metadata(&full).await?;
    let mut f = empty_diff(rel);
    f.status = "added".into();
    if !meta.is_file() {
        return Ok(f);
    }
    if meta.len() > 2 * 1024 * 1024 {
        f.binary = true;
        return Ok(f);
    }
    let bytes = tokio::fs::read(&full).await?;
    if bytes.contains(&0) {
        f.binary = true;
        return Ok(f);
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Ok(f);
    }
    let mut patch = format!(
        "diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for l in &lines {
        patch.push('+');
        patch.push_str(l);
        patch.push('\n');
    }
    Ok(parsers::parse_diff(&patch).into_iter().next().unwrap_or(f))
}

async fn worktree_diff(root: &Path, rel: &str, staged: bool, ignore_ws: bool) -> Result<DiffFile> {
    if !staged {
        if let Some(fc) = file_change(root, rel).await? {
            if fc.worktree == '?' {
                return untracked_diff(root, rel).await;
            }
        }
    }
    let mut a = vec!["diff", "--no-color", "--no-ext-diff", "-M"];
    if staged {
        a.push("--cached");
    }
    if ignore_ws {
        a.push("-w");
    }
    a.push("--");
    a.push(rel);
    let out = executor::read(root, &a).await?;
    Ok(parsers::parse_diff(&out).into_iter().next().unwrap_or_else(|| empty_diff(rel)))
}

fn commit_args(sha: &str) -> Vec<String> {
    vec![log_format_arg(), "--decorate=full".into(), sha.into()]
}

async fn log_commits(root: &Path, extra: &[&str]) -> Result<Vec<CommitNode>> {
    let fmt = log_format_arg();
    let mut a: Vec<&str> = vec!["log", "--decorate=full", &fmt];
    a.extend_from_slice(extra);
    let out = executor::read(root, &a).await?;
    Ok(parsers::parse_log(&out))
}

fn is_hex(s: &str) -> bool {
    validate_sha(s).is_ok()
}

// ---------------------------------------------------------------- repo

#[tauri::command]
pub async fn open_repo(path: String) -> Result<RepoInfo> {
    let r = root(&path).await?;
    let name = r.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    Ok(RepoInfo { id: path_guard::repo_id(&r), path: r.to_string_lossy().into_owned(), name })
}

#[tauri::command]
pub async fn get_status(repo_path: String) -> Result<RepoStatus> {
    let r = root(&repo_path).await?;
    status_of(&r).await
}

// ---------------------------------------------------------------- grafo

#[tauri::command]
pub async fn get_graph(repo_path: String, cursor: u32, limit: u32, has_wip: bool) -> Result<GraphPage> {
    let r = root(&repo_path).await?;
    if limit == 0 || limit > 5000 {
        return Err(AppError::invalid_arg("limit fuera de rango (1..5000)"));
    }
    if !has_head(&r).await {
        return Ok(GraphPage { rows: vec![], next_cursor: None, total: Some(0) });
    }
    graph_engine::get_graph(&r, cursor, limit, has_wip).await
}

#[tauri::command]
pub async fn search_commits(repo_path: String, query: String) -> Result<Vec<CommitNode>> {
    let r = root(&repo_path).await?;
    let q = query.trim();
    if q.is_empty() || q.len() > 200 || q.contains('\0') || !has_head(&r).await {
        return Ok(vec![]);
    }
    let grep = format!("--grep={q}");
    let author = format!("--author={q}");
    let mut all = log_commits(&r, &["--all", "-i", "--fixed-strings", "--max-count=200", &grep]).await?;
    all.extend(log_commits(&r, &["--all", "-i", "--fixed-strings", "--max-count=200", &author]).await?);
    if is_hex(q) {
        let spec = format!("{q}^{{commit}}");
        if let Ok(full) = executor::read(&r, &["rev-parse", "-q", "--verify", &spec]).await {
            let full = full.trim().to_string();
            all.extend(log_commits(&r, &["--max-count=1", &full]).await?);
        }
    }
    let mut seen = std::collections::HashSet::new();
    all.retain(|c| seen.insert(c.sha.clone()));
    all.sort_by_key(|c| std::cmp::Reverse(c.committer_date));
    all.truncate(200);
    Ok(all)
}

// ---------------------------------------------------------------- refs

#[tauri::command]
pub async fn list_branches(repo_path: String) -> Result<Vec<BranchInfo>> {
    let r = root(&repo_path).await?;
    let fmt = format!("--format={}", parsers::BRANCH_FORMAT);
    let out = executor::read(&r, &["for-each-ref", &fmt, "refs/heads", "refs/remotes"]).await?;
    Ok(parsers::parse_branches(&out))
}

#[tauri::command]
pub async fn list_tags(repo_path: String) -> Result<Vec<TagInfo>> {
    let r = root(&repo_path).await?;
    let fmt = format!("--format={}", parsers::TAG_FORMAT);
    let out = executor::read(&r, &["for-each-ref", &fmt, "refs/tags"]).await?;
    Ok(parsers::parse_tags(&out))
}

#[tauri::command]
pub async fn list_stashes(repo_path: String) -> Result<Vec<StashEntry>> {
    let r = root(&repo_path).await?;
    let fmt = format!("--format={}", parsers::STASH_FORMAT);
    let out = executor::read(&r, &["stash", "list", &fmt]).await?;
    Ok(parsers::parse_stashes(&out))
}

// ---------------------------------------------------------------- ramas

#[tauri::command]
pub async fn checkout(repo_path: String, target: String, create: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    if create {
        validate_branch_name(&target)?;
        executor::write(&r, &["checkout", "-b", &target]).await?;
    } else {
        validate_ref(&target)?;
        executor::write(&r, &["checkout", &target, "--"]).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_branch(repo_path: String, name: String, start_point: Option<String>, checkout: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_branch_name(&name)?;
    let mut a: Vec<&str> = if checkout { vec!["checkout", "-b", &name] } else { vec!["branch", &name] };
    if let Some(s) = start_point.as_deref().filter(|s| !s.is_empty()) {
        validate_ref(s)?;
        a.push(s);
    }
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_branch(repo_path: String, old: String, new: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&old)?;
    validate_branch_name(&new)?;
    executor::write(&r, &["branch", "-m", &old, &new]).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_branch(repo_path: String, name: String, force: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&name)?;
    executor::write(&r, &["branch", if force { "-D" } else { "-d" }, &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_branch(repo_path: String, remote: String, branch: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&remote)?;
    validate_ref(&branch)?;
    executor::write(&r, &["push", &remote, "--delete", &branch]).await?;
    Ok(())
}

#[tauri::command]
pub async fn checkout_remote_branch(repo_path: String, remote_branch: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&remote_branch)?;
    let (remote, local) = remote_branch
        .split_once('/')
        .ok_or_else(|| AppError::invalid_arg("se esperaba remoto/rama"))?;
    validate_remote(remote)?;
    validate_branch_name(local)?;
    let local_ref = format!("refs/heads/{local}");
    if executor::read(&r, &["show-ref", "--verify", "--quiet", &local_ref]).await.is_ok() {
        executor::write(&r, &["checkout", local, "--"]).await?;
    } else {
        executor::write(&r, &["checkout", "--track", &remote_branch]).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn merge_branch(repo_path: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&name)?;
    executor::write(&r, &["merge", "--no-edit", &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn rebase_onto(repo_path: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_ref(&name)?;
    executor::write(&r, &["rebase", &name]).await?;
    Ok(())
}

// ---------------------------------------------------------------- tags

#[tauri::command]
pub async fn create_tag(repo_path: String, name: String, target: Option<String>, message: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_branch_name(&name)?;
    let msg = message.filter(|m| !m.trim().is_empty());
    let mut a: Vec<&str> = vec!["tag"];
    if let Some(m) = msg.as_deref() {
        a.extend(["-a", "-m", m]);
    }
    a.push(&name);
    if let Some(t) = target.as_deref().filter(|t| !t.is_empty()) {
        validate_ref(t)?;
        a.push(t);
    }
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_tag(repo_path: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_branch_name(&name)?;
    executor::write(&r, &["tag", "-d", &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn push_tag(repo_path: String, remote: String, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_remote(&remote)?;
    validate_branch_name(&name)?;
    let refspec = format!("refs/tags/{name}");
    executor::write(&r, &["push", &remote, &refspec]).await?;
    Ok(())
}

// ---------------------------------------------------------------- remoto

#[tauri::command]
pub async fn fetch(repo_path: String, all: bool, prune: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    let mut a = vec!["fetch"];
    if all {
        a.push("--all");
    }
    if prune {
        a.push("--prune");
    }
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn pull(repo_path: String, mode: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let a: Vec<&str> = match mode.as_str() {
        "ff" => vec!["pull", "--ff-only"],
        "rebase" => vec!["pull", "--rebase"],
        "merge" => vec!["pull", "--no-rebase", "--no-edit"],
        _ => return Err(AppError::invalid_arg("modo de pull no válido (ff|rebase|merge)")),
    };
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn push(repo_path: String, force: bool, set_upstream: bool) -> Result<()> {
    let r = root(&repo_path).await?;
    let has_upstream = executor::read(&r, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.is_ok();
    let mut a: Vec<String> = vec!["push".into()];
    if force {
        a.push("--force-with-lease".into());
    }
    if set_upstream || !has_upstream {
        let branch = executor::read(&r, &["symbolic-ref", "--short", "HEAD"])
            .await
            .map_err(|_| AppError::invalid_arg("HEAD desacoplado: no hay rama que publicar"))?;
        let branch = branch.trim().to_string();
        validate_ref(&branch)?;
        let remotes = executor::read(&r, &["remote"]).await?;
        let list: Vec<&str> = remotes.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let remote = if list.contains(&"origin") { "origin" } else { *list.first().ok_or_else(|| AppError::invalid_arg("el repositorio no tiene remotos"))? };
        validate_remote(remote)?;
        a.extend(["-u".into(), remote.into(), branch]);
    }
    let refs: Vec<&str> = a.iter().map(String::as_str).collect();
    executor::write(&r, &refs).await?;
    Ok(())
}

// ---------------------------------------------------------------- stash

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

#[tauri::command]
pub async fn stash_push(repo_path: String, message: Option<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let mut a: Vec<&str> = vec!["stash", "push", "-u"];
    if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
        a.extend(["-m", m]);
    }
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn stash_apply(repo_path: String, index: u32) -> Result<()> {
    let r = root(&repo_path).await?;
    executor::write(&r, &["stash", "apply", &stash_ref(index)]).await?;
    Ok(())
}

#[tauri::command]
pub async fn stash_pop(repo_path: String, index: u32) -> Result<()> {
    let r = root(&repo_path).await?;
    executor::write(&r, &["stash", "pop", &stash_ref(index)]).await?;
    Ok(())
}

#[tauri::command]
pub async fn stash_drop(repo_path: String, index: u32) -> Result<()> {
    let r = root(&repo_path).await?;
    executor::write(&r, &["stash", "drop", &stash_ref(index)]).await?;
    Ok(())
}

#[tauri::command]
pub async fn stash_branch(repo_path: String, index: u32, name: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_branch_name(&name)?;
    executor::write(&r, &["stash", "branch", &name, &stash_ref(index)]).await?;
    Ok(())
}

// ---------------------------------------------------------------- staging

#[tauri::command]
pub async fn stage_paths(repo_path: String, paths: Vec<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let rs = rels(&r, &paths).await?;
    let mut a = vec!["add", "-A", "--"];
    a.extend(rs.iter().map(String::as_str));
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn unstage_paths(repo_path: String, paths: Vec<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let rs = rels(&r, &paths).await?;
    let mut a = if has_head(&r).await { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"] };
    a.extend(rs.iter().map(String::as_str));
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn stage_all(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    executor::write(&r, &["add", "-A"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn unstage_all(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    if has_head(&r).await {
        executor::write(&r, &["reset", "-q"]).await?;
    } else {
        executor::write(&r, &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]).await?;
    }
    Ok(())
}

/// Descarta cambios del working tree (no toca lo ya en stage): sin seguimiento -> `clean`,
/// con seguimiento -> `restore --worktree` desde el índice.
async fn discard_rels(root: &Path, rs: &[String]) -> Result<()> {
    let mut tracked: Vec<&str> = Vec::new();
    for rel in rs {
        match file_change(root, rel).await? {
            Some(fc) if fc.conflicted => {}
            Some(fc) if fc.worktree == '?' => {
                executor::write(root, &["clean", "-f", "-d", "--", rel]).await?;
            }
            Some(fc) if fc.unstaged => tracked.push(rel),
            _ => {}
        }
    }
    if !tracked.is_empty() {
        let mut a = vec!["restore", "--worktree", "--"];
        a.extend(tracked);
        executor::write(root, &a).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn discard_paths(repo_path: String, paths: Vec<String>) -> Result<()> {
    let r = root(&repo_path).await?;
    let rs = rels(&r, &paths).await?;
    discard_rels(&r, &rs).await
}

#[tauri::command]
pub async fn discard_all(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let st = status_of(&r).await?;
    let rs: Vec<String> = st.files.iter().filter(|f| !f.conflicted && f.unstaged).map(|f| f.path.clone()).collect();
    discard_rels(&r, &rs).await
}

#[tauri::command]
pub async fn ignore_path(repo_path: String, path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    if rel.contains('\n') || rel.contains('\r') {
        return Err(AppError::invalid_path("la ruta contiene saltos de línea"));
    }
    let mut pat = String::new();
    for (i, c) in rel.chars().enumerate() {
        if (i == 0 && (c == '#' || c == '!')) || matches!(c, '*' | '?' | '[' | '\\') {
            pat.push('\\');
        }
        pat.push(c);
    }
    let line = format!("/{pat}");
    let gi = path_guard::safe_join(&r, ".gitignore")?;
    let mut content = match tokio::fs::read_to_string(&gi).await {
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
    tokio::fs::write(&gi, content).await?;
    Ok(())
}

// ---------------------------------------------------------------- diff

#[tauri::command]
pub async fn get_file_diff(repo_path: String, path: String, staged: bool, ignore_whitespace: bool) -> Result<DiffFile> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    worktree_diff(&r, &rel, staged, ignore_whitespace).await
}

#[tauri::command]
pub async fn get_commit_files(repo_path: String, sha: String) -> Result<Vec<DiffFile>> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let out = executor::read(&r, &["show", "--no-color", "--no-ext-diff", "--format=", "-M", "--first-parent", "-m", &sha]).await?;
    let mut files = parsers::parse_diff(&out);
    for f in &mut files {
        f.hunks.clear();
    }
    Ok(files)
}

#[tauri::command]
pub async fn get_commit_file_diff(repo_path: String, sha: String, path: String, ignore_whitespace: bool) -> Result<DiffFile> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let mut a = vec!["show", "--no-color", "--no-ext-diff", "--format=", "-M", "--first-parent", "-m"];
    if ignore_whitespace {
        a.push("-w");
    }
    a.extend([sha.as_str(), "--", rel.as_str()]);
    let out = executor::read(&r, &a).await?;
    Ok(parsers::parse_diff(&out).into_iter().next().unwrap_or_else(|| empty_diff(&rel)))
}

#[tauri::command]
pub async fn get_commit_detail(repo_path: String, sha: String) -> Result<CommitNode> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let args = commit_args(&sha);
    let mut a: Vec<&str> = vec!["log", "--max-count=1"];
    a.extend(args.iter().map(String::as_str));
    let out = executor::read(&r, &a).await?;
    parsers::parse_log(&out).into_iter().next().ok_or_else(|| AppError::git_failed("commit no encontrado"))
}

// ---------------------------------------------------------------- patch

async fn ensure_tracked(root: &Path, rel: &str) -> Result<()> {
    if let Some(fc) = file_change(root, rel).await? {
        if fc.worktree == '?' {
            executor::write(root, &["add", "-N", "--", rel]).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn apply_hunk(
    repo_path: String,
    path: String,
    staged: bool,
    hunk_index: u32,
    action: String,
    ignore_whitespace: bool,
) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let mut a: Vec<&str> = vec!["apply"];
    match action.as_str() {
        "stage" => a.extend(["--cached", "--recount"]),
        "unstage" => a.extend(["--cached", "--recount", "--reverse"]),
        "discard" => a.extend(["--recount", "--reverse"]),
        _ => return Err(AppError::invalid_arg("acción no válida (stage|unstage|discard)")),
    }
    if staged && action == "stage" {
        return Err(AppError::invalid_arg("no se puede hacer stage de un hunk ya en stage"));
    }
    if action == "stage" || action == "discard" {
        ensure_tracked(&r, &rel).await?;
    }
    let file = worktree_diff(&r, &rel, staged, ignore_whitespace).await?;
    let patch = patcher::build_hunk_patch(&file, hunk_index as usize).map_err(AppError::invalid_arg)?;
    if ignore_whitespace {
        a.push("--ignore-whitespace");
    }
    a.push("-");
    executor::write_stdin(&r, &a, patch.as_bytes()).await?;
    Ok(())
}

#[tauri::command]
pub async fn apply_lines(repo_path: String, path: String, hunk_index: u32, line_indices: Vec<u32>, action: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let unstage = match action.as_str() {
        "stage" => false,
        "unstage" => true,
        _ => return Err(AppError::invalid_arg("acción no válida (stage|unstage)")),
    };
    if !unstage {
        ensure_tracked(&r, &rel).await?;
    }
    let file = worktree_diff(&r, &rel, unstage, false).await?;
    let patch = patcher::build_lines_patch(&file, hunk_index as usize, &line_indices, unstage).map_err(AppError::invalid_arg)?;
    let mut a = vec!["apply", "--cached", "--recount"];
    if unstage {
        a.push("--reverse");
    }
    a.push("-");
    executor::write_stdin(&r, &a, patch.as_bytes()).await?;
    Ok(())
}

// ---------------------------------------------------------------- commit

#[tauri::command]
pub async fn commit(repo_path: String, summary: String, description: String, amend: bool) -> Result<String> {
    let r = root(&repo_path).await?;
    if summary.trim().is_empty() {
        return Err(AppError::invalid_arg("el resumen del commit no puede estar vacío"));
    }
    if summary.contains('\0') || description.contains('\0') {
        return Err(AppError::invalid_arg("el mensaje contiene caracteres no válidos"));
    }
    let mut msg = summary.trim().to_string();
    if !description.trim().is_empty() {
        msg.push_str("\n\n");
        msg.push_str(description.trim());
    }
    msg.push('\n');
    let mut a = vec!["commit", "-F", "-"];
    if amend {
        a.push("--amend");
    }
    executor::write_stdin(&r, &a, msg.as_bytes()).await?;
    let sha = executor::read(&r, &["rev-parse", "HEAD"]).await?;
    Ok(sha.trim().to_string())
}

#[tauri::command]
pub async fn last_commit_message(repo_path: String) -> Result<String> {
    let r = root(&repo_path).await?;
    if !has_head(&r).await {
        return Ok(String::new());
    }
    let out = executor::read(&r, &["log", "-1", "--format=%B"]).await?;
    Ok(out.trim_end().to_string())
}

#[tauri::command]
pub async fn undo_last_commit(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    executor::write(&r, &["reset", "--soft", "HEAD~1"]).await?;
    Ok(())
}

// ---------------------------------------------------------------- commit-ops

#[tauri::command]
pub async fn cherry_pick(repo_path: String, sha: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let mut a = vec!["cherry-pick"];
    if parents_count(&r, &sha).await? > 1 {
        a.extend(["-m", "1"]);
    }
    a.push(&sha);
    executor::write_env(&r, &a, &[("GIT_EDITOR", "true")]).await?;
    Ok(())
}

#[tauri::command]
pub async fn revert_commit(repo_path: String, sha: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let mut a = vec!["revert", "--no-edit"];
    if parents_count(&r, &sha).await? > 1 {
        a.extend(["-m", "1"]);
    }
    a.push(&sha);
    executor::write(&r, &a).await?;
    Ok(())
}

#[tauri::command]
pub async fn reset_to(repo_path: String, sha: String, mode: String) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err(AppError::invalid_arg("modo de reset no válido (soft|mixed|hard)")),
    };
    executor::write(&r, &["reset", flag, &sha]).await?;
    Ok(())
}

#[tauri::command]
pub async fn is_ancestor_of_head(repo_path: String, sha: String) -> Result<bool> {
    let r = root(&repo_path).await?;
    validate_sha(&sha)?;
    if !has_head(&r).await {
        return Ok(false);
    }
    match executor::read(&r, &["merge-base", "--is-ancestor", &sha, "HEAD"]).await {
        Ok(_) => Ok(true),
        Err(e) if e.code == "git_failed" => Ok(false),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------- rebase interactivo

const ACTIONS: [&str; 6] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

#[tauri::command]
pub async fn list_rebase_commits(repo_path: String, base_sha: String) -> Result<Vec<RebaseTodoItem>> {
    let r = root(&repo_path).await?;
    validate_sha(&base_sha)?;
    let range = format!("{base_sha}..HEAD");
    let out = executor::read(&r, &["log", "--reverse", "--no-merges", "--format=%H%x00%s", &range]).await?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(sha, subject)| RebaseTodoItem {
            action: "pick".into(),
            sha: sha.to_string(),
            subject: subject.to_string(),
            new_message: None,
        })
        .collect())
}

/// Ruta del tempdir lista para ir entre comillas simples dentro de `sh` (separadores `/`).
fn sh_path(p: &Path) -> Result<String> {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.contains('\'') || s.contains('\n') || s.contains('\0') {
        return Err(AppError::io("la ruta temporal contiene caracteres no soportados"));
    }
    Ok(s)
}

/// Mensajes que pedirá el editor, en orden de invocación (None = dejar el mensaje por defecto).
fn editor_messages(items: &[RebaseTodoItem]) -> Vec<Option<String>> {
    let live: Vec<&RebaseTodoItem> = items.iter().filter(|i| i.action != "drop").collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < live.len() {
        let mut j = i + 1;
        let mut has_squash = false;
        while j < live.len() && (live[j].action == "squash" || live[j].action == "fixup") {
            has_squash |= live[j].action == "squash";
            j += 1;
        }
        let group = &live[i..j];
        if has_squash || live[i].action == "reword" {
            let msg = group.iter().find_map(|g| g.new_message.clone()).filter(|m| !m.trim().is_empty());
            out.push(msg);
        }
        i = j;
    }
    out
}

#[tauri::command]
pub async fn rebase_interactive(repo_path: String, base_sha: String, items: Vec<RebaseTodoItem>) -> Result<()> {
    let r = root(&repo_path).await?;
    validate_sha(&base_sha)?;
    if items.is_empty() {
        return Err(AppError::invalid_arg("no hay commits que reordenar"));
    }
    let mut todo = String::new();
    for it in &items {
        if !ACTIONS.contains(&it.action.as_str()) {
            return Err(AppError::invalid_arg("acción de rebase no válida"));
        }
        validate_sha(&it.sha)?;
        todo.push_str(&format!("{} {}\n", it.action, it.sha));
    }
    let dir = tempfile::Builder::new().prefix("caesargit-rebase").tempdir()?;
    let d = sh_path(dir.path())?;
    tokio::fs::write(dir.path().join("todo"), todo).await?;
    tokio::fs::write(dir.path().join("seq.sh"), format!("cat '{d}/todo' > \"$1\"\n")).await?;
    let msgs = editor_messages(&items);
    for (n, m) in msgs.iter().enumerate() {
        if let Some(m) = m {
            let mut text = m.trim_end().to_string();
            text.push('\n');
            tokio::fs::write(dir.path().join(format!("msg-{n}")), text).await?;
        }
    }
    let editor = format!(
        "d='{d}'\nn=$(cat \"$d/counter\" 2>/dev/null || echo 0)\nif [ -f \"$d/msg-$n\" ]; then cat \"$d/msg-$n\" > \"$1\"; fi\necho $((n+1)) > \"$d/counter\"\n"
    );
    tokio::fs::write(dir.path().join("editor.sh"), editor).await?;
    let seq_env = format!("sh '{d}/seq.sh'");
    let ed_env = format!("sh '{d}/editor.sh'");
    executor::write_env(
        &r,
        &["rebase", "-i", &base_sha],
        &[("GIT_SEQUENCE_EDITOR", &seq_env), ("GIT_EDITOR", &ed_env)],
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- operación en curso

async fn current_op(root: &Path) -> Result<String> {
    let gd = executor::git_dir(root).await?;
    parsers::detect_operation(&gd).ok_or_else(|| AppError::invalid_arg("no hay ninguna operación en curso"))
}

#[tauri::command]
pub async fn op_continue(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let op = current_op(&r).await?;
    executor::write_env(&r, &[op.as_str(), "--continue"], &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")]).await?;
    Ok(())
}

#[tauri::command]
pub async fn op_abort(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let op = current_op(&r).await?;
    executor::write(&r, &[op.as_str(), "--abort"]).await?;
    Ok(())
}

// ---------------------------------------------------------------- conflictos

#[tauri::command]
pub async fn get_conflict(repo_path: String, path: String) -> Result<ConflictFile> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let stage = |n: u8| format!(":{n}:{rel}");
    let show = |spec: String| {
        let r = r.clone();
        async move { executor::read_bytes(&r, &["show", &spec]).await.map(|b| String::from_utf8_lossy(&b).into_owned()) }
    };
    let ours = show(stage(2)).await.unwrap_or_default();
    let theirs = show(stage(3)).await.unwrap_or_default();
    let base = show(stage(1)).await.ok();
    let full = path_guard::safe_join(&r, &rel)?;
    let merged = match tokio::fs::read(&full).await {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    Ok(conflict::build_conflict_file(&rel, ours, theirs, base, merged))
}

#[tauri::command]
pub async fn resolve_conflict(repo_path: String, path: String, content: String) -> Result<()> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let full = path_guard::safe_join(&r, &rel)?;
    tokio::fs::write(&full, content.as_bytes()).await?;
    executor::write(&r, &["add", "--", &rel]).await?;
    Ok(())
}

// ---------------------------------------------------------------- blame / historial

#[tauri::command]
pub async fn blame_file(repo_path: String, path: String, rev: Option<String>) -> Result<Vec<BlameLine>> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    let mut a: Vec<&str> = vec!["blame", "--porcelain"];
    if let Some(v) = rev.as_deref().filter(|v| !v.is_empty()) {
        validate_ref(v)?;
        a.push(v);
    }
    a.extend(["--", &rel]);
    let out = executor::read(&r, &a).await?;
    Ok(parsers::parse_blame(&out))
}

#[tauri::command]
pub async fn file_history(repo_path: String, path: String) -> Result<Vec<CommitNode>> {
    let r = root(&repo_path).await?;
    let rel = path_guard::safe_rel(&r, &path)?;
    if !has_head(&r).await {
        return Ok(vec![]);
    }
    log_commits(&r, &["--follow", "--max-count=500", "--", &rel]).await
}

// ---------------------------------------------------------------- watcher

#[tauri::command]
pub async fn watch_repo(app: tauri::AppHandle, repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    repo_watcher::watch_repo(&app, &r)
}

#[tauri::command]
pub async fn unwatch_repo(repo_path: String) -> Result<()> {
    let r = root(&repo_path).await?;
    repo_watcher::unwatch_repo(&r);
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
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

    #[tokio::test]
    async fn flujo_completo() {
        let (td, p) = init();
        let d = td.path();
        let info = open_repo(p.clone()).await.unwrap();
        assert!(!info.id.is_empty());

        std::fs::write(d.join("a.txt"), "uno\ndos\ntres\n").unwrap();
        let st = get_status(p.clone()).await.unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].worktree, '?');

        stage_paths(p.clone(), vec!["a.txt".into()]).await.unwrap();
        let st = get_status(p.clone()).await.unwrap();
        assert!(st.files[0].staged);
        unstage_paths(p.clone(), vec!["a.txt".into()]).await.unwrap();
        assert!(!get_status(p.clone()).await.unwrap().files[0].staged);
        stage_all(p.clone()).await.unwrap();

        let sha = commit(p.clone(), "primero".into(), "detalle".into(), false).await.unwrap();
        assert_eq!(sha.len(), 40);
        assert_eq!(last_commit_message(p.clone()).await.unwrap(), "primero\n\ndetalle");
        assert!(get_status(p.clone()).await.unwrap().files.is_empty());

        // diff + stage de hunk
        std::fs::write(d.join("a.txt"), "uno\nDOS\ntres\n").unwrap();
        let df = get_file_diff(p.clone(), "a.txt".into(), false, false).await.unwrap();
        assert_eq!(df.hunks.len(), 1);
        apply_hunk(p.clone(), "a.txt".into(), false, 0, "stage".into(), false).await.unwrap();
        let st = get_status(p.clone()).await.unwrap();
        assert!(st.files[0].staged && !st.files[0].unstaged);
        apply_hunk(p.clone(), "a.txt".into(), true, 0, "unstage".into(), false).await.unwrap();
        discard_paths(p.clone(), vec!["a.txt".into()]).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "uno\ndos\ntres\n");

        // rutas peligrosas
        assert!(stage_paths(p.clone(), vec!["../fuera".into()]).await.is_err());
        assert!(checkout(p.clone(), "--upload-pack=x".into(), false).await.is_err());

        // ramas
        create_branch(p.clone(), "feat".into(), None, true).await.unwrap();
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        stage_paths(p.clone(), vec!["b.txt".into()]).await.unwrap();
        commit(p.clone(), "segundo".into(), String::new(), false).await.unwrap();
        checkout(p.clone(), "main".into(), false).await.unwrap();
        merge_branch(p.clone(), "feat".into()).await.unwrap();
        let bs = list_branches(p.clone()).await.unwrap();
        assert!(bs.iter().any(|b| b.name == "feat") && bs.iter().any(|b| b.name == "main" && b.is_head));
        rename_branch(p.clone(), "feat".into(), "feat2".into()).await.unwrap();
        delete_branch(p.clone(), "feat2".into(), false).await.unwrap();
        create_tag(p.clone(), "v1".into(), None, Some("rel".into())).await.unwrap();
        assert_eq!(list_tags(p.clone()).await.unwrap().len(), 1);
        delete_tag(p.clone(), "v1".into()).await.unwrap();

        // stash
        std::fs::write(d.join("a.txt"), "cambio\n").unwrap();
        std::fs::write(d.join("nuevo.txt"), "x\n").unwrap();
        stash_push(p.clone(), Some("guardado".into())).await.unwrap();
        assert!(get_status(p.clone()).await.unwrap().files.is_empty());
        let sts = list_stashes(p.clone()).await.unwrap();
        assert_eq!(sts.len(), 1);
        stash_pop(p.clone(), 0).await.unwrap();
        assert_eq!(get_status(p.clone()).await.unwrap().files.len(), 2);
        discard_all(p.clone()).await.unwrap();
        assert!(get_status(p.clone()).await.unwrap().files.is_empty());

        // grafo, búsqueda, historial, blame, undo
        let g = get_graph(p.clone(), 0, 50, false).await.unwrap();
        assert!(!g.rows.is_empty());
        assert!(!search_commits(p.clone(), "primero".into()).await.unwrap().is_empty());
        assert!(!file_history(p.clone(), "a.txt".into()).await.unwrap().is_empty());
        assert_eq!(blame_file(p.clone(), "a.txt".into(), None).await.unwrap().len(), 3);
        assert!(is_ancestor_of_head(p.clone(), sha.clone()).await.unwrap());
        let files = get_commit_files(p.clone(), sha.clone()).await.unwrap();
        assert_eq!(files[0].path, "a.txt");
        undo_last_commit(p.clone()).await.unwrap();
        ignore_path(p.clone(), "a.txt".into()).await.unwrap();
        assert!(std::fs::read_to_string(d.join(".gitignore")).unwrap().contains("/a.txt"));
    }

    #[tokio::test]
    async fn rebase_interactivo_y_conflicto() {
        let (td, p) = init();
        let d = td.path();
        for (n, c) in [("a", "1"), ("b", "2"), ("c", "3")] {
            std::fs::write(d.join(format!("{n}.txt")), c).unwrap();
            stage_all(p.clone()).await.unwrap();
            commit(p.clone(), format!("commit {n}"), String::new(), false).await.unwrap();
        }
        let first = executor::read(d, &["rev-list", "--max-parents=0", "HEAD"]).await.unwrap();
        let first = first.trim().to_string();
        let mut items = list_rebase_commits(p.clone(), first.clone()).await.unwrap();
        assert_eq!(items.len(), 2);
        items.reverse();
        items[0].action = "reword".into();
        items[0].new_message = Some("renombrado".into());
        rebase_interactive(p.clone(), first, items).await.unwrap();
        let log = executor::read(d, &["log", "--format=%s"]).await.unwrap();
        assert_eq!(log.lines().collect::<Vec<_>>(), vec!["commit b", "renombrado", "commit a"]);

        // conflicto de merge
        create_branch(p.clone(), "x".into(), None, true).await.unwrap();
        std::fs::write(d.join("a.txt"), "rama\n").unwrap();
        stage_all(p.clone()).await.unwrap();
        commit(p.clone(), "en x".into(), String::new(), false).await.unwrap();
        checkout(p.clone(), "main".into(), false).await.unwrap();
        std::fs::write(d.join("a.txt"), "main\n").unwrap();
        stage_all(p.clone()).await.unwrap();
        commit(p.clone(), "en main".into(), String::new(), false).await.unwrap();
        let e = merge_branch(p.clone(), "x".into()).await.unwrap_err();
        assert_eq!(e.code, "conflict");
        let st = get_status(p.clone()).await.unwrap();
        assert_eq!(st.operation.as_deref(), Some("merge"));
        let c = get_conflict(p.clone(), "a.txt".into()).await.unwrap();
        assert_eq!(c.regions.len(), 1);
        assert_eq!(c.ours, "main\n");
        assert_eq!(c.theirs, "rama\n");
        resolve_conflict(p.clone(), "a.txt".into(), "resuelto\n".into()).await.unwrap();
        op_continue(p.clone()).await.unwrap();
        assert!(get_status(p.clone()).await.unwrap().operation.is_none());
    }
}
