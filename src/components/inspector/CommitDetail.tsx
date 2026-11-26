import { Avatar, DiffSkeleton, EmptyState } from "../layout/Visuals";
import { useEffect, useMemo, useState } from "react";
import { Cherry, Copy, Files, GitCompare, History, Search, Undo2, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { CommitNode, DiffFile } from "../../types/git";
import DiffViewer from "./DiffViewer";
import FileFinder from "./FileFinder";
import { FileHistoryModal } from "./FileHistoryModal";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { FileList, ViewToggle } from "./FileTree";
import { copyText, diffArgs, fmtDate, statusColor, useDiffPrefs } from "./fileUtils";

export { fmtDate } from "./fileUtils";
export { FileHistoryModal } from "./FileHistoryModal";

const STASH_RE = /^stash@\{(\d+)\}$/;

function Meta(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-gray-500">{props.k}</span>
      <span className="min-w-0 flex-1 break-all text-gray-200">{props.children}</span>
    </div>
  );
}

export default function CommitDetail() {
  const selection = useRepoStore((s) => s.selection);
  const run = useRepoStore((s) => s.run);
  const act = useRepoStore((s) => s.act);
  const ask = useRepoStore((s) => s.ask);
  const confirm = useRepoStore((s) => s.confirm);
  const setModal = useRepoStore((s) => s.setModal);
  const setSelection = useRepoStore((s) => s.setSelection);
  const repoId = useRepoStore((s) => s.activeId);
  const rows = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.rows);
  const prefs = useDiffPrefs();
  const menu = useContextMenu<MenuItem[]>();

  const rawSha = selection?.kind === "commit" ? selection.sha : selection?.kind === "file" ? selection.sha ?? null : null;
  // soporta selección de stash por nombre (stash@{n}): se resuelve al sha real del nodo del grafo
  const sha = useMemo(() => {
    if (!rawSha) return null;
    const m = STASH_RE.exec(rawSha);
    if (!m) return rawSha;
    return rows?.find((r) => r.commit.refs.some((x) => x.kind === "stash" && x.name === rawSha))?.commit.sha ?? rawSha;
  }, [rawSha, rows]);
  const stashIndex = useMemo(() => {
    if (!sha) return null;
    const m = rawSha ? STASH_RE.exec(rawSha) : null;
    if (m) return Number(m[1]);
    const ref = rows?.find((r) => r.commit.sha === sha)?.commit.refs.find((x) => x.kind === "stash");
    const mm = ref ? STASH_RE.exec(ref.name) : null;
    return mm ? Number(mm[1]) : null;
  }, [rawSha, sha, rows]);

  const [commit, setCommit] = useState<CommitNode | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [allFiles, setAllFiles] = useState(false);

  useEffect(() => {
    setCommit(null); setFiles([]); setFile(null); setDiff(null); setAllFiles(false);
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
    run<DiffFile>("get_commit_file_diff", { sha, path: file, ...diffArgs(prefs) })
      .then((d) => live && setDiff(d))
      .catch(() => live && setDiff(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha, file, prefs.ignoreWhitespace, prefs.context, prefs.wordDiff, run]);

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => menu.open(e, items);
  const compare = (a: string, b: string) => setModal({ kind: "compare", a, b });

  if (!sha) return <EmptyState art="select" title="Selecciona un commit" />;
  if (!commit) return (loading ? <DiffSkeleton /> : <EmptyState art="select" title="Commit no disponible" />);

  const parents = commit.parents;
  const isStash = stashIndex !== null;
  const stashRef = `stash@{${stashIndex}}`;

  const doRevert = async () => {
    const ok = await confirm({ title: "Revert", message: `Se creará un commit que deshace ${commit.shortSha}.`, confirmLabel: "Revert" });
    if (ok) await act("revert_commit", { shas: [commit.sha] });
  };
  const stashEditMsg = async () => {
    const r = await ask({ title: "Editar mensaje del stash", fields: [{ key: "message", label: "Mensaje", initial: commit.subject }], confirmLabel: "Guardar" });
    if (r && r.message.trim()) await act("stash_rename", { index: stashIndex, message: r.message.trim() });
  };
  const stashDrop = async () => {
    const ok = await confirm({ title: "Borrar stash", message: `${stashRef} se eliminará.`, confirmLabel: "Borrar", danger: true });
    if (ok) { await act("stash_drop", { index: stashIndex }); setSelection(null); }
  };

  const fileMenu = (f: DiffFile): MenuItem[] => [
    { label: "Open file at this commit", onClick: () => { setFile(f.path); } },
    { label: "File history", onClick: () => setHistory(f.path) },
    { label: "Blame", onClick: () => setModal({ kind: "blame", path: f.path, rev: commit.sha }) },
    ...(isStash ? [{ label: "Apply this file from stash", onClick: () => void act("stash_apply_file", { index: stashIndex, path: f.path }) }] : []),
    { sep: true },
    { label: "Copy file path", onClick: () => copyText(f.path) },
  ];

  const renderFile = (f: DiffFile, ctx: { depth: number; tree: boolean }) => {
    const name = ctx.tree ? f.path.slice(f.path.lastIndexOf("/") + 1) : f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    return (
      <div key={f.path} onClick={() => setFile(f.path)} onContextMenu={(e) => openMenu(e, fileMenu(f))}
        style={ctx.tree ? { paddingLeft: 8 + ctx.depth * 12 } : undefined}
        className={`group flex cursor-pointer items-center gap-2 py-[3px] pr-3 text-xs hover:bg-elev ${ctx.tree ? "" : "pl-3"} ${file === f.path ? "bg-elev shadow-glow" : ""}`}>
        <span className={`w-3 shrink-0 text-center font-mono font-bold ${statusColor(f.status.charAt(0))}`}>{f.status.charAt(0)}</span>
        <span className="min-w-0 flex-1 truncate" title={f.path}>{name}</span>
        <span className="shrink-0 text-git-added">+{f.additions}</span>
        <span className="shrink-0 text-git-deleted">-{f.deletions}</span>
        <button title="Blame" onClick={(e) => { e.stopPropagation(); setModal({ kind: "blame", path: f.path, rev: commit.sha }); }} className="hidden text-gray-400 hover:text-amber group-hover:block"><Search size={12} /></button>
        <button title="File History" onClick={(e) => { e.stopPropagation(); setHistory(f.path); }} className="hidden text-gray-400 hover:text-amber group-hover:block"><History size={12} /></button>
      </div>
    );
  };

  const btn = "flex items-center gap-1 rounded border border-line px-2 py-0.5 text-xs text-gray-200 hover:border-amber hover:text-amber";
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-gray-200">
      <div className="shrink-0 space-y-1.5 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <Avatar name={commit.authorName} email={commit.authorEmail} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-gray-100" title={`${commit.authorName} <${commit.authorEmail}>`}>{commit.authorName}</div>
            <div className="text-[11px] text-gray-500">{fmtDate(commit.authorDate)}</div>
          </div>
          {isStash && <span className="rounded border border-amber px-1.5 text-[10px] text-amber">{stashRef}</span>}
        </div>
        <h2 className="text-sm font-semibold text-gray-100">{commit.subject}</h2>
        {commit.body.trim() && <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-sans text-xs text-gray-400">{commit.body.trim()}</pre>}
        <Meta k="SHA">
          <button title="Copiar SHA" onClick={() => copyText(commit.sha)} className="inline-flex items-center gap-1 font-mono hover:text-amber">
            {commit.sha} <Copy size={11} className="text-gray-500" />
          </button>
        </Meta>
        {(commit.committerName !== commit.authorName || commit.committerDate !== commit.authorDate) && (
          <Meta k="Committer">{commit.committerName} &lt;{commit.committerEmail}&gt; · {fmtDate(commit.committerDate)}</Meta>
        )}
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
        <div className="flex flex-wrap gap-1.5 pt-1">
          {isStash ? (
            <>
              <button className={btn} onClick={() => void act("stash_apply", { index: stashIndex })}>Apply</button>
              <button className={btn} onClick={() => void act("stash_pop", { index: stashIndex })}>Pop</button>
              <button className={btn} onClick={() => void stashEditMsg()}>Edit message</button>
              <button className={`${btn} hover:!border-git-deleted hover:!text-git-deleted`} onClick={() => void stashDrop()}><X size={12} /> Drop</button>
            </>
          ) : (
            <>
              <button className={btn} onClick={(e) => openMenu(e, [
                ...(parents[0] ? [{ label: `Con su padre (${parents[0].slice(0, 7)})`, onClick: () => compare(parents[0], commit.sha) }] : []),
                { label: "Con HEAD", onClick: () => compare(commit.sha, "HEAD") },
              ])}><GitCompare size={12} /> Compare</button>
              <button className={btn} onClick={() => void act("cherry_pick", { shas: [commit.sha] })}><Cherry size={12} /> Cherry-pick</button>
              <button className={btn} onClick={() => void doRevert()}><Undo2 size={12} /> Revert</button>
            </>
          )}
          <button className={btn} onClick={() => setAllFiles(true)}><Files size={12} /> View all files</button>
        </div>
      </div>

      <div className={`${diff ? "max-h-[35%]" : "flex-1"} min-h-[80px] shrink-0 overflow-y-auto`}>
        <div className="sticky top-0 z-10 flex items-center border-b border-line bg-panel px-3 py-1 text-[11px] font-semibold tracking-wide text-gray-400">
          <span className="flex-1">{files.length} file{files.length === 1 ? "" : "s"} changed</span>
          <ViewToggle />
        </div>
        <FileList items={files} view={prefs.fileView} renderFile={renderFile} id="c" />
      </div>

      {diff && (
        <div className="min-h-0 flex-1 border-t border-line">
          <DiffViewer diff={diff} context="commit" rev={commit.sha} onClose={() => setFile(null)} />
        </div>
      )}

      {allFiles && (
        <div className="fixed inset-4 z-50 flex flex-col rounded-lg border border-line bg-app shadow-2xl animate-pop-in">
          <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 text-sm">
            <span className="font-semibold text-amber">{commit.shortSha}</span>
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
            <span className="text-xs text-gray-500">{files.length} files</span>
            <button onClick={() => setAllFiles(false)} className="text-gray-400 hover:text-amber"><X size={15} /></button>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel">
              <div className="flex justify-end border-b border-line px-2 py-1"><ViewToggle /></div>
              <FileList items={files} view={prefs.fileView} renderFile={renderFile} id="all" />
            </div>
            <div className="min-w-0 flex-1">
              {diff ? <DiffViewer diff={diff} context="commit" rev={commit.sha} onClose={() => setAllFiles(false)} /> : <EmptyState art="diff" title="Elige un archivo" />}
            </div>
          </div>
        </div>
      )}

      {menu.menu && <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.data} onClose={menu.close} />}
      {history && <FileHistoryModal path={history} onClose={() => setHistory(null)} />}
      <FileFinder suggestions={files.map((f) => f.path)} />
    </div>
  );
}
