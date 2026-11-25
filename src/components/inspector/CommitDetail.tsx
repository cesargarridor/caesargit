import { Avatar, DiffSkeleton, EmptyState } from "../layout/Visuals";
import { useEffect, useState } from "react";
import { Copy, GitCommit, History, Search, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { CommitNode, DiffFile } from "../../types/git";
import DiffViewer from "./DiffViewer";
import { statusColor } from "./WipPanel";

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function Meta(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-gray-500">{props.k}</span>
      <span className="min-w-0 flex-1 break-all text-gray-200">{props.children}</span>
    </div>
  );
}

/** Historial de un archivo: lista de commits; al elegir uno se selecciona en el grafo/inspector. */
export function FileHistoryModal({ path, onClose }: { path: string; onClose: () => void }) {
  const run = useRepoStore((s) => s.run);
  const setSelection = useRepoStore((s) => s.setSelection);
  const [items, setItems] = useState<CommitNode[] | null>(null);
  useEffect(() => {
    let live = true;
    run<CommitNode[]>("file_history", { path }).then((c) => live && setItems(c)).catch(() => live && setItems([]));
    return () => { live = false; };
  }, [path, run]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 animate-fade-in" onMouseDown={onClose}>
      <div className="flex max-h-[70vh] w-[560px] flex-col rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
          <History size={14} className="text-amber" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>File History · {path}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-amber"><X size={14} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items === null && <DiffSkeleton />}
          {items?.length === 0 && <div className="p-4 text-xs text-gray-500">Sin historial.</div>}
          {items?.map((c) => (
            <button key={c.sha} onClick={() => { setSelection({ kind: "commit", sha: c.sha }); onClose(); }}
              className="flex w-full items-center gap-2 border-b border-line/50 px-3 py-1.5 text-left text-xs hover:bg-panel">
              <span className="font-mono text-amber">{c.shortSha}</span>
              <span className="min-w-0 flex-1 truncate text-gray-200">{c.subject}</span>
              <span className="shrink-0 text-gray-500">{c.authorName}</span>
              <span className="shrink-0 text-gray-600">{new Date(c.authorDate * 1000).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function CommitDetail() {
  const selection = useRepoStore((s) => s.selection);
  const run = useRepoStore((s) => s.run);
  const setModal = useRepoStore((s) => s.setModal);
  const setSelection = useRepoStore((s) => s.setSelection);
  const toast = useRepoStore((s) => s.toast);
  const repoId = useRepoStore((s) => s.activeId);

  const sha = selection?.kind === "commit" ? selection.sha : selection?.kind === "file" ? selection.sha ?? null : null;

  const [commit, setCommit] = useState<CommitNode | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [ws, setWs] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCommit(null); setFiles([]); setFile(null); setDiff(null);
    if (!sha) return;
    let live = true;
    setLoading(true);
    Promise.all([
      run<CommitNode>("get_commit_detail", { sha }),
      run<DiffFile[]>("get_commit_files", { sha }),
    ])
      .then(([c, f]) => { if (live) { setCommit(c); setFiles(f); } })
      .catch(() => undefined)
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [sha, repoId, run]);

  useEffect(() => {
    if (!sha || !file) { setDiff(null); return; }
    let live = true;
    run<DiffFile>("get_commit_file_diff", { sha, path: file, ignoreWhitespace: ws })
      .then((d) => live && setDiff(d))
      .catch(() => live && setDiff(null));
    return () => { live = false; };
  }, [sha, file, ws, run]);

  const copy = (t: string) => {
    navigator.clipboard.writeText(t).then(() => toast("Copiado", "info")).catch(() => toast("No se pudo copiar"));
  };

  if (!sha) return <EmptyState art="select" title="Selecciona un commit" />;
  if (!commit) return (loading ? <DiffSkeleton /> : <EmptyState art="select" title="Commit no disponible" />);

  const parents = commit.parents;
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-gray-200">
      <div className="shrink-0 space-y-1.5 border-b border-line p-3">
        <div className="flex items-start gap-2">
          <GitCommit size={16} className="mt-0.5 shrink-0 text-amber" />
          <h2 className="flex-1 text-sm font-semibold text-gray-100">{commit.subject}</h2>
        </div>
        {commit.body.trim() && <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-sans text-xs text-gray-400">{commit.body.trim()}</pre>}
        <Meta k="SHA">
          <span className="font-mono">{commit.sha}</span>{" "}
          <button title="Copiar SHA" onClick={() => copy(commit.sha)} className="align-middle text-gray-500 hover:text-amber"><Copy size={11} /></button>
        </Meta>
        <Meta k="Autor"><Avatar name={commit.authorName} email={commit.authorEmail} size={16} /> {commit.authorName} &lt;{commit.authorEmail}&gt; · {fmtDate(commit.authorDate)}</Meta>
        <Meta k="Committer">{commit.committerName} &lt;{commit.committerEmail}&gt; · {fmtDate(commit.committerDate)}</Meta>
        <Meta k="Padres">
          {parents.length === 0 ? "—" : parents.map((p) => (
            <button key={p} onClick={() => setSelection({ kind: "commit", sha: p })} className="mr-2 font-mono text-amber hover:underline">{p.slice(0, 7)}</button>
          ))}
        </Meta>
        {commit.refs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {commit.refs.map((r) => (
              <span key={r.kind + r.name} className="rounded border border-line bg-elev px-1.5 text-[10px] text-gray-300">{r.name}</span>
            ))}
          </div>
        )}
      </div>

      <div className={`${diff ? "max-h-[35%]" : "flex-1"} min-h-[80px] shrink-0 overflow-y-auto`}>
        <div className="sticky top-0 border-b border-line bg-panel px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {files.length} archivo{files.length === 1 ? "" : "s"} cambiado{files.length === 1 ? "" : "s"}
        </div>
        {files.map((f) => (
          <div key={f.path} onClick={() => setFile(f.path)}
            className={`group flex cursor-pointer items-center gap-2 px-3 py-[3px] text-xs hover:bg-elev ${file === f.path ? "bg-elev shadow-glow" : ""}`}>
            <span className={`w-3 shrink-0 text-center font-mono font-bold ${statusColor(f.status.charAt(0))}`}>{f.status.charAt(0)}</span>
            <span className="min-w-0 flex-1 truncate" title={f.path}>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
            <span className="shrink-0 text-git-added">+{f.additions}</span>
            <span className="shrink-0 text-git-deleted">-{f.deletions}</span>
            <button title="Blame" onClick={(e) => { e.stopPropagation(); setModal({ kind: "blame", path: f.path, rev: commit.sha }); }} className="hidden text-gray-400 hover:text-amber group-hover:block"><Search size={12} /></button>
            <button title="File History" onClick={(e) => { e.stopPropagation(); setHistory(f.path); }} className="hidden text-gray-400 hover:text-amber group-hover:block"><History size={12} /></button>
          </div>
        ))}
      </div>

      {diff && (
        <div className="min-h-0 flex-1 border-t border-line">
          <DiffViewer diff={diff} context="commit" ignoreWhitespace={ws} onIgnoreWhitespace={setWs} />
        </div>
      )}
      {history && <FileHistoryModal path={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
