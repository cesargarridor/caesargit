//! Parseo de marcadores de conflicto (agente B), incl. diff3.
use super::models::{ConflictFile, ConflictRegion};

/// Parsea `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`. Líneas 0-index del texto dado.
/// Marcadores mal formados (sin cierre) se ignoran.
pub fn parse_regions(merged: &str) -> Vec<ConflictRegion> {
    #[derive(PartialEq)]
    enum St {
        Out,
        Ours,
        Base,
        Theirs,
    }
    let mut regions = Vec::new();
    let mut st = St::Out;
    let (mut start, mut ours, mut base, mut theirs) = (0u32, vec![], vec![], vec![]);
    for (i, line) in merged.lines().enumerate() {
        let i = i as u32;
        match st {
            St::Out => {
                if line.starts_with("<<<<<<<") && (line.len() == 7 || line.as_bytes()[7] == b' ') {
                    st = St::Ours;
                    start = i;
                    ours = vec![];
                    base = vec![];
                    theirs = vec![];
                }
            }
            St::Ours => {
                if line.starts_with("|||||||") {
                    st = St::Base;
                } else if line == "=======" {
                    st = St::Theirs;
                } else {
                    ours.push(line.to_string());
                }
            }
            St::Base => {
                if line == "=======" {
                    st = St::Theirs;
                } else {
                    base.push(line.to_string());
                }
            }
            St::Theirs => {
                if line.starts_with(">>>>>>>") {
                    regions.push(ConflictRegion {
                        start_line: start,
                        end_line: i,
                        ours_lines: std::mem::take(&mut ours),
                        theirs_lines: std::mem::take(&mut theirs),
                        base_lines: std::mem::take(&mut base),
                    });
                    st = St::Out;
                } else {
                    theirs.push(line.to_string());
                }
            }
        }
    }
    regions
}

pub fn has_markers(content: &str) -> bool {
    !parse_regions(content).is_empty()
}

/// Ensambla el ConflictFile. `ours/theirs/base` = salida de `git show :2:/:3:/:1:path`
/// (base None si el stage 1 no existe). `merged` = contenido del worktree con marcadores.
pub fn build_conflict_file(
    path: &str,
    ours: String,
    theirs: String,
    base: Option<String>,
    merged: String,
) -> ConflictFile {
    let regions = parse_regions(&merged);
    ConflictFile { path: path.to_string(), ours, theirs, base, merged, regions }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple() {
        let t = "a\n<<<<<<< HEAD\nx\ny\n=======\nz\n>>>>>>> feat\nb\n";
        let r = parse_regions(t);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].start_line, r[0].end_line), (1, 6));
        assert_eq!(r[0].ours_lines, vec!["x", "y"]);
        assert_eq!(r[0].theirs_lines, vec!["z"]);
        assert!(r[0].base_lines.is_empty());
    }

    #[test]
    fn diff3_and_multiple() {
        let t = "<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> o\nmid\n<<<<<<< HEAD\n=======\nq\n>>>>>>> o\n";
        let r = parse_regions(t);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].base_lines, vec!["b"]);
        assert_eq!(r[1].start_line, 8);
        assert!(r[1].ours_lines.is_empty());
        assert_eq!(r[1].theirs_lines, vec!["q"]);
    }

    #[test]
    fn none_and_unclosed() {
        assert!(!has_markers("hola\n"));
        assert!(parse_regions("<<<<<<< HEAD\na\n=======\nb\n").is_empty());
    }
}
