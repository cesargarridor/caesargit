import { useCallback, useEffect, useState } from "react";
import { Bug, Check, SkipForward, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, rd, shortSha, useRepoPath } from "./ui";
import type { BisectStatus } from "./types";

/** Evento para forzar la relectura (p. ej. tras `bisect_start`). */
export const BISECT_CHANGED_EVENT = "caesargit:bisect-changed";

export default function BisectBanner() {
  const repoPath = useRepoPath();
  const head = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.status?.headSha ?? null);
  const [st, setSt] = useState<BisectStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!repoPath) { setSt(null); return; }
    rd<BisectStatus>("bisect_status", { repoPath }).then(setSt, () => setSt(null));
  }, [repoPath]);

  useEffect(() => { load(); }, [load, head]);
  useEffect(() => {
    window.addEventListener(BISECT_CHANGED_EVENT, load);
    return () => window.removeEventListener(BISECT_CHANGED_EVENT, load);
  }, [load]);

  if (!st?.active) return null;

  const mark = async (kind: "good" | "bad" | "skip") => {
    setBusy(true);
    const r = await useRepoStore.getState().act<BisectStatus>("bisect_mark", { kind });
    if (r) setSt(r);
    setBusy(false);
  };
  const reset = async () => {
    setBusy(true);
    const r = await useRepoStore.getState().act<BisectStatus>("bisect_reset");
    if (r) setSt(r); else load();
    setBusy(false);
  };
  const done = !!st.firstBad;
  const steps = st.remaining != null && st.remaining > 0 ? Math.ceil(Math.log2(st.remaining + 1)) : 0;

  return (
    <div className="flex items-center gap-3 border-b border-amber/40 bg-amber/10 px-4 py-2 text-xs animate-fade-in">
      <Bug size={14} className="shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        {done ? (
          <span className="text-gray-100">Bisect terminado. Primer commit malo: <span className="font-mono font-semibold text-amber">{shortSha(st.firstBad!)}</span></span>
        ) : (
          <span className="text-gray-100">
            Bisect en curso{st.current && <> · probando <span className="font-mono text-amber">{shortSha(st.current)}</span></>}
            {st.remaining != null && <span className="text-gray-400"> · {st.remaining} candidatos{steps > 0 && ` (~${steps} pasos)`}</span>}
          </span>
        )}
        <div className="mt-1 h-1 overflow-hidden rounded bg-line" title={`${st.log.length} marcas`}>
          <div className="h-full bg-amber transition-all duration-500" style={{ width: done ? "100%" : `${Math.min(95, st.log.length * 12)}%` }} />
        </div>
      </div>
      {!done && (
        <>
          <Btn small disabled={busy} onClick={() => mark("good")}><Check size={11} className="text-git-added" /> Good</Btn>
          <Btn small disabled={busy} onClick={() => mark("bad")}><X size={11} className="text-git-deleted" /> Bad</Btn>
          <Btn small disabled={busy} onClick={() => mark("skip")}><SkipForward size={11} /> Skip</Btn>
        </>
      )}
      <Btn small variant={done ? "primary" : "ghost"} disabled={busy} onClick={reset}>Reset</Btn>
    </div>
  );
}
