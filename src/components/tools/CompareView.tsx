import { useEffect, useMemo, useState } from "react";
import { GitCompare } from "lucide-react";
import DiffViewer from "../inspector/DiffViewer";
import { diffArgs, useDiffPrefs } from "../inspector/fileUtils";
import { Empty, ErrorBox, Modal, Spinner, errMsg, rd, useLoad, useRepoPath } from "./ui";
import type { DiffFile, ToolProps } from "./types";

const STATUS_CLS: Record<string, string> = { A: "text-git-added", M: "text-git-modified", D: "text-git-deleted", R: "text-git-renamed" };

export default function CompareView({ a, b, onClose }: ToolProps & { a: string; b: string }) {
  const repoPath = useRepoPath();
  const files = useLoad<DiffFile[]>(() => rd("compare_refs", { repoPath, a, b }), [repoPath, a, b]);
  const [sel, setSel] = useState<string | null>(null);
  const ws = useDiffPrefs((s) => s.ignoreWhitespace);
  const ctx = useDiffPrefs((s) => s.context);
  const word = useDiffPrefs((s) => s.wordDiff);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const list = files.data ?? [];
  useEffect(() => { if (!sel && list.length) setSel(list[0].path); }, [list, sel]);
  useEffect(() => {
    if (!sel) { setDiff(null); return; }
    let live = true;
    setLoading(true); setErr(null);
    rd<DiffFile>("compare_file_diff", { repoPath, a, b, path: sel, ...diffArgs({ ignoreWhitespace: ws, context: ctx, wordDiff: word }) }).then(
      (d) => { if (live) { setDiff(d); setLoading(false); } },
      (e) => { if (live) { setErr(errMsg(e)); setLoading(false); } },
    );
    return () => { live = false; };
  }, [repoPath, a, b, sel, ws, ctx, word]);

  const totals = useMemo(() => list.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [list]);
  const short = (s: string) => (/^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s);

  return (
    <Modal title={`Comparar ${short(a)} … ${short(b)}`} icon={<GitCompare size={15} />} onClose={onClose} width={1180}>
      {files.loading && !files.data && <Spinner />}
      {files.error && <ErrorBox>{files.error}</ErrorBox>}
      {files.data && list.length === 0 && <Empty>Sin diferencias entre ambas referencias.</Empty>}
      {list.length > 0 && (
        <div className="flex h-[62vh] gap-3">
          <div className="w-72 shrink-0 overflow-auto rounded-md border border-line">
            <div className="sticky top-0 border-b border-line bg-panel px-3 py-1.5 text-[11px] text-gray-400">
              {list.length} archivos · <span className="text-git-added">+{totals.add}</span> <span className="text-git-deleted">−{totals.del}</span>
            </div>
            {list.map((f) => (
              <button key={f.path} onClick={() => setSel(f.path)} title={f.path}
                className={`flex w-full items-center gap-2 border-l-2 px-3 py-1 text-left transition hover:bg-line/50 ${sel === f.path ? "border-amber bg-amber/10" : "border-transparent"}`}>
                <span className={`w-3 shrink-0 font-mono text-[10px] font-bold ${STATUS_CLS[f.status[0]] ?? "text-gray-400"}`}>{f.status[0]}</span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="shrink-0 font-mono text-[10px] text-gray-500">+{f.additions} −{f.deletions}</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-line">
            {err && <ErrorBox>{err}</ErrorBox>}
            {loading && !diff && <Spinner />}
            {diff && (diff.binary
              ? <Empty>Archivo binario: sin vista de diferencias.</Empty>
              : <DiffViewer diff={diff} context="commit" rev={b} revs={{ old: a, new: b }} />)}
          </div>
        </div>
      )}
    </Modal>
  );
}
