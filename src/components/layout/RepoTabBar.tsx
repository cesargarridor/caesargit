import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, Plus, X, FolderGit2 } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { usePrefs } from "../../store/usePrefs";
import { ContextMenu, type CtxItem } from "./ContextMenu";

export function RepoTabBar() {
  const tabs = useRepoStore((s) => s.tabs);
  const activeId = useRepoStore((s) => s.activeId);
  const newTabOpen = useRepoStore((s) => s.newTabOpen);
  const aliases = usePrefs((s) => s.aliases);
  const { setActive, closeTab, closeOthers, reorderTabs, renameTab, setNewTabOpen, toast, ask } = useRepoStore.getState();
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Reordenar por arrastre con eventos de puntero (funciona igual en macOS, Windows y Linux)
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const sx = e.clientX;
    let started = false;
    let over: string | null = null;
    const tabAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? null;
    const move = (m: PointerEvent) => {
      if (!started && Math.abs(m.clientX - sx) < 5) return;
      if (!started) { started = true; setDragId(id); }
      over = tabAt(m.clientX, m.clientY);
      setOverId(over);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (started) {
        if (over && over !== id) reorderTabs(id, over);
        const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
      setDragId(null); setOverId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ctx = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const t = tabs.find((x) => x.info.id === id);
    if (!t) return;
    const path = t.info.path;
    const fail = (e2: unknown) => toast(e2 && typeof e2 === "object" && "message" in e2 ? String((e2 as { message: unknown }).message) : String(e2));
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: "Renombrar pestaña…", onClick: () => rename(id) },
        { sep: true },
        { label: "Cerrar", hint: "⌘W", onClick: () => void closeTab(id) },
        { label: "Cerrar las demás", disabled: tabs.length < 2, onClick: () => void closeOthers(id) },
        { sep: true },
        { label: "Abrir en terminal", onClick: () => void invoke("open_in_terminal", { repoPath: path }).catch(fail) },
        { label: "Abrir en el gestor de archivos", onClick: () => void invoke("reveal_in_file_manager", { repoPath: path }).catch(fail) },
        { label: "Copiar ruta", onClick: () => void navigator.clipboard.writeText(path).then(() => toast("Ruta copiada", "info")) },
      ],
    });
  };

  const rename = async (id: string) => {
    const t = useRepoStore.getState().tabs.find((x) => x.info.id === id);
    if (!t) return;
    const r = await ask({
      title: "Alias de la pestaña", message: "Déjalo vacío para volver al nombre del repositorio.",
      fields: [{ key: "a", label: "Alias", initial: aliases[t.info.path] ?? t.info.name, optional: true }], confirmLabel: "Guardar",
    });
    if (r) renameTab(id, r.a.trim() === t.info.name ? null : r.a);
  };

  return (
    <div className="flex h-[var(--h-tab)] shrink-0 items-end gap-0.5 border-b border-line bg-app px-2">
      {tabs.map((t) => {
        const active = t.info.id === activeId && !newTabOpen;
        const dirty = (t.status?.files.length ?? 0) > 0;
        const name = aliases[t.info.path] ?? t.info.name;
        return (
          <div
            key={t.info.id}
            data-tab-id={t.info.id}
            onPointerDown={(e) => startDrag(e, t.info.id)}
            onClick={() => setActive(t.info.id)}
            onAuxClick={(e) => { if (e.button === 1) void closeTab(t.info.id); }}
            onContextMenu={(e) => ctx(e, t.info.id)}
            onDoubleClick={() => void rename(t.info.id)}
            title={t.info.path}
            className={`group relative flex h-[calc(var(--h-tab)-4px)] max-w-[220px] cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs ${
              active ? "border-line bg-panel text-gray-100" : "border-transparent text-gray-400 hover:bg-elev"
            } ${overId === t.info.id && dragId !== t.info.id ? "border-l-2 border-l-amber" : ""} ${dragId === t.info.id ? "opacity-50" : ""}`}
          >
            {active && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-amber" />}
            <FolderGit2 size={13} className="shrink-0 text-gray-500" />
            <span className="truncate font-medium">{name}</span>
            {t.status?.branch && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-amber">
                <GitBranch size={10} />{t.status.branch}
              </span>
            )}
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-git-modified" title="Cambios sin commitear" />}
            <button
              className="ml-1 rounded p-0.5 text-gray-500 opacity-0 hover:bg-line hover:text-gray-100 group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); void closeTab(t.info.id); }} aria-label="Cerrar pestaña"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      {newTabOpen && (
        <div className="relative flex h-[calc(var(--h-tab)-4px)] items-center gap-2 rounded-t-md border border-b-0 border-line bg-panel px-3 text-xs text-gray-100">
          <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-amber" />
          <Plus size={12} /> Nueva pestaña
          <button className="ml-1 rounded p-0.5 text-gray-500 hover:bg-line hover:text-gray-100" onClick={() => setNewTabOpen(false)} aria-label="Cerrar"><X size={11} /></button>
        </div>
      )}
      <button
        className="mb-0.5 flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:bg-elev hover:text-amber"
        onClick={() => setNewTabOpen(true)} title="Nueva pestaña (⌘T)"
      >
        <Plus size={15} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
