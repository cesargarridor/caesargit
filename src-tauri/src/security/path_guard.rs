//! Canonización de rutas y confinamiento al repositorio.
use crate::error::{AppError, Result};
use crate::git::executor;
use std::path::{Component, Path, PathBuf};

/// Canoniza `path` y obtiene la raíz real con `git rev-parse --show-toplevel`.
pub async fn open_repo_root(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::invalid_path("ruta de repositorio vacía o con NUL"));
    }
    let canon = std::fs::canonicalize(path)
        .map_err(|_| AppError::invalid_path("la ruta no existe o no es accesible"))?;
    if !canon.is_dir() {
        return Err(AppError::invalid_path("la ruta no es un directorio"));
    }
    let out = executor::read(&canon, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| AppError::not_a_repo("la carpeta no es un repositorio git"))?;
    let top = out.trim_end_matches(['\n', '\r']);
    if top.is_empty() {
        return Err(AppError::not_a_repo("la carpeta no es un repositorio git"));
    }
    std::fs::canonicalize(top).map_err(|e| AppError::io(e.to_string()))
}

/// Une `rel` a `root` garantizando que el resultado queda dentro de `root`
/// (también tras resolver symlinks). `root` debe estar canonizado.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.is_empty() || rel.contains('\0') {
        return Err(AppError::invalid_path("ruta vacía o con NUL"));
    }
    let p = Path::new(rel);
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid_path("la ruta contiene '..'"));
    }
    let joined = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    // Canoniza el ancestro existente más profundo y reañade el resto (sin `..`).
    let mut existing = joined.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    let canon_base = loop {
        match std::fs::canonicalize(existing) {
            Ok(c) => break c,
            Err(_) => {
                let name = existing.file_name().ok_or_else(|| AppError::invalid_path("ruta no válida"))?;
                rest.push(name);
                existing = existing.parent().ok_or_else(|| AppError::invalid_path("ruta no válida"))?;
            }
        }
    };
    let mut result = canon_base;
    for name in rest.iter().rev() {
        result.push(name);
    }
    if !result.starts_with(root) {
        return Err(AppError::invalid_path("la ruta queda fuera del repositorio"));
    }
    Ok(result)
}

/// Valida `rel` con `safe_join` y devuelve la ruta relativa a `root` con `/`,
/// lista para ir tras `--` en un comando git.
pub fn safe_rel(root: &Path, rel: &str) -> Result<String> {
    let full = safe_join(root, rel)?;
    let r = full.strip_prefix(root).map_err(|_| AppError::invalid_path("la ruta queda fuera del repositorio"))?;
    if r.as_os_str().is_empty() {
        return Err(AppError::invalid_path("la ruta es la raíz del repositorio"));
    }
    Ok(r.to_string_lossy().replace('\\', "/"))
}

/// Identificador estable (FNV-1a 64, hex) de la raíz canonizada.
pub fn repo_id(root: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in root.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(d.path()).unwrap();
        (d, r)
    }

    #[test]
    fn valid_paths() {
        let (_d, r) = root();
        std::fs::create_dir(r.join("src")).unwrap();
        std::fs::write(r.join("src/a.txt"), "x").unwrap();
        assert_eq!(safe_join(&r, "src/a.txt").unwrap(), r.join("src/a.txt"));
        // archivo aún inexistente
        assert!(safe_join(&r, "src/nuevo/b.txt").is_ok());
        assert_eq!(safe_rel(&r, "src/a.txt").unwrap(), "src/a.txt");
    }

    #[test]
    fn traversal_rejected() {
        let (_d, r) = root();
        assert!(safe_join(&r, "../x").is_err());
        assert!(safe_join(&r, "a/../../x").is_err());
        assert!(safe_join(&r, "").is_err());
        assert!(safe_join(&r, "a\0b").is_err());
    }

    #[test]
    fn absolute_outside_rejected() {
        let (_d, r) = root();
        let (_d2, other) = root();
        assert!(safe_join(&r, other.join("f").to_str().unwrap()).is_err());
        assert!(safe_join(&r, r.join("ok").to_str().unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_rejected() {
        let (_d, r) = root();
        let (_d2, other) = root();
        std::os::unix::fs::symlink(&other, r.join("link")).unwrap();
        assert!(safe_join(&r, "link/secret").is_err());
        assert!(safe_join(&r, "link").is_err());
    }

    #[test]
    fn id_is_stable() {
        let p = Path::new("/tmp/x");
        assert_eq!(repo_id(p), repo_id(p));
        assert_eq!(repo_id(p).len(), 16);
        assert_ne!(repo_id(p), repo_id(Path::new("/tmp/y")));
    }
}
