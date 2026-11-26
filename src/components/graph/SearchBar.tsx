import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, Filter, Search, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { AuthorInfo, CommitNode, SearchScope } from "../../types/git";

const st = () => useRepoStore.getState();
export const SEARCH_EVENT = "caesargit:search";

interface SearchState {
  open: boolean;
  query: string;
  scope: SearchScope;
  since: string;
  until: string;
  matches: string[];
  current: number;
  searching: boolean;
  filterOn: boolean;
  set: (p: Partial<Omit<SearchState, "set">>) => void;
}

export const useGraphSearch = create<SearchState>((set) => ({
  open: false, query: "", scope: "all", since: "", until: "", matches: [], current: -1, searching: false, filterOn: false,
  set: (p) => set(p),
}));

const SCOPES: { v: SearchScope; label: string }[] = [
  { v: "all", label: "Todo" },
  { v: "message", label: "Mensaje" },
  { v: "author", label: "Autor" },
  { v: "sha", label: "SHA" },
  { v: "file", label: "Archivo (ruta)" },
  { v: "pickaxeS", label: "Contenido (-S)" },
  { v: "pickaxeG", label: "Contenido (-G regex)" },
];

/** Resalta las coincidencias de `query` en `text`. */
export function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-amber/40 px-px text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Trae más páginas del grafo hasta que `sha` esté cargado; luego lo selecciona. */
export async function revealCommit(sha: string): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    const t = st().activeTab();
    if (!t) return false;
    if (t.rows.some((r) => r.commit.sha === sha)) {
      st().setSelectedCommits([sha]);
      st().setSelection({ kind: "commit", sha });
      return true;
    }
    if (t.nextCursor === null) return false;
    await st().loadMore();
  }
  return false;
}

export function SearchBar() {
  const s = useGraphSearch();
  const tab = useRepoStore((x) => x.tabs.find((t) => t.info.id === x.activeId) ?? null);
  const filterAuthor = useRepoStore((x) => x.graphFilter.author);
  const inputRef = useRef<HTMLInputElement>(null);
  const [authors, setAuthors] = useState<AuthorInfo[]>([]);
  const seq = useRef(0);
  const repoPath = tab?.info.path;

  // abrir por evento / atajo
  useEffect(() => {
    const open = () => {
      useGraphSearch.getState().set({ open: true });
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); open(); }
    };
    window.addEventListener(SEARCH_EVENT, open);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener(SEARCH_EVENT, open); window.removeEventListener("keydown", key); };
  }, []);

  // autores del repo
  useEffect(() => {
    if (!s.open || !repoPath) return;
    invoke<AuthorInfo[]>("list_authors", { repoPath }).then(setAuthors).catch(() => setAuthors([]));
  }, [s.open, repoPath]);

  const goTo = useCallback(async (idx: number, matches: string[]) => {
    if (!matches.length) return;
    const i = ((idx % matches.length) + matches.length) % matches.length;
    useGraphSearch.getState().set({ current: i });
    await revealCommit(matches[i]);
  }, []);

  // búsqueda con debounce
  useEffect(() => {
    if (!s.open || !repoPath) return;
    if (!s.query.trim() && !s.since && !s.until) {
      useGraphSearch.getState().set({ matches: [], current: -1, searching: false });
      return;
    }
    const my = ++seq.current;
    useGraphSearch.getState().set({ searching: true });
    const t = setTimeout(() => {
      invoke<CommitNode[]>("search_commits", {
        repoPath, query: s.query.trim(), scope: s.scope, since: s.since || undefined, until: s.until || undefined,
      })
        .then((res) => {
          if (my !== seq.current) return;
          const matches = res.map((c) => c.sha);
          useGraphSearch.getState().set({ matches, current: matches.length ? 0 : -1, searching: false });
          if (matches.length) void goTo(0, matches);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          useGraphSearch.getState().set({ matches: [], current: -1, searching: false });
          st().toast(e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
        });
    }, 280);
    return () => clearTimeout(t);
  }, [s.open, s.query, s.scope, s.since, s.until, repoPath, goTo]);

  // filtros del grafo (get_graph) cuando "Filtrar grafo" está activo
  const filterable = s.scope !== "sha" && s.scope !== "pickaxeG";
  useEffect(() => {
    if (!s.open) return;
    if (!s.filterOn || !filterable) {
      return;
    }
    const t = setTimeout(() => {
      const q = s.query.trim();
      st().setGraphFilter({
        grep: s.scope === "all" || s.scope === "message" ? q : "",
        path: s.scope === "file" ? q : "",
        pickaxe: s.scope === "pickaxeS" ? q : "",
        since: s.since,
        ...(s.scope === "author" ? { author: q } : {}),
      });
    }, 350);
    return () => clearTimeout(t);
  }, [s.open, s.filterOn, s.query, s.scope, s.since, filterable]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearOwnFilter = () => {
    const f = st().graphFilter;
    if (f.grep || f.path || f.pickaxe || f.since || (s.scope === "author" && f.author))
      st().setGraphFilter({ grep: "", path: "", pickaxe: "", since: "", ...(s.scope === "author" ? { author: "" } : {}) });
  };

  const close = () => {
    if (s.filterOn) clearOwnFilter();
    useGraphSearch.getState().set({ open: false, query: "", matches: [], current: -1, filterOn: false, since: "", until: "" });
  };

  if (!s.open) return null;
  const n = s.matches.length;
  return (
    <div className="absolute right-3 top-9 z-30 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-elev p-1.5 shadow-pop animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
      <Search size={13} className="ml-1 text-gray-500" />
      <input
        ref={inputRef} autoFocus value={s.query} placeholder="Buscar commits…"
        onChange={(e) => s.set({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); close(); }
          else if (e.key === "Enter") { e.preventDefault(); void goTo(s.current + (e.shiftKey ? -1 : 1), s.matches); }
        }}
        className="w-52 rounded border border-line bg-app px-2 py-1 text-xs text-gray-100 outline-none focus:border-amber"
      />
      <select value={s.scope} onChange={(e) => s.set({ scope: e.target.value as SearchScope })} className="rounded border border-line bg-app px-1.5 py-1 text-xs text-gray-200 outline-none">
        {SCOPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      <input type="date" title="Desde" value={s.since} onChange={(e) => s.set({ since: e.target.value })} className="rounded border border-line bg-app px-1 py-0.5 text-xs text-gray-200 outline-none" />
      <input type="date" title="Hasta (solo búsqueda)" value={s.until} onChange={(e) => s.set({ until: e.target.value })} className="rounded border border-line bg-app px-1 py-0.5 text-xs text-gray-200 outline-none" />
      <select
        value={filterAuthor} title="Filtrar grafo por autor"
        onChange={(e) => st().setGraphFilter({ author: e.target.value })}
        className="max-w-[140px] rounded border border-line bg-app px-1.5 py-1 text-xs text-gray-200 outline-none"
      >
        <option value="">Todos los autores</option>
        {authors.map((a) => <option key={a.email + a.name} value={a.email}>{a.name} ({a.count})</option>)}
      </select>
      <span className="min-w-[44px] text-center font-mono text-[11px] text-gray-400">
        {s.searching ? "…" : n ? `${s.current + 1}/${n}` : s.query || s.since || s.until ? "0" : ""}
      </span>
      <button className="rounded p-1 text-gray-400 hover:bg-line hover:text-amber disabled:opacity-40" disabled={!n} title="Anterior (Shift+Enter)" onClick={() => void goTo(s.current - 1, s.matches)}><ChevronUp size={14} /></button>
      <button className="rounded p-1 text-gray-400 hover:bg-line hover:text-amber disabled:opacity-40" disabled={!n} title="Siguiente (Enter)" onClick={() => void goTo(s.current + 1, s.matches)}><ChevronDown size={14} /></button>
      <button
        disabled={!filterable}
        title={filterable ? "Filtrar el grafo con esta búsqueda" : "Este tipo de búsqueda no filtra el grafo"}
        className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] disabled:opacity-40 ${s.filterOn && filterable ? "bg-amber text-onacc" : "text-gray-400 hover:bg-line hover:text-amber"}`}
        onClick={() => {
          if (s.filterOn) clearOwnFilter();
          s.set({ filterOn: !s.filterOn });
        }}
      >
        <Filter size={12} /> Filtrar grafo
      </button>
      <button className="rounded p-1 text-gray-400 hover:bg-line hover:text-amber" title="Cerrar (Esc)" onClick={close}><X size={14} /></button>
    </div>
  );
}
