import { DiffSkeleton } from "../layout/Visuals";
import { laneVar } from "../../lib/themes";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { BlameLine } from "../../types/git";

interface Props {
  path: string;
  rev?: string;
  onClose?: () => void;
}


export default function BlameModal({ path, rev, onClose }: Props) {
  const run = useRepoStore((s) => s.run);
  const setModal = useRepoStore((s) => s.setModal);
  const setSelection = useRepoStore((s) => s.setSelection);
  const [lines, setLines] = useState<BlameLine[] | null>(null);
  const close = onClose ?? (() => setModal(null));

  useEffect(() => {
    let live = true;
    setLines(null);
    run<BlameLine[]>("blame_file", { path, rev: rev ?? null })
      .then((l) => live && setLines(l))
      .catch(() => live && setLines([]));
    return () => { live = false; };
  }, [path, rev, run]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const colorOf = (sha: string) => {
    let n = 0;
    for (let i = 0; i < sha.length; i++) n = (n * 31 + sha.charCodeAt(i)) >>> 0;
    return laneVar(n);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 animate-fade-in" onMouseDown={close}>
      <div className="flex h-[80vh] w-[min(1100px,92vw)] flex-col rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
          <span className="font-semibold text-amber">Blame</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-300" title={path}>
            {path}{rev ? ` @ ${rev.slice(0, 7)}` : ""}
          </span>
          <button onClick={close} className="text-gray-400 hover:text-amber"><X size={15} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-app font-mono text-xs">
          {lines === null && <DiffSkeleton />}
          {lines?.length === 0 && <div className="p-4 text-gray-500">Sin datos de blame.</div>}
          {lines?.map((l, i) => {
            const first = i === 0 || lines[i - 1].sha !== l.sha;
            return (
              <div key={l.lineNo} className={`flex hover:bg-elev ${first ? "border-t border-line/40" : ""}`}>
                <button
                  disabled={!first}
                  onClick={() => { setSelection({ kind: "commit", sha: l.sha }); close(); }}
                  title={first ? `${l.sha} · ${new Date(l.date * 1000).toLocaleString()}` : undefined}
                  className="flex w-64 shrink-0 items-center gap-2 border-r border-line px-2 text-left"
                  style={{ borderLeft: `3px solid ${colorOf(l.sha)}` }}
                >
                  {first && (
                    <>
                      <span style={{ color: colorOf(l.sha) }}>{l.sha.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate text-gray-400">{l.author}</span>
                      <span className="shrink-0 text-gray-600">{new Date(l.date * 1000).toLocaleDateString()}</span>
                    </>
                  )}
                </button>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-gray-600">{l.lineNo}</span>
                <pre className="m-0 flex-1 whitespace-pre text-gray-200">{l.content}</pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
