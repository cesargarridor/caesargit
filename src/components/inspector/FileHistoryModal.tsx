import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Search, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { DiffSkeleton } from "../layout/Visuals";
import type { CommitNode, DiffFile } from "../../types/git";
import DiffViewer from "./DiffViewer";
import { diffArgs, useDiffPrefs } from "./fileUtils";

/** Historial de un archivo (`--follow`): lista de versiones + diff de cada una. Clic en SHA salta al commit. */
export function FileHistoryModal({ path, onClose }: { path: string; onClose: () => void }) {
  const run = useRepoStore((s) => s.run);
  const setSelection = useRepoStore((s) => s.setSelection);
  const setModal = useRepoStore((s) => s.setModal);
  const prefs = useDiffPrefs();
  const [items, setItems] = useState<CommitNode[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number>(0);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [loading, setLoading] = useState(false);
  // nombre del archivo en cada versión (los renombrados cambian la ruta)
  const names = useRef<string[]>([path]);

  useEffect(() => {
    let live = true;
    names.current = [path];
    run<CommitNode[]>("file_history", { path }).then((c) => live && setItems(c)).catch(() => live && setItems([]));
    return () => { live = false; };
  }, [path, run]);

  const nameAt = useCallback(async (i: number): Promise<string> => {
    if (!items) return path;
    while (names.current.length <= i) {
      const k = names.current.length;
      const prev = names.current[k - 1];
      let name = prev;
      try {
        const files = await run<DiffFile[]>("get_commit_files", { sha: items[k - 1].sha });
        const f = files.find((x) => x.path === prev);
        if (f?.oldPath) name = f.oldPath;
      } catch { /* mantiene el nombre */ }
      names.current.push(name);
    }
    return names.current[i];
  }, [items, path, run]);

  useEffect(() => {
    if (!items || items.length === 0) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    (async () => {
      const name = await nameAt(sel);
      const d = await run<DiffFile>("get_commit_file_diff", { sha: items[sel].sha, path: name, ...diffArgs(prefs) });
      if (live) setDiff(d);
    })().catch(() => live && setDiff(null)).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sel, nameAt, run, prefs.ignoreWhitespace, prefs.context, prefs.wordDiff]);

  const visible = useMemo(() => {
    if (!items) return [];
    const t = q.trim().toLowerCase();
    return items.map((c, i) => ({ c, i })).filter(({ c }) => !t || c.subject.toLowerCase().includes(t) || c.authorName.toLowerCase().includes(t) || c.sha.startsWith(t));
  }, [items, q]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const goto = (sha: string) => { setSelection({ kind: "commit", sha }); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-[82vh] w-[min(1200px,94vw)] flex-col rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
          <History size={14} className="text-amber" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>File History · {path}</span>
          {items && <span className="text-xs text-gray-500">{items.length} versiones (--follow)</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-amber"><X size={14} /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[340px] shrink-0 flex-col border-r border-line">
            <div className="flex items-center gap-1 border-b border-line px-2 py-1">
              <Search size={12} className="text-gray-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por mensaje, autor, sha" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {items === null && <DiffSkeleton />}
              {items?.length === 0 && <div className="p-4 text-xs text-gray-500">Sin historial.</div>}
              {visible.map(({ c, i }) => (
                <div key={c.sha} onClick={() => setSel(i)}
                  className={`cursor-pointer border-b border-line/50 px-3 py-1.5 text-xs hover:bg-panel ${sel === i ? "bg-panel shadow-glow" : ""}`}>
                  <div className="truncate text-gray-200">{c.subject}</div>
                  <div className="flex items-center gap-2 text-[11px] text-gray-500">
                    <button className="font-mono text-amber hover:underline" title="Ir al commit" onClick={(e) => { e.stopPropagation(); goto(c.sha); }}>{c.shortSha}</button>
                    <span className="min-w-0 flex-1 truncate">{c.authorName}</span>
                    <span>{new Date(c.authorDate * 1000).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {items && items[sel] && (
              <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1 text-xs">
                <span className="font-mono text-amber">{items[sel].shortSha}</span>
                <span className="flex-1 truncate text-gray-300">{items[sel].subject}</span>
                <button className="rounded border border-line px-2 py-0.5 text-gray-300 hover:border-amber hover:text-amber"
                  onClick={() => { const sha = items[sel].sha; onClose(); setModal({ kind: "blame", path: names.current[sel] ?? path, rev: sha }); }}>
                  Blame en esta versión
                </button>
                <button className="rounded border border-line px-2 py-0.5 text-gray-300 hover:border-amber hover:text-amber" onClick={() => goto(items[sel].sha)}>Ir al commit</button>
              </div>
            )}
            <div className="min-h-0 flex-1">
              {loading && !diff ? <DiffSkeleton /> : diff ? <DiffViewer diff={diff} context="commit" rev={items?.[sel]?.sha} /> : <div className="p-4 text-xs text-gray-500">Selecciona una versión.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
