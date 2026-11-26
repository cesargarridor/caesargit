import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowDown, ArrowUp, GitBranch, Loader2, Minus, Plus } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { clampZoom, usePrefs } from "../../store/usePrefs";

function ago(ts: number | null, now: number): string {
  if (!ts) return "sin fetch en esta sesión";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "fetch hace unos segundos";
  if (s < 3600) return `fetch hace ${Math.round(s / 60)} min`;
  return `fetch hace ${Math.round(s / 3600)} h`;
}

/** Barra inferior (24 px): rama, ahead/behind, estado de fetch, progreso, zoom y versión. */
export function StatusBar() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const progress = useRepoStore((s) => s.progress);
  const zoom = usePrefs((s) => s.zoom);
  const setPrefs = usePrefs((s) => s.set);
  const [version, setVersion] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  const st = tab?.status;
  const busy = (tab?.busy ?? 0) > 0;
  const zbtn = "flex h-4 w-4 items-center justify-center rounded text-gray-400 hover:bg-elev hover:text-gray-100";
  return (
    <div className="flex h-[var(--h-status)] shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-gray-400">
      {tab && (
        <>
          <span className="flex items-center gap-1 font-mono text-gray-300" title={st?.upstream ?? "sin upstream"}>
            <GitBranch size={11} />{st?.branch ?? (st?.detached ? "HEAD desacoplado" : "…")}
          </span>
          {st?.upstream && (
            <span className="flex items-center gap-1.5 font-mono">
              <span className={`flex items-center ${st.ahead ? "text-amber" : ""}`}><ArrowUp size={10} />{st.ahead}</span>
              <span className={`flex items-center ${st.behind ? "text-sky-400" : ""}`}><ArrowDown size={10} />{st.behind}</span>
            </span>
          )}
          <span>{busy ? <span className="flex items-center gap-1 text-amber"><Loader2 size={11} className="animate-spin" /> trabajando…</span> : ago(tab.lastFetch, now)}</span>
        </>
      )}
      {progress && (
        <div className="flex min-w-0 items-center gap-2" title={progress.message}>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-amber transition-[width]" style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
          </div>
          <span className="max-w-[260px] truncate">{progress.op} {Math.round(progress.percent)}% {progress.message}</span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1" title="Zoom (⌘+ / ⌘− / ⌘0)">
          <button className={zbtn} onClick={() => setPrefs({ zoom: clampZoom(zoom - 10) })} aria-label="Reducir zoom"><Minus size={10} /></button>
          <button className="w-9 text-center font-mono hover:text-gray-100" onClick={() => setPrefs({ zoom: 100 })} title="Restablecer zoom">{zoom}%</button>
          <button className={zbtn} onClick={() => setPrefs({ zoom: clampZoom(zoom + 10) })} aria-label="Aumentar zoom"><Plus size={10} /></button>
        </div>
        {version && <span className="font-mono text-gray-500">v{version}</span>}
      </div>
    </div>
  );
}
