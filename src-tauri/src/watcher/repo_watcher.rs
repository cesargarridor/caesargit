//! Vigila la raíz del repo y emite `repo-changed` con debounce de 200 ms.
use crate::error::{AppError, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    repo_path: String,
}

static WATCHERS: Lazy<Mutex<HashMap<PathBuf, RecommendedWatcher>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// ¿Importa este cambio? Ignora `.git/` salvo HEAD, index, refs, MERGE_HEAD, etc. y cualquier `*.lock`.
pub fn is_relevant(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else { return false };
    if rel.extension().is_some_and(|e| e == "lock") {
        return false;
    }
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    match comps.next() {
        Some(first) if first == ".git" => match comps.next() {
            Some(n) => {
                matches!(
                    n.as_str(),
                    "HEAD" | "index" | "refs" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "packed-refs"
                ) || n.starts_with("rebase-")
            }
            None => false,
        },
        Some(_) => true,
        None => false,
    }
}

/// Empieza a vigilar `repo_path` (raíz canonizada). Idempotente.
pub fn watch_repo(app: &AppHandle, repo_path: &Path) -> Result<()> {
    let root = std::fs::canonicalize(repo_path).map_err(|e| AppError::io(e.to_string()))?;
    let mut map = WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(&root) {
        return Ok(());
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<()>();
    let filter_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| is_relevant(&filter_root, p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| AppError::io(e.to_string()))?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| AppError::io(e.to_string()))?;

    let app = app.clone();
    let payload = RepoChanged { repo_path: root.to_string_lossy().into_owned() };
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            // Debounce: esperar a que pasen 200 ms sin nuevos eventos.
            while let Ok(Some(())) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {}
            let _ = app.emit("repo-changed", payload.clone());
        }
    });
    map.insert(root, watcher);
    Ok(())
}

/// Deja de vigilar (al soltar el watcher se cierra el canal y termina la tarea).
pub fn unwatch_repo(repo_path: &Path) {
    let root = std::fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
    WATCHERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter() {
        let r = Path::new("/r");
        assert!(is_relevant(r, Path::new("/r/src/a.rs")));
        assert!(is_relevant(r, Path::new("/r/.git/HEAD")));
        assert!(is_relevant(r, Path::new("/r/.git/refs/heads/main")));
        assert!(is_relevant(r, Path::new("/r/.git/rebase-merge/x")));
        assert!(!is_relevant(r, Path::new("/r/.git/index.lock")));
        assert!(!is_relevant(r, Path::new("/r/.git/objects/ab/cd")));
        assert!(!is_relevant(r, Path::new("/other/a")));
    }
}
