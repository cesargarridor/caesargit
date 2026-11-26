//! Construcción de parches para stage/unstage/discard por hunk o líneas (agente B).
use super::models::{DiffFile, DiffHunk};

fn header(file: &DiffFile) -> String {
    let old = file.old_path.as_deref().unwrap_or(&file.path);
    format!("diff --git a/{old} b/{p}\n--- a/{old}\n+++ b/{p}\n", old = old, p = file.path)
}

fn hunk_of(file: &DiffFile, idx: usize) -> Result<&DiffHunk, String> {
    file.hunks.get(idx).ok_or_else(|| format!("hunk {idx} fuera de rango"))
}

fn prefix(kind: &str) -> char {
    match kind {
        "add" => '+',
        "del" => '-',
        _ => ' ',
    }
}

/// Parche de un hunk completo. Aplicar: stage = `apply --cached`; unstage = `apply --cached --reverse`
/// (sobre el diff staged); discard = `apply --reverse` (worktree, diff unstaged).
pub fn build_hunk_patch(file: &DiffFile, hunk_index: usize) -> Result<String, String> {
    let h = hunk_of(file, hunk_index)?;
    let mut out = header(file);
    out.push_str(&h.header);
    out.push('\n');
    for l in &h.lines {
        out.push(prefix(&l.kind));
        out.push_str(&l.content);
        out.push('\n');
    }
    Ok(out)
}

/// Parche con solo las líneas seleccionadas (índices dentro de `hunk.lines`).
/// `reverse=false` (stage, diff unstaged): add no seleccionado se omite, del no seleccionado pasa a contexto.
/// `reverse=true` (unstage, diff staged, se aplica con `--reverse`): add no seleccionado pasa a contexto,
/// del no seleccionado se omite. Aplicar con `git apply --cached --recount [--reverse]`.
pub fn build_lines_patch(
    file: &DiffFile,
    hunk_index: usize,
    selected: &[u32],
    reverse: bool,
) -> Result<String, String> {
    let h = hunk_of(file, hunk_index)?;
    let mut body = String::new();
    let (mut old_n, mut new_n, mut changes) = (0u32, 0u32, 0u32);
    for (i, l) in h.lines.iter().enumerate() {
        let sel = selected.contains(&(i as u32));
        let kind = match (l.kind.as_str(), sel) {
            ("ctx", _) => "ctx",
            ("add", true) | ("del", true) => l.kind.as_str(),
            ("add", false) => if reverse { "ctx" } else { continue },
            ("del", false) => if reverse { continue } else { "ctx" },
            _ => continue,
        };
        if kind != "ctx" {
            changes += 1;
        }
        match kind {
            "add" => new_n += 1,
            "del" => old_n += 1,
            _ => {
                old_n += 1;
                new_n += 1;
            }
        }
        body.push(prefix(kind));
        body.push_str(&l.content);
        body.push('\n');
    }
    if changes == 0 {
        return Err("ninguna línea modificada seleccionada".into());
    }
    let mut out = header(file);
    out.push_str(&format!("@@ -{},{} +{},{} @@\n", h.old_start, old_n, h.new_start, new_n));
    out.push_str(&body);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::models::DiffLine;

    fn l(kind: &str, c: &str) -> DiffLine {
        DiffLine { kind: kind.into(), content: c.into(), old_no: None, new_no: None, words: None }
    }

    fn file() -> DiffFile {
        DiffFile {
            path: "f.txt".into(),
            old_path: None,
            status: "M".into(),
            additions: 2,
            deletions: 1,
            binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -1,3 +1,4 @@".into(),
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 4,
                lines: vec![l("ctx", "a"), l("del", "b"), l("add", "B"), l("add", "C"), l("ctx", "d")],
            }],
        }
    }

    #[test]
    fn hunk() {
        let p = build_hunk_patch(&file(), 0).unwrap();
        assert_eq!(
            p,
            "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n d\n"
        );
        assert!(build_hunk_patch(&file(), 1).is_err());
    }

    #[test]
    fn lines_stage() {
        // seleccionar solo "+B" (idx 2): del b -> ctx, +C omitido
        let p = build_lines_patch(&file(), 0, &[2], false).unwrap();
        assert!(p.ends_with("@@ -1,3 +1,4 @@\n a\n b\n+B\n d\n"));
        // old: a,b,d=3 ; new: a,b,B,d=4
    }

    #[test]
    fn lines_unstage() {
        // seleccionar solo "-b" (idx 1): +B, +C -> ctx
        let p = build_lines_patch(&file(), 0, &[1], true).unwrap();
        assert!(p.ends_with("@@ -1,5 +1,4 @@\n a\n-b\n B\n C\n d\n"));
        // unselected del omitido en reverse
        let p = build_lines_patch(&file(), 0, &[3], true).unwrap();
        assert!(p.ends_with("@@ -1,3 +1,4 @@\n a\n B\n+C\n d\n"));
    }

    #[test]
    fn lines_empty_selection() {
        assert!(build_lines_patch(&file(), 0, &[0, 4], false).is_err());
    }
}
