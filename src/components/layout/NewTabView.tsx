import { useMemo, useState } from "react";
import { FolderOpen, GitBranch, GitFork, PackagePlus, Search, Star } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { usePrefs } from "../../store/usePrefs";
import logo from "../../assets/logo.png";

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Pantalla «New Tab»: Open / Clone / Init a la izquierda; favoritos y recientes con búsqueda a la derecha. */
export function NewTabView() {
  const recents = useRepoStore((s) => s.recents);
  const hasTabs = useRepoStore((s) => s.tabs.length > 0);
  const favorites = usePrefs((s) => s.favorites);
  const toggleFavorite = usePrefs((s) => s.toggleFavorite);
  const [q, setQ] = useState("");
  const { pickAndOpen, openRepo, setModal, setNewTabOpen } = useRepoStore.getState();

  const match = (p: string) => !q.trim() || p.toLowerCase().includes(q.trim().toLowerCase());
  const favs = useMemo(() => favorites.filter(match), [favorites, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const rec = useMemo(() => recents.filter((p) => !favorites.includes(p) && match(p)), [recents, favorites, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-elev";
  const row = (p: string) => (
    <div key={p} className="group flex items-center gap-1 rounded-md border border-transparent hover:border-line hover:bg-elev">
      <button className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left" onClick={() => void openRepo(p)}>
        <GitBranch size={15} className="shrink-0 text-gray-500 group-hover:text-amber" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-gray-100">{base(p)}</span>
          <span className="block truncate font-mono text-[11px] text-gray-500">{p}</span>
        </span>
      </button>
      <button className="mr-2 rounded p-1 text-gray-500 hover:text-amber" onClick={() => toggleFavorite(p)}
        title={favorites.includes(p) ? "Quitar de favoritos" : "Añadir a favoritos"}>
        <Star size={14} className={favorites.includes(p) ? "fill-amber text-amber" : ""} />
      </button>
    </div>
  );

  return (
    <div className="flex h-full bg-app">
      <div className="flex w-[260px] shrink-0 flex-col gap-1 border-r border-line bg-panel p-3">
        <div className="mb-3 flex items-center gap-2 px-1">
          <img src={logo} width={28} height={28} alt="" className="rounded-md" style={{ imageRendering: "pixelated" }} draggable={false} />
          <span className="text-base font-bold tracking-tight text-gray-50">Caesar<span className="text-amber">Git</span></span>
        </div>
        <button className={act} onClick={() => void pickAndOpen()}>
          <FolderOpen size={18} className="text-amber" /> <span className="flex-1">Open</span>
          <kbd className="font-mono text-[10px] text-gray-500">⌘⇧O</kbd>
        </button>
        <button className={act} onClick={() => setModal({ kind: "clone" })}><GitFork size={18} className="text-amber" /> Clone</button>
        <button className={act} onClick={() => setModal({ kind: "init" })}><PackagePlus size={18} className="text-amber" /> Init</button>
        {hasTabs && (
          <button className="mt-auto rounded-md px-3 py-2 text-left text-xs text-gray-400 hover:bg-elev" onClick={() => setNewTabOpen(false)}>
            Volver al repositorio
          </button>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-6">
        <div className="mx-auto flex h-full w-full max-w-[720px] flex-col">
          <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 focus-within:border-amber">
            <Search size={14} className="text-gray-500" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar repositorios recientes y favoritos…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-600" />
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {favs.length > 0 && (
              <section>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Favoritos</div>
                <div className="space-y-0.5">{favs.map(row)}</div>
              </section>
            )}
            <section>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Recientes</div>
              {rec.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-gray-500">
                  {q ? "Sin coincidencias." : "Aún no has abierto ningún repositorio. También puedes arrastrar una carpeta a la ventana."}
                </div>
              ) : <div className="space-y-0.5">{rec.map(row)}</div>}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
