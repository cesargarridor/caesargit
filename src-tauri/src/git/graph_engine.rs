//! Motor del grafo (agente B): asignación de carriles pura + carga paginada vía executor.
use super::executor;
use super::models::{CommitNode, GraphPage, GraphRow, GraphSegment, RefLabel};
use crate::error::Result;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const PALETTE: u32 = 8;

/// Estado de carriles entre páginas: (sha esperado, colorIdx) por columna.
#[derive(Debug, Clone, Default)]
pub struct LaneState {
    pub lanes: Vec<Option<(String, u32)>>,
}

fn seg(from: usize, to: usize, color: u32, kind: &str) -> GraphSegment {
    GraphSegment { from_col: from as u32, to_col: to as u32, color_idx: color, kind: kind.into() }
}

fn free_lane(lanes: &mut Vec<Option<(String, u32)>>) -> usize {
    if let Some(i) = lanes.iter().position(|l| l.is_none()) {
        i
    } else {
        lanes.push(None);
        lanes.len() - 1
    }
}

/// Calcula filas para `commits` (topo-order, hijos antes que padres), continuando desde `state`.
pub fn compute_rows(commits: &[CommitNode], state: &mut LaneState) -> Vec<GraphRow> {
    let mut rows = Vec::with_capacity(commits.len());
    for c in commits {
        let lanes = &mut state.lanes;
        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.as_ref().is_some_and(|(s, _)| *s == c.sha))
            .map(|(i, _)| i)
            .collect();
        let had_lane = !waiting.is_empty();
        let col = match waiting.first() {
            Some(&i) => i,
            None => free_lane(lanes),
        };
        let color = match &lanes[col] {
            Some((_, k)) => *k,
            None => col as u32 % PALETTE,
        };
        let mut segs = Vec::new();
        for (i, l) in lanes.iter().enumerate() {
            if let Some((s, k)) = l {
                if *s != c.sha {
                    segs.push(seg(i, i, *k, "pass"));
                }
            }
        }
        if had_lane {
            segs.push(seg(col, col, color, "up"));
        }
        for &i in waiting.iter().skip(1) {
            let k = lanes[i].as_ref().map(|l| l.1).unwrap_or(color);
            segs.push(seg(i, col, k, "merge"));
            lanes[i] = None;
        }
        lanes[col] = None;
        if let Some(p0) = c.parents.first() {
            lanes[col] = Some((p0.clone(), color));
            segs.push(seg(col, col, color, "down"));
        }
        for p in c.parents.iter().skip(1) {
            let target = lanes.iter().position(|l| l.as_ref().is_some_and(|(s, _)| s == p));
            let (j, k) = match target {
                Some(j) => (j, lanes[j].as_ref().map(|l| l.1).unwrap_or(0)),
                None => {
                    let j = free_lane(lanes);
                    let k = j as u32 % PALETTE;
                    lanes[j] = Some((p.clone(), k));
                    (j, k)
                }
            };
            segs.push(seg(col, j, k, "branch"));
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        let max_columns = lanes.len().max(col + 1) as u32;
        rows.push(GraphRow {
            commit: c.clone(),
            column: col as u32,
            color_idx: color,
            lanes: segs,
            is_merge: c.parents.len() > 1,
            is_wip: false,
            max_columns,
        });
    }
    rows
}

/// Fila WIP (sha "WIP", padre = HEAD) en el carril de HEAD. None si HEAD no está en `rows`.
pub fn wip_row(rows: &[GraphRow], head_sha: &str) -> Option<GraphRow> {
    let h = rows.iter().find(|r| r.commit.sha == head_sha)?;
    let commit = CommitNode {
        sha: "WIP".into(),
        short_sha: "WIP".into(),
        parents: vec![head_sha.to_string()],
        author_name: String::new(),
        author_email: String::new(),
        author_date: 0,
        committer_name: String::new(),
        committer_email: String::new(),
        committer_date: 0,
        subject: "Cambios locales".into(),
        body: String::new(),
        refs: vec![],
    };
    Some(GraphRow {
        commit,
        column: h.column,
        color_idx: h.color_idx,
        lanes: vec![seg(h.column as usize, h.column as usize, h.color_idx, "down")],
        is_merge: false,
        is_wip: true,
        max_columns: h.column + 1,
    })
}

/// Ensambla la página (inserta WIP al inicio si cursor==0 y `has_wip`).
pub fn make_page(mut rows: Vec<GraphRow>, cursor: u32, limit: u32, head_sha: Option<&str>, has_wip: bool) -> GraphPage {
    let next = if rows.len() as u32 >= limit && limit > 0 { Some(cursor + rows.len() as u32) } else { None };
    if has_wip && cursor == 0 {
        if let Some(w) = head_sha.and_then(|h| wip_row(&rows, h)) {
            rows.insert(0, w);
        }
    }
    GraphPage { rows, next_cursor: next, total: None }
}

// ---------- parseo de log (formato propio de este módulo) ----------

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%D%x00%s%x00%b%x1e";

fn parse_refs(d: &str) -> Vec<RefLabel> {
    let mut out = Vec::new();
    for part in d.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
        let (name, kind) = if let Some(h) = part.strip_prefix("HEAD -> ") {
            out.push(RefLabel { name: "HEAD".into(), kind: "head".into() });
            (h.to_string(), "local")
        } else if part == "HEAD" {
            ("HEAD".to_string(), "head")
        } else if let Some(t) = part.strip_prefix("tag: ") {
            (t.to_string(), "tag")
        } else if part.contains('/') && !part.starts_with("refs/") {
            // origin/main (las ramas locales con '/' se clasifican igual; aceptable)
            (part.to_string(), "remote")
        } else {
            (part.to_string(), "local")
        };
        out.push(RefLabel { name, kind: kind.into() });
    }
    out
}

/// Parsea la salida de `git log` con `LOG_FORMAT`.
pub fn parse_log(raw: &str) -> Vec<CommitNode> {
    raw.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let f: Vec<&str> = rec.splitn(11, '\0').collect();
            if f.len() < 11 || f[0].is_empty() {
                return None;
            }
            Some(CommitNode {
                sha: f[0].into(),
                short_sha: f[0].chars().take(7).collect(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author_name: f[2].into(),
                author_email: f[3].into(),
                author_date: f[4].parse().unwrap_or(0),
                committer_name: f[5].into(),
                committer_email: f[6].into(),
                committer_date: f[7].parse().unwrap_or(0),
                refs: parse_refs(f[8]),
                subject: f[9].into(),
                body: f[10].trim_end().into(),
            })
        })
        .collect()
}

// ---------- cache de estado por repo ----------

struct Cache {
    key: String,
    /// offset -> estado de carriles justo antes de ese offset
    states: HashMap<u32, LaneState>,
}
static CACHE: Lazy<Mutex<HashMap<PathBuf, Cache>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Filtros opcionales del grafo (ya validados por el comando).
#[derive(Debug, Clone, Default)]
pub struct GraphFilter {
    pub include_refs: Vec<String>,
    pub exclude_refs: Vec<String>,
    pub author: Option<String>,
    /// Ruta relativa ya validada (`path_guard::safe_rel`).
    pub path: Option<String>,
    pub grep: Option<String>,
    pub since: Option<String>,
    /// ('S' | 'G', texto)
    pub pickaxe: Option<(char, String)>,
    pub include_stashes: bool,
}

impl GraphFilter {
    /// Con estos filtros git no reescribe padres: se dibujan nodos sueltos.
    fn strips_parents(&self) -> bool {
        self.author.is_some() || self.grep.is_some() || self.since.is_some() || self.pickaxe.is_some()
    }
}

async fn stash_shas(repo: &Path) -> Vec<String> {
    executor::read(repo, &["stash", "list", "--format=%H"])
        .await
        .map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

async fn cache_key(repo: &Path, f: &GraphFilter, stashes: &[String]) -> Result<String> {
    // Clave de invalidación: todos los refs + HEAD + filtros + stashes.
    let refs = executor::read(repo, &["for-each-ref", "--format=%(objectname) %(refname)"]).await?;
    let head = executor::read(repo, &["rev-parse", "-q", "--verify", "HEAD"]).await.unwrap_or_default();
    Ok(format!("{}\n{}\n{:?}\n{}", head.trim(), refs, f, stashes.join(",")))
}

/// Devuelve (commits tras ocultar los internos de stash, número de commits crudos leídos).
async fn log_slice(repo: &Path, skip: u32, count: u32, f: &GraphFilter, stashes: &[String]) -> Result<(Vec<CommitNode>, u32)> {
    let skip_a = format!("--skip={skip}");
    let max_a = format!("--max-count={count}");
    let mut args: Vec<String> =
        vec!["log".into(), "--topo-order".into(), "--parents".into(), "--decorate=short".into(), LOG_FORMAT.into(), skip_a, max_a];
    if f.include_refs.is_empty() {
        // Los stashes solo salen como nodos propios (`include_stashes`), nunca con sus commits internos.
        args.push("--exclude=refs/stash".into());
        for n in &f.exclude_refs {
            for pre in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
                args.push(format!("--exclude={pre}{n}"));
            }
        }
        args.push("--all".into());
    } else {
        args.extend(f.include_refs.iter().cloned());
    }
    if f.include_stashes {
        args.extend(stashes.iter().cloned());
    }
    if let Some(a) = &f.author {
        args.push(format!("--author={a}"));
    }
    if let Some(g) = &f.grep {
        args.extend(["-i".into(), "--fixed-strings".into(), format!("--grep={g}")]);
    }
    if let Some(s) = &f.since {
        args.push(format!("--since={s}"));
    }
    if let Some((m, t)) = &f.pickaxe {
        args.push(format!("-{m}{t}"));
    }
    if let Some(p) = &f.path {
        args.push("--".into());
        args.push(p.clone());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = executor::read(repo, &refs).await?;
    let mut commits = parse_log(&raw);
    let n_raw = commits.len() as u32;
    if f.strips_parents() {
        for c in &mut commits {
            c.parents.clear();
        }
    }
    if f.include_stashes && !stashes.is_empty() {
        let mut internal = std::collections::HashSet::new();
        for c in &commits {
            if stashes.contains(&c.sha) {
                internal.extend(c.parents.iter().skip(1).cloned());
            }
        }
        commits.retain(|c| !internal.contains(&c.sha));
        for c in &mut commits {
            if let Some(i) = stashes.iter().position(|s| *s == c.sha) {
                c.parents.truncate(1);
                c.refs.push(RefLabel { name: format!("stash@{{{i}}}"), kind: "stash".into() });
            }
        }
    }
    Ok((commits, n_raw))
}

/// Página del grafo. Reutiliza el estado de carriles cacheado del cursor si existe;
/// si no, recomputa desde 0 hasta cursor. `cursor`/`next_cursor` cuentan commits crudos de git.
pub async fn get_graph(repo: &Path, cursor: u32, limit: u32, has_wip: bool, filter: &GraphFilter) -> Result<GraphPage> {
    let stashes = if filter.include_stashes { stash_shas(repo).await } else { Vec::new() };
    let key = cache_key(repo, filter, &stashes).await?;
    let mut state = {
        let mut c = CACHE.lock().unwrap();
        let e = c.entry(repo.to_path_buf()).or_insert_with(|| Cache { key: key.clone(), states: HashMap::new() });
        if e.key != key {
            e.key = key.clone();
            e.states.clear();
        }
        e.states.get(&cursor).cloned()
    };
    if state.is_none() {
        let mut st = LaneState::default();
        if cursor > 0 {
            let (prev, _) = log_slice(repo, 0, cursor, filter, &stashes).await?;
            compute_rows(&prev, &mut st);
        }
        state = Some(st);
    }
    let mut st = state.unwrap();
    let (commits, n_raw) = log_slice(repo, cursor, limit, filter, &stashes).await?;
    let rows = compute_rows(&commits, &mut st);
    {
        let mut c = CACHE.lock().unwrap();
        if let Some(e) = c.get_mut(repo) {
            if e.key == key {
                e.states.insert(cursor + n_raw, st);
            }
        }
    }
    let head = executor::read(repo, &["rev-parse", "-q", "--verify", "HEAD"]).await.ok();
    let mut page = make_page(rows, cursor, limit, head.as_deref().map(str::trim), has_wip);
    page.next_cursor = if n_raw >= limit && limit > 0 { Some(cursor + n_raw) } else { None };
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> CommitNode {
        CommitNode {
            sha: sha.into(),
            short_sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            author_name: "a".into(),
            author_email: "a@x".into(),
            author_date: 0,
            committer_name: "a".into(),
            committer_email: "a@x".into(),
            committer_date: 0,
            subject: sha.into(),
            body: String::new(),
            refs: vec![],
        }
    }
    fn kinds(r: &GraphRow) -> Vec<&str> {
        r.lanes.iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn linear() {
        let rows = compute_rows(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])], &mut LaneState::default());
        assert!(rows.iter().all(|r| r.column == 0 && r.max_columns == 1));
        assert_eq!(kinds(&rows[0]), vec!["down"]);
        assert_eq!(kinds(&rows[1]), vec!["up", "down"]);
        assert_eq!(kinds(&rows[2]), vec!["up"]);
    }

    #[test]
    fn merge_and_converge() {
        let rows = compute_rows(
            &[c("m", &["a", "b"]), c("a", &["base"]), c("b", &["base"]), c("base", &[])],
            &mut LaneState::default(),
        );
        assert!(rows[0].is_merge);
        assert_eq!(kinds(&rows[0]), vec!["down", "branch"]);
        assert_eq!((rows[1].column, rows[2].column, rows[3].column), (0, 1, 0));
        assert!(rows[3].lanes.iter().any(|s| s.kind == "merge" && s.from_col == 1 && s.to_col == 0));
        assert_eq!(rows[0].max_columns, 2);
        assert_eq!(rows[3].max_columns, 1);
        assert_ne!(rows[0].lanes[1].color_idx, rows[0].color_idx);
    }

    #[test]
    fn long_branch_pass() {
        let rows = compute_rows(
            &[c("m", &["a", "b"]), c("b1", &["b"]), c("a", &["r"]), c("b", &["r"]), c("r", &[])],
            &mut LaneState::default(),
        );
        assert!(rows[2].lanes.iter().any(|s| s.kind == "pass" && s.from_col == 1));
    }

    #[test]
    fn octopus() {
        let rows = compute_rows(
            &[c("o", &["a", "b", "c"]), c("a", &[]), c("b", &[]), c("c", &[])],
            &mut LaneState::default(),
        );
        assert_eq!(rows[0].lanes.iter().filter(|s| s.kind == "branch").count(), 2);
        assert_eq!(rows[0].max_columns, 3);
        assert_eq!((rows[2].column, rows[3].column), (1, 2));
    }

    #[test]
    fn pagination_equals_whole() {
        let all = [c("c", &["b"]), c("b", &["a", "x"]), c("x", &["a"]), c("a", &[])];
        let whole = compute_rows(&all, &mut LaneState::default());
        let mut st = LaneState::default();
        let mut parts = compute_rows(&all[..2], &mut st);
        parts.extend(compute_rows(&all[2..], &mut st));
        assert_eq!(
            whole.iter().map(|r| (r.column, r.color_idx)).collect::<Vec<_>>(),
            parts.iter().map(|r| (r.column, r.color_idx)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn wip() {
        let rows = compute_rows(&[c("h", &[])], &mut LaneState::default());
        let p = make_page(rows, 0, 10, Some("h"), true);
        assert!(p.rows[0].is_wip && p.next_cursor.is_none());
        assert_eq!(p.rows.len(), 2);
    }

    #[test]
    fn log_parse() {
        let raw = "aaaaaaaa1\0bbbbbbbb2 cccccccc3\0N\0n@x\x00100\0N\0n@x\x00101\0HEAD -> main, tag: v1, origin/main\0subj\0body\n\x1e\nbbbbbbbb2\0\0N\0n@x\x00100\0N\0n@x\x00101\0\0s2\0\x1e";
        let v = parse_log(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].parents.len(), 2);
        assert_eq!(v[0].short_sha, "aaaaaaa");
        assert_eq!(v[0].body, "body");
        let k: Vec<_> = v[0].refs.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(k, vec!["head", "local", "tag", "remote"]);
        assert!(v[1].parents.is_empty());
    }

    #[tokio::test]
    async fn real_repo() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let g = |a: &[&str]| {
            let s = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(a).current_dir(p).output().unwrap();
            assert!(s.status.success(), "{:?}", a);
        };
        g(&["init", "-q", "-b", "main"]);
        for i in 0..3 {
            g(&["commit", "-q", "--allow-empty", "-m", &format!("c{i}")]);
        }
        let page = get_graph(p, 0, 2, true, &GraphFilter::default()).await.unwrap();
        assert_eq!(page.rows.len(), 3); // WIP + 2
        assert_eq!(page.next_cursor, Some(2));
        let page2 = get_graph(p, 2, 2, false, &GraphFilter::default()).await.unwrap();
        assert_eq!(page2.rows.len(), 1);
        assert_eq!(page2.next_cursor, None);
    }
}
