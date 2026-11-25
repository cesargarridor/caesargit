//! Parsers de la salida de git (NUL / 0x1e como separadores donde es posible).
use crate::git::models::*;
use std::collections::HashMap;
use std::path::Path;

/// Args de status: `git status --porcelain=v2 -z --branch`.
/// Args de log: `git log -z? ...` ver `LOG_FORMAT` (usar `--format=` + `LOG_FORMAT`, `--decorate=full`).
pub const LOG_FORMAT: &str = "%x1e%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b%x00%D";
/// `git for-each-ref --format=<BRANCH_FORMAT> refs/heads refs/remotes`
pub const BRANCH_FORMAT: &str = "%(HEAD)%00%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)";
/// `git for-each-ref --format=<TAG_FORMAT> refs/tags`
pub const TAG_FORMAT: &str = "%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(contents:subject)";
/// `git stash list --format=<STASH_FORMAT>`
pub const STASH_FORMAT: &str = "%gd%x00%gs%x00%ct%x1e";

fn is_conflict_code(x: char, y: char) -> bool {
    matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'))
}

/// Parsea `git status --porcelain=v2 -z --branch`. `operation` se rellena aparte (`detect_operation`).
pub fn parse_status(out: &str) -> RepoStatus {
    let mut st = RepoStatus::default();
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                st.head_sha = if v == "(initial)" { None } else { Some(v.to_string()) };
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                st.branch = if v == "(detached)" { None } else { Some(v.to_string()) };
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for p in v.split(' ') {
                    if let Some(n) = p.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = p.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' | b'2' | b'u' => {
                let nfields = match kind {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let parts: Vec<&str> = rec.splitn(nfields, ' ').collect();
                if parts.len() < nfields {
                    continue;
                }
                let mut xy = parts[1].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                let norm = |c: char| if c == '.' { ' ' } else { c };
                let (x, y) = (norm(x), norm(y));
                let path = parts[nfields - 1].to_string();
                let orig_path = if kind == b'2' { it.next().map(|s| s.to_string()) } else { None };
                let conflicted = kind == b'u' || is_conflict_code(x, y);
                st.files.push(FileChange {
                    path,
                    orig_path,
                    index: x,
                    worktree: y,
                    staged: !conflicted && x != ' ',
                    unstaged: conflicted || y != ' ',
                    conflicted,
                });
            }
            b'?' => {
                if let Some(p) = rec.strip_prefix("? ") {
                    st.files.push(FileChange {
                        path: p.to_string(),
                        orig_path: None,
                        index: '?',
                        worktree: '?',
                        staged: false,
                        unstaged: true,
                        conflicted: false,
                    });
                }
            }
            _ => {} // '!' ignorados u otros
        }
    }
    st
}

/// Detecta merge/rebase/cherry-pick/revert mirando el directorio .git.
pub fn detect_operation(git_dir: &Path) -> Option<String> {
    let has = |n: &str| git_dir.join(n).exists();
    if has("rebase-merge") || has("rebase-apply") {
        Some("rebase".into())
    } else if has("MERGE_HEAD") {
        Some("merge".into())
    } else if has("CHERRY_PICK_HEAD") {
        Some("cherry-pick".into())
    } else if has("REVERT_HEAD") {
        Some("revert".into())
    } else {
        None
    }
}

fn parse_refs(d: &str) -> Vec<RefLabel> {
    let mut v = Vec::new();
    for item in d.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
        let mk = |name: &str, kind: &str| RefLabel { name: name.to_string(), kind: kind.to_string() };
        if let Some(t) = item.strip_prefix("tag: ") {
            v.push(mk(t.strip_prefix("refs/tags/").unwrap_or(t), "tag"));
        } else if let Some(b) = item.strip_prefix("HEAD -> ") {
            v.push(mk("HEAD", "head"));
            v.push(mk(b.strip_prefix("refs/heads/").unwrap_or(b), "local"));
        } else if item == "HEAD" {
            v.push(mk("HEAD", "head"));
        } else if let Some(r) = item.strip_prefix("refs/remotes/") {
            if !r.ends_with("/HEAD") {
                v.push(mk(r, "remote"));
            }
        } else if let Some(b) = item.strip_prefix("refs/heads/") {
            v.push(mk(b, "local"));
        } else if let Some(t) = item.strip_prefix("refs/tags/") {
            v.push(mk(t, "tag"));
        } else if item.contains('/') && !item.starts_with("refs/") {
            // Sin --decorate=full no se distingue de una rama local con '/': se asume remota.
            if !item.ends_with("/HEAD") {
                v.push(mk(item, "remote"));
            }
        } else if !item.starts_with("refs/") {
            v.push(mk(item, "local"));
        }
    }
    v
}

/// Parsea la salida de `git log --format=<LOG_FORMAT> --decorate=full`.
pub fn parse_log(out: &str) -> Vec<CommitNode> {
    out.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(12, '\0').collect();
            if f.len() < 12 || f[0].is_empty() {
                return None;
            }
            Some(CommitNode {
                sha: f[0].to_string(),
                short_sha: f[1].to_string(),
                parents: f[2].split_whitespace().map(String::from).collect(),
                author_name: f[3].to_string(),
                author_email: f[4].to_string(),
                author_date: f[5].parse().unwrap_or(0),
                committer_name: f[6].to_string(),
                committer_email: f[7].to_string(),
                committer_date: f[8].parse().unwrap_or(0),
                subject: f[9].to_string(),
                body: f[10].trim_end().to_string(),
                refs: parse_refs(f[11].trim()),
            })
        })
        .collect()
}

/// Parsea ramas (`BRANCH_FORMAT`), una por línea.
pub fn parse_branches(out: &str) -> Vec<BranchInfo> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 5 {
                return None;
            }
            let refname = f[1];
            let (name, is_remote, remote) = if let Some(n) = refname.strip_prefix("refs/heads/") {
                (n.to_string(), false, None)
            } else {
                let n = refname.strip_prefix("refs/remotes/")?;
                if n.ends_with("/HEAD") || !n.contains('/') {
                    return None;
                }
                (n.to_string(), true, n.split('/').next().map(String::from))
            };
            let (mut ahead, mut behind) = (0u32, 0u32);
            for part in f[4].split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.trim().parse().unwrap_or(0);
                }
            }
            Some(BranchInfo {
                name,
                sha: f[2].to_string(),
                is_head: f[0] == "*",
                upstream: if f[3].is_empty() { None } else { Some(f[3].to_string()) },
                ahead,
                behind,
                is_remote,
                remote,
            })
        })
        .collect()
}

/// Parsea tags (`TAG_FORMAT`), una por línea.
pub fn parse_tags(out: &str) -> Vec<TagInfo> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 5 {
                return None;
            }
            let name = f[0].strip_prefix("refs/tags/")?.to_string();
            let annotated = f[2] == "tag";
            let sha = if annotated && !f[3].is_empty() { f[3] } else { f[1] };
            Some(TagInfo {
                name,
                sha: sha.to_string(),
                annotated,
                message: if annotated { Some(f[4].to_string()) } else { None },
            })
        })
        .collect()
}

/// Parsea `git stash list --format=<STASH_FORMAT>`.
pub fn parse_stashes(out: &str) -> Vec<StashEntry> {
    out.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_matches('\n').splitn(3, '\0').collect();
            if f.len() < 3 {
                return None;
            }
            let ref_name = f[0].to_string();
            let index = ref_name.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            let subject = f[1];
            let (branch, message) = if let Some(r) = subject.strip_prefix("WIP on ").or_else(|| subject.strip_prefix("On ")) {
                match r.split_once(": ") {
                    Some((b, m)) => (b.to_string(), if subject.starts_with("On ") { m.to_string() } else { subject.to_string() }),
                    None => (r.to_string(), subject.to_string()),
                }
            } else {
                (String::new(), subject.to_string())
            };
            Some(StashEntry { index, ref_name, message, branch, date: f[2].trim().parse().unwrap_or(0) })
        })
        .collect()
}

fn parse_range(s: &str) -> (u32, u32) {
    let s = s.trim_start_matches(['-', '+']);
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
        None => (s.parse().unwrap_or(0), 1),
    }
}

fn parse_hunk_header(h: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = h.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let mut p = rest[..end].split(' ');
    let (os, ol) = parse_range(p.next()?);
    let (ns, nl) = parse_range(p.next()?);
    Some((os, ol, ns, nl))
}

fn header_path(rest: &str) -> String {
    // rest = "a/X b/Y". Con espacios es ambiguo: probar cada " b/" hasta que ambos lados coincidan.
    let mut first = None;
    for (i, _) in rest.match_indices(" b/") {
        let (l, r) = (&rest[..i], &rest[i + 3..]);
        if first.is_none() {
            first = Some(r.to_string());
        }
        if l.strip_prefix("a/") == Some(r) {
            return r.to_string();
        }
    }
    first.unwrap_or_else(|| rest.to_string())
}

/// Parsea un diff unificado (`git diff`, `git show`, `git diff-tree -p`) a archivos con hunks.
/// Las líneas `\ No newline at end of file` se descartan.
pub fn parse_diff(out: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut cur: Option<DiffFile> = None;
    let mut hunk: Option<DiffHunk> = None;
    let (mut old_no, mut new_no) = (0u32, 0u32);

    fn flush_hunk(cur: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>) {
        if let (Some(f), Some(h)) = (cur.as_mut(), hunk.take()) {
            f.hunks.push(h);
        }
    }

    for line in out.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush_hunk(&mut cur, &mut hunk);
            if let Some(f) = cur.take() {
                files.push(f);
            }
            cur = Some(DiffFile {
                path: header_path(rest),
                old_path: None,
                status: "modified".into(),
                additions: 0,
                deletions: 0,
                binary: false,
                hunks: vec![],
            });
            continue;
        }
        let Some(f) = cur.as_mut() else { continue };
        if hunk.is_none() || !(line.starts_with(['+', '-', ' ', '\\']) || line.is_empty()) {
            // zona de cabecera extendida
            if line.starts_with("@@ ") {
                flush_hunk(&mut cur, &mut hunk);
                if let Some((os, ol, ns, nl)) = parse_hunk_header(line) {
                    old_no = os;
                    new_no = ns;
                    hunk = Some(DiffHunk { header: line.to_string(), old_start: os, old_lines: ol, new_start: ns, new_lines: nl, lines: vec![] });
                }
                continue;
            }
            if hunk.is_none() {
                if line.starts_with("new file mode") {
                    f.status = "added".into();
                } else if line.starts_with("deleted file mode") {
                    f.status = "deleted".into();
                } else if let Some(p) = line.strip_prefix("rename from ") {
                    f.status = "renamed".into();
                    f.old_path = Some(p.to_string());
                } else if let Some(p) = line.strip_prefix("rename to ") {
                    f.path = p.to_string();
                } else if let Some(p) = line.strip_prefix("copy from ") {
                    f.status = "copied".into();
                    f.old_path = Some(p.to_string());
                } else if let Some(p) = line.strip_prefix("copy to ") {
                    f.path = p.to_string();
                } else if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
                    f.binary = true;
                } else if let Some(p) = line.strip_prefix("+++ b/") {
                    f.path = p.to_string();
                } else if let Some(p) = line.strip_prefix("--- a/") {
                    if f.status != "renamed" && f.status != "copied" {
                        // ruta de respaldo para borrados (+++ /dev/null)
                        f.path = p.to_string();
                    }
                }
                continue;
            }
        }
        if line.starts_with("@@ ") {
            flush_hunk(&mut cur, &mut hunk);
            if let Some((os, ol, ns, nl)) = parse_hunk_header(line) {
                old_no = os;
                new_no = ns;
                hunk = Some(DiffHunk { header: line.to_string(), old_start: os, old_lines: ol, new_start: ns, new_lines: nl, lines: vec![] });
            }
            continue;
        }
        let Some(h) = hunk.as_mut() else { continue };
        if let Some(c) = line.strip_prefix('+') {
            f.additions += 1;
            h.lines.push(DiffLine { kind: "add".into(), content: c.to_string(), old_no: None, new_no: Some(new_no) });
            new_no += 1;
        } else if let Some(c) = line.strip_prefix('-') {
            f.deletions += 1;
            h.lines.push(DiffLine { kind: "del".into(), content: c.to_string(), old_no: Some(old_no), new_no: None });
            old_no += 1;
        } else if let Some(c) = line.strip_prefix(' ') {
            h.lines.push(DiffLine { kind: "ctx".into(), content: c.to_string(), old_no: Some(old_no), new_no: Some(new_no) });
            old_no += 1;
            new_no += 1;
        }
        // '\' (no newline) y líneas vacías finales: ignoradas
    }
    flush_hunk(&mut cur, &mut hunk);
    if let Some(f) = cur.take() {
        files.push(f);
    }
    files
}

/// Parsea `git blame --porcelain`.
pub fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut meta: HashMap<String, (String, i64)> = HashMap::new();
    let mut res = Vec::new();
    let mut cur: Option<(String, u32)> = None;
    for line in out.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            if let Some((sha, no)) = cur.take() {
                let (author, date) = meta.get(&sha).cloned().unwrap_or_default();
                res.push(BlameLine { sha, author, date, line_no: no, content: content.to_string() });
            }
            continue;
        }
        let mut p = line.split(' ');
        let first = p.next().unwrap_or("");
        if first.len() >= 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            let _orig = p.next();
            let fin: u32 = p.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            meta.entry(first.to_string()).or_default();
            cur = Some((first.to_string(), fin));
        } else if let Some((sha, _)) = cur.as_ref() {
            if let Some(a) = line.strip_prefix("author ") {
                meta.entry(sha.clone()).or_default().0 = a.to_string();
            } else if let Some(t) = line.strip_prefix("author-time ") {
                meta.entry(sha.clone()).or_default().1 = t.parse().unwrap_or(0);
            }
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2() {
        let out = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a.rs\0\
1 A. N... 000000 100644 100644 000 bbb new file.txt\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? untracked.txt\0! ignored.txt\0";
        let s = parse_status(out);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.head_sha.as_deref(), Some("abc123"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.files.len(), 5);
        assert!(s.files[0].unstaged && !s.files[0].staged);
        assert_eq!(s.files[1].path, "new file.txt");
        assert!(s.files[1].staged);
        assert_eq!(s.files[2].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(s.files[2].index, 'R');
        assert!(s.files[3].conflicted);
        assert_eq!(s.files[4].index, '?');
    }

    #[test]
    fn status_detached_initial() {
        let s = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(s.head_sha.is_none() && s.branch.is_none());
    }

    #[test]
    fn log_records() {
        let rec = |h: &str, p: &str, d: &str| {
            format!("\x1e{h}\0{}\0{p}\0An\0a@x\01700000000\0Cn\0c@x\01700000100\0subj\0body line\n\0{d}\n", &h[..7])
        };
        let out = format!("{}{}", rec("aaaaaaa1111", "bbbbbbb2222 ccccccc3333", "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main"), rec("bbbbbbb2222", "", ""));
        let v = parse_log(&out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].parents.len(), 2);
        assert_eq!(v[0].author_date, 1700000000);
        assert_eq!(v[0].body, "body line");
        let kinds: Vec<_> = v[0].refs.iter().map(|r| (r.name.as_str(), r.kind.as_str())).collect();
        assert_eq!(kinds, vec![("HEAD", "head"), ("main", "local"), ("v1", "tag"), ("origin/main", "remote")]);
        assert!(v[1].parents.is_empty() && v[1].refs.is_empty());
    }

    #[test]
    fn diff_modify_and_add() {
        let d = "diff --git a/a b.txt b/a b.txt\nindex 1..2 100644\n--- a/a b.txt\n+++ b/a b.txt\n@@ -1,3 +1,3 @@ fn x\n ctx\n-old\n+new\n ctx2\n\\ No newline at end of file\n@@ -10 +10,2 @@\n x\n+y\ndiff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hello\n";
        let f = parse_diff(d);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].path, "a b.txt");
        assert_eq!((f[0].additions, f[0].deletions), (2, 1));
        assert_eq!(f[0].hunks.len(), 2);
        assert_eq!(f[0].hunks[0].lines.len(), 4);
        assert_eq!(f[0].hunks[0].lines[1].old_no, Some(2));
        assert_eq!(f[0].hunks[0].lines[2].new_no, Some(2));
        assert_eq!((f[0].hunks[1].old_start, f[0].hunks[1].old_lines, f[0].hunks[1].new_lines), (10, 1, 2));
        assert_eq!(f[1].status, "added");
        assert_eq!(f[1].hunks[0].lines[0].content, "hello");
    }

    #[test]
    fn diff_rename_delete_binary() {
        let d = "diff --git a/o.rs b/n.rs\nsimilarity index 100%\nrename from o.rs\nrename to n.rs\ndiff --git a/g.txt b/g.txt\ndeleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n";
        let f = parse_diff(d);
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].status.as_str(), f[0].path.as_str(), f[0].old_path.as_deref()), ("renamed", "n.rs", Some("o.rs")));
        assert_eq!((f[1].status.as_str(), f[1].path.as_str(), f[1].deletions), ("deleted", "g.txt", 1));
        assert!(f[2].binary);
    }

    #[test]
    fn branches_tags_stashes() {
        let b = "*\0refs/heads/main\0abc\0origin/main\0ahead 2, behind 1\n \0refs/heads/dev\0def\0\0\n \0refs/remotes/origin/main\0abc\0\0\n \0refs/remotes/origin/HEAD\0abc\0\0\n";
        let v = parse_branches(b);
        assert_eq!(v.len(), 3);
        assert!(v[0].is_head && v[0].ahead == 2 && v[0].behind == 1);
        assert!(v[1].upstream.is_none());
        assert!(v[2].is_remote && v[2].remote.as_deref() == Some("origin"));

        let t = "refs/tags/v1\0t1\0tag\0c1\0Release\nrefs/tags/light\0c2\0commit\0\0msg\n";
        let tv = parse_tags(t);
        assert_eq!(tv[0].sha, "c1");
        assert!(tv[0].annotated && tv[0].message.as_deref() == Some("Release"));
        assert!(!tv[1].annotated && tv[1].message.is_none());

        let s = "stash@{0}\0On main: mi msg\x001700000000\x1e\nstash@{1}\0WIP on dev: abc fix\x001700000001\x1e\n";
        let sv = parse_stashes(s);
        assert_eq!(sv.len(), 2);
        assert_eq!((sv[0].index, sv[0].branch.as_str(), sv[0].message.as_str()), (0, "main", "mi msg"));
        assert_eq!(sv[1].branch, "dev");
    }

    #[test]
    fn blame_porcelain() {
        let sha = "a".repeat(40);
        let out = format!("{sha} 1 1 2\nauthor Ana\nauthor-time 1700000000\nsummary s\nfilename f\n\tline one\n{sha} 2 2\n\tline two\n");
        let v = parse_blame(&out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].author, "Ana");
        assert_eq!((v[1].line_no, v[1].date), (2, 1700000000));
        assert_eq!(v[1].content, "line two");
    }

    #[test]
    fn operation_detection() {
        let d = tempfile::tempdir().unwrap();
        assert!(detect_operation(d.path()).is_none());
        std::fs::write(d.path().join("MERGE_HEAD"), "x").unwrap();
        assert_eq!(detect_operation(d.path()).as_deref(), Some("merge"));
    }
}
