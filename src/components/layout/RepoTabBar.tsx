import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";

export function RepoTabBar() {
  const tabs = useRepoStore((s) => s.tabs);
  const activeId = useRepoStore((s) => s.activeId);
  const recents = useRepoStore((s) => s.recents);
  const { setActive, closeTab, pickAndOpen, openRepo } = useRepoStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const openPaths = new Set(tabs.map((t) => t.info.path));
  const rec = recents.filter((p) => !openPaths.has(p));

  return (
    <div className="flex h-9 items-end gap-0.5 border-b border-line bg-app px-2 pt-1">
      {tabs.map((t) => {
        const active = t.info.id === activeId;
        const dirty = (t.status?.files.length ?? 0) > 0;
        return (
          <div
            key={t.info.id}
            onClick={() => setActive(t.info.id)}
            onAuxClick={(e) => { if (e.button === 1) void closeTab(t.info.id); }}
            title={t.info.path}
            className={`group flex h-8 max-w-[220px] cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs ${
              active ? "border-line bg-panel text-gray-100" : "border-transparent text-gray-400 hover:bg-elev"
            }`}
          >
            <span className="truncate font-medium">{t.info.name}</span>
            {t.status?.branch && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-amber">
                <GitBranch size={10} />{t.status.branch}
              </span>
            )}
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Cambios sin commit" />}
            <button
              className="rounded p-0.5 text-gray-500 opacity-0 hover:bg-line hover:text-gray-100 group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); void closeTab(t.info.id); }} aria-label="Cerrar pestaña"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <div ref={ref} className="relative">
        <button
          className="mb-0.5 flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-elev hover:text-amber"
          onClick={() => void pickAndOpen()}
          onContextMenu={(e) => { e.preventDefault(); setOpen((o) => !o); }}
          title="Abrir repositorio (⌘O) · clic derecho: recientes"
        >
          <Plus size={15} />
        </button>
        {open && (
          <div className="absolute left-0 top-9 z-40 w-[360px] rounded-md border border-line bg-elev py-1 shadow-xl animate-pop-in">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Recientes</div>
            {rec.length === 0 && <div className="px-3 py-2 text-xs text-gray-500">Sin recientes</div>}
            {rec.map((p) => (
              <button key={p} className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs text-gray-200 hover:bg-amber/15"
                onClick={() => { setOpen(false); void openRepo(p); }}>{p}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
