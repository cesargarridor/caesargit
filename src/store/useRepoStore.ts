import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppError, BranchInfo, GitProgress, GraphColumn, GraphFilter, GraphPage, GraphRow, ModalState, RemoteInfo,
  RepoInfo, RepoStatus, Selection, StashEntry, Submodule, TagInfo, UndoState, Worktree,
} from "../types/git";
import { getRepoPrefs, usePrefs, type RepoPrefs } from "./usePrefs";

export const PAGE_SIZE = 300;
const RECENTS_KEY = "caesargit.recents";

export interface RepoTab {
  info: RepoInfo;
  status: RepoStatus | null;
  rows: GraphRow[];
  nextCursor: number | null;
  total: number | null;
  branches: BranchInfo[];
  tags: TagInfo[];
  stashes: StashEntry[];
  selection: Selection;
  modal: ModalState;
  loading: boolean;
  loadingMore: boolean;
  busy: number; // operaciones de escritura en curso
  undo: UndoState;
  worktrees: Worktree[];
  submodules: Submodule[];
  remotes: RemoteInfo[];
  graphFilter: GraphFilter;
  selectedCommits: string[];
  /** prefs persistidas del repo (colores, hidden/solo/pinned, columnas...) */
  repoPrefs: RepoPrefs;
  /** timestamp del último fetch/pull correcto */
  lastFetch: number | null;
}

export const emptyFilter = (): GraphFilter => ({
  includeRefs: [], excludeRefs: [], author: "", path: "", grep: "", since: "", pickaxe: "",
});
export const isFilterActive = (f: GraphFilter) =>
  !!(f.includeRefs.length || f.excludeRefs.length || f.author || f.path || f.grep || f.since || f.pickaxe);
const emptyUndo = (): UndoState => ({ undoLabel: null, redoLabel: null });

export interface DialogField {
  key: string;
  label: string;
  type?: "text" | "textarea" | "select" | "checkbox";
  placeholder?: string;
  initial?: string;
  options?: { value: string; label: string }[];
  optional?: boolean;
}
export interface DialogState {
  title: string;
  message?: string;
  fields: DialogField[];
  confirmLabel: string;
  danger: boolean;
  resolve: (v: Record<string, string> | null) => void;
}
export interface Toast { id: number; kind: "error" | "info"; text: string }

interface RepoState {
  tabs: RepoTab[];
  activeId: string | null;
  recents: string[];
  // reflejo de la pestaña activa (para D2)
  selection: Selection;
  modal: ModalState;
  paletteOpen: boolean;
  dialog: DialogState | null;
  toasts: Toast[];
  /** pantalla «New Tab» (Open/Clone/Init) visible sobre la pestaña activa */
  newTabOpen: boolean;
  /** progreso global de operaciones largas (evento git-progress) */
  progress: GitProgress | null;
  // reflejo de la pestaña activa (consumido por F1b)
  graphFilter: GraphFilter;
  selectedCommits: string[];
  hiddenRefs: string[];
  soloRef: string | null;
  pinnedRefs: string[];
  branchColors: Record<string, number>;
  columns: GraphColumn[];
  undoState: UndoState;
  worktrees: Worktree[];
  submodules: Submodule[];
  remotes: RemoteInfo[];

  setNewTabOpen: (v: boolean) => void;
  markFetched: (id: string) => void;
  setProgress: (p: GitProgress | null) => void;
  renameTab: (id: string, alias: string | null) => void;
  reorderTabs: (fromId: string, toId: string) => void;
  closeOthers: (id: string) => Promise<void>;
  cycleTab: (dir: 1 | -1) => void;
  activateIndex: (i: number) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  refreshUndo: (id?: string) => Promise<void>;
  setGraphFilter: (patch: Partial<GraphFilter>) => void;
  clearGraphFilter: () => void;
  setSelectedCommits: (shas: string[]) => void;
  toggleHidden: (ref: string) => void;
  hideRefs: (refs: string[], hidden: boolean) => void;
  toggleSolo: (ref: string) => void;
  togglePin: (ref: string) => void;
  setBranchColor: (ref: string, colorIdx: number | null) => void;
  setColumns: (cols: GraphColumn[]) => void;
  setRepoPrefs: (patch: Partial<RepoPrefs>) => void;

  activeTab: () => RepoTab | null;
  openRepo: (path: string) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  refresh: (id?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  run: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** run que traga el error (ya mostrado en toast); devuelve undefined si falla */
  act: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T | undefined>;
  setSelection: (s: Selection) => void;
  setModal: (m: ModalState) => void;
  setPaletteOpen: (v: boolean) => void;
  ask: (o: { title: string; message?: string; fields: DialogField[]; confirmLabel?: string; danger?: boolean }) => Promise<Record<string, string> | null>;
  confirm: (o: { title: string; message?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  closeDialog: (v: Record<string, string> | null) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as Record<string, unknown>;
    return { code: String(o.code ?? "unknown"), message: String(o.message) };
  }
  if (typeof e === "string") {
    try {
      const p = JSON.parse(e) as AppError;
      if (p && typeof p.message === "string") return p;
    } catch { /* texto plano */ }
    return { code: "unknown", message: e };
  }
  return { code: "unknown", message: String(e) };
}

const READ_ONLY = /^(get_|list_|search_|is_|blame_|file_history|last_commit_message|watch_|unwatch_|open_repo|resolve_conflict_preview|undo_state|bisect_status|flow_status|read_hook|show_file|read_file|compare_|create_patch|init_templates|check_merge|repo_stats|hook_templates|lfs_status|lfs_locks|open_in_|reveal_in_|run_difftool|run_mergetool|save_patch)/;

type GraphFetchArgs = {
  cursor: number; limit: number; hasWip: boolean; includeStashes: boolean;
  includeRefs?: string[]; excludeRefs?: string[]; author?: string; path?: string; grep?: string; since?: string; pickaxe?: string;
};
/** Argumentos de get_graph según filtros y prefs del repo. */
export function graphArgs(t: RepoTab, hasFiles: boolean, cursor: number, limit: number): GraphFetchArgs {
  const f = t.graphFilter;
  const p = t.repoPrefs;
  const include = p.soloRef ? [p.soloRef] : f.includeRefs;
  const exclude = [...new Set([...f.excludeRefs, ...p.hiddenRefs])];
  const filtered = !!(f.author || f.path || f.grep || f.since || f.pickaxe);
  const a: GraphFetchArgs = { cursor, limit, hasWip: !filtered && hasFiles, includeStashes: !p.hideStashesInGraph };
  if (include.length) a.includeRefs = include;
  if (exclude.length) a.excludeRefs = exclude;
  if (f.author) a.author = f.author;
  if (f.path) a.path = f.path;
  if (f.grep) a.grep = f.grep;
  if (f.since) a.since = f.since;
  if (f.pickaxe) a.pickaxe = f.pickaxe;
  return a;
}

type Mirror = Pick<RepoState, "selection" | "modal" | "graphFilter" | "selectedCommits" | "hiddenRefs" | "soloRef"
  | "pinnedRefs" | "branchColors" | "columns" | "undoState" | "worktrees" | "submodules" | "remotes">;
const mirrorOf = (t: RepoTab | null | undefined): Mirror => ({
  selection: t?.selection ?? null,
  modal: t?.modal ?? null,
  graphFilter: t?.graphFilter ?? emptyFilter(),
  selectedCommits: t?.selectedCommits ?? [],
  hiddenRefs: t?.repoPrefs.hiddenRefs ?? [],
  soloRef: t?.repoPrefs.soloRef ?? null,
  pinnedRefs: t?.repoPrefs.pinnedRefs ?? [],
  branchColors: t?.repoPrefs.branchColors ?? {},
  columns: t?.repoPrefs.columns ?? getRepoPrefs("").columns,
  undoState: t?.undo ?? emptyUndo(),
  worktrees: t?.worktrees ?? [],
  submodules: t?.submodules ?? [],
  remotes: t?.remotes ?? [],
});

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

let toastSeq = 0;
const refreshTokens = new Map<string, number>();

export const useRepoStore = create<RepoState>((set, get) => {
  const patchTab = (id: string, patch: Partial<RepoTab> | ((t: RepoTab) => Partial<RepoTab>)) => {
    set((s) => {
      let mirror: Partial<Mirror> = {};
      const tabs = s.tabs.map((t) => {
        if (t.info.id !== id) return t;
        const nt = { ...t, ...(typeof patch === "function" ? patch(t) : patch) };
        if (id === s.activeId) mirror = mirrorOf(nt);
        return nt;
      });
      return { tabs, ...mirror };
    });
  };
  const activeOf = () => {
    const { tabs, activeId } = get();
    return tabs.find((t) => t.info.id === activeId) ?? null;
  };

  const pushToast = (text: string, kind: Toast["kind"] = "error") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 3500);
  };

  const rememberRecent = (path: string) => {
    const recents = [path, ...get().recents.filter((p) => p !== path)].slice(0, 12);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    set({ recents });
  };

  return {
    tabs: [],
    activeId: null,
    recents: loadRecents(),
    paletteOpen: false,
    dialog: null,
    toasts: [],
    newTabOpen: false,
    progress: null,
    ...mirrorOf(null),

    setNewTabOpen: (newTabOpen) => set({ newTabOpen }),
    markFetched: (id) => patchTab(id, { lastFetch: Date.now() }),
    setProgress: (progress) => set({ progress }),

    activeTab: activeOf,

    openRepo: async (path) => {
      try {
        const info = await invoke<RepoInfo>("open_repo", { path });
        const existing = get().tabs.find((t) => t.info.id === info.id);
        if (existing) {
          get().setActive(info.id);
          set({ newTabOpen: false });
          return;
        }
        const tab: RepoTab = {
          info, status: null, rows: [], nextCursor: null, total: null, branches: [], tags: [],
          stashes: [], selection: null, modal: null, loading: true, loadingMore: false, busy: 0,
          undo: emptyUndo(), worktrees: [], submodules: [], remotes: [], graphFilter: emptyFilter(),
          selectedCommits: [], repoPrefs: getRepoPrefs(info.path), lastFetch: null,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: info.id, newTabOpen: false, ...mirrorOf(tab) }));
        rememberRecent(info.path);
        invoke("watch_repo", { repoPath: info.path }).catch((e) => pushToast(toAppError(e).message));
        await get().refresh(info.id);
      } catch (e) {
        pushToast(toAppError(e).message);
      }
    },

    pickAndOpen: async () => {
      const picked = await openDialog({ directory: true, multiple: false, title: "Abrir repositorio" });
      if (typeof picked === "string") await get().openRepo(picked);
    },

    closeTab: async (id) => {
      const t = get().tabs.find((x) => x.info.id === id);
      if (!t) return;
      invoke("unwatch_repo", { repoPath: t.info.path }).catch(() => undefined);
      refreshTokens.delete(id);
      const tabs = get().tabs.filter((x) => x.info.id !== id);
      let activeId = get().activeId;
      if (activeId === id) {
        const idx = get().tabs.findIndex((x) => x.info.id === id);
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.info.id ?? null;
      }
      const next = tabs.find((x) => x.info.id === activeId);
      set({ tabs, activeId, newTabOpen: false, ...mirrorOf(next) });
    },

    setActive: (id) => {
      const t = get().tabs.find((x) => x.info.id === id);
      if (t) set({ activeId: id, newTabOpen: false, ...mirrorOf(t) });
    },

    renameTab: (id, alias) => {
      const t = get().tabs.find((x) => x.info.id === id);
      if (t) usePrefs.getState().setAlias(t.info.path, alias);
    },

    reorderTabs: (fromId, toId) => {
      if (fromId === toId) return;
      const tabs = [...get().tabs];
      const from = tabs.findIndex((t) => t.info.id === fromId);
      const to = tabs.findIndex((t) => t.info.id === toId);
      if (from < 0 || to < 0) return;
      const [m] = tabs.splice(from, 1);
      tabs.splice(to, 0, m);
      set({ tabs });
    },

    closeOthers: async (id) => {
      for (const t of get().tabs.filter((x) => x.info.id !== id)) await get().closeTab(t.info.id);
      get().setActive(id);
    },

    cycleTab: (dir) => {
      const { tabs, activeId } = get();
      if (tabs.length < 2) return;
      const i = tabs.findIndex((t) => t.info.id === activeId);
      get().setActive(tabs[(i + dir + tabs.length) % tabs.length].info.id);
    },

    activateIndex: (i) => {
      const { tabs } = get();
      // ⌘9 = última pestaña, como en los navegadores
      const t = i === 8 ? tabs[tabs.length - 1] : tabs[i];
      if (t) get().setActive(t.info.id);
    },

    refreshUndo: async (id) => {
      const tab = get().tabs.find((t) => t.info.id === (id ?? get().activeId));
      if (!tab) return;
      try {
        const undo = await invoke<UndoState>("undo_state", { repoPath: tab.info.path });
        patchTab(tab.info.id, { undo });
      } catch { /* sin pila */ }
    },

    undo: async () => {
      const label = await get().act<string>("undo_action");
      if (label !== undefined) pushToast(`Deshecho: ${label}`, "info");
    },
    redo: async () => {
      const label = await get().act<string>("redo_action");
      if (label !== undefined) pushToast(`Rehecho: ${label}`, "info");
    },

    setGraphFilter: (patch) => {
      const id = get().activeId;
      if (!id) return;
      patchTab(id, (t) => ({ graphFilter: { ...t.graphFilter, ...patch } }));
      void get().refresh(id);
    },
    clearGraphFilter: () => {
      const id = get().activeId;
      if (!id) return;
      patchTab(id, { graphFilter: emptyFilter() });
      void get().refresh(id);
    },
    setSelectedCommits: (selectedCommits) => {
      const id = get().activeId;
      if (id) patchTab(id, { selectedCommits });
    },

    setRepoPrefs: (patch) => {
      const t = activeOf();
      if (!t) return;
      usePrefs.getState().setRepoPrefs(t.info.path, patch);
      patchTab(t.info.id, (x) => ({ repoPrefs: { ...x.repoPrefs, ...patch } }));
    },
    toggleHidden: (ref) => {
      const t = activeOf();
      if (!t) return;
      get().hideRefs([ref], !t.repoPrefs.hiddenRefs.includes(ref));
    },
    hideRefs: (refs, hidden) => {
      const t = activeOf();
      if (!t) return;
      const cur = new Set(t.repoPrefs.hiddenRefs);
      refs.forEach((r) => (hidden ? cur.add(r) : cur.delete(r)));
      get().setRepoPrefs({ hiddenRefs: [...cur] });
      void get().refresh(t.info.id);
    },
    toggleSolo: (ref) => {
      const t = activeOf();
      if (!t) return;
      get().setRepoPrefs({ soloRef: t.repoPrefs.soloRef === ref ? null : ref });
      void get().refresh(t.info.id);
    },
    togglePin: (ref) => {
      const t = activeOf();
      if (!t) return;
      const p = t.repoPrefs.pinnedRefs;
      get().setRepoPrefs({ pinnedRefs: p.includes(ref) ? p.filter((x) => x !== ref) : [...p, ref] });
    },
    setBranchColor: (ref, colorIdx) => {
      const t = activeOf();
      if (!t) return;
      const c = { ...t.repoPrefs.branchColors };
      if (colorIdx === null) delete c[ref];
      else c[ref] = colorIdx;
      get().setRepoPrefs({ branchColors: c });
    },
    setColumns: (columns) => get().setRepoPrefs({ columns }),

    refresh: async (id) => {
      const tabId = id ?? get().activeId;
      const tab = get().tabs.find((t) => t.info.id === tabId);
      if (!tab) return;
      const token = (refreshTokens.get(tab.info.id) ?? 0) + 1;
      refreshTokens.set(tab.info.id, token);
      const repoPath = tab.info.path;
      try {
        const status = await invoke<RepoStatus>("get_status", { repoPath });
        const limit = Math.max(PAGE_SIZE, tab.rows.filter((r) => !r.isWip).length);
        const cur = get().tabs.find((t) => t.info.id === tab.info.id) ?? tab;
        const soft = <T,>(p: Promise<T>, d: T) => p.catch(() => d);
        const [page, branches, tags, stashes, undo, worktrees, submodules, remotes] = await Promise.all([
          invoke<GraphPage>("get_graph", { repoPath, ...graphArgs(cur, status.files.length > 0, 0, limit) }),
          invoke<BranchInfo[]>("list_branches", { repoPath }),
          invoke<TagInfo[]>("list_tags", { repoPath }),
          invoke<StashEntry[]>("list_stashes", { repoPath }),
          soft(invoke<UndoState>("undo_state", { repoPath }), emptyUndo()),
          soft(invoke<Worktree[]>("list_worktrees", { repoPath }), [] as Worktree[]),
          soft(invoke<Submodule[]>("list_submodules", { repoPath }), [] as Submodule[]),
          soft(invoke<RemoteInfo[]>("list_remotes", { repoPath }), [] as RemoteInfo[]),
        ]);
        if (refreshTokens.get(tab.info.id) !== token) return;
        patchTab(tab.info.id, (t) => {
          // si la selección apuntaba a WIP y ya no hay cambios, limpiar
          let selection = t.selection;
          if (selection?.kind === "wip" && status.files.length === 0) selection = null;
          return {
            status, rows: page.rows, nextCursor: page.nextCursor, total: page.total,
            branches, tags, stashes, undo, worktrees, submodules, remotes, loading: false, selection,
          };
        });
      } catch (e) {
        if (refreshTokens.get(tab.info.id) === token) {
          patchTab(tab.info.id, { loading: false });
          pushToast(toAppError(e).message);
        }
      }
    },

    loadMore: async () => {
      const tab = activeOf();
      if (!tab || tab.loadingMore || tab.nextCursor === null) return;
      const id = tab.info.id;
      patchTab(id, { loadingMore: true });
      try {
        const page = await invoke<GraphPage>("get_graph", {
          repoPath: tab.info.path, ...graphArgs(tab, false, tab.nextCursor, PAGE_SIZE),
        });
        patchTab(id, (t) => ({
          rows: [...t.rows, ...page.rows], nextCursor: page.nextCursor, total: page.total, loadingMore: false,
        }));
      } catch (e) {
        patchTab(id, { loadingMore: false });
        pushToast(toAppError(e).message);
      }
    },

    run: async <T,>(cmd: string, args: Record<string, unknown> = {}) => {
      const tab = activeOf();
      if (!tab) throw { code: "not_a_repo", message: "No hay repositorio activo" } satisfies AppError;
      const id = tab.info.id;
      const write = !READ_ONLY.test(cmd);
      if (write) patchTab(id, (t) => ({ busy: t.busy + 1 }));
      try {
        const r = await invoke<T>(cmd, { repoPath: tab.info.path, ...args });
        if (cmd === "fetch" || cmd === "pull") patchTab(id, { lastFetch: Date.now() });
        return r;
      } catch (e) {
        const err = toAppError(e);
        pushToast(err.message);
        throw err;
      } finally {
        if (write) {
          patchTab(id, (t) => ({ busy: Math.max(0, t.busy - 1) }));
          void get().refresh(id);
        }
      }
    },

    act: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      try {
        return await get().run<T>(cmd, args);
      } catch {
        return undefined;
      }
    },

    setSelection: (selection) => {
      const id = get().activeId;
      if (id) patchTab(id, { selection });
    },
    setModal: (modal) => {
      const id = get().activeId;
      if (id) patchTab(id, { modal });
      else set({ modal }); // sin pestañas (pantalla New Tab): Clone/Init/Preferencias
    },
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

    ask: (o) =>
      new Promise((resolve) => {
        set({
          dialog: {
            title: o.title, message: o.message, fields: o.fields,
            confirmLabel: o.confirmLabel ?? "Aceptar", danger: o.danger ?? false, resolve,
          },
        });
      }),
    confirm: async (o) => {
      const r = await get().ask({ ...o, fields: [] });
      return r !== null;
    },
    closeDialog: (v) => {
      const d = get().dialog;
      set({ dialog: null });
      d?.resolve(v);
    },

    toast: pushToast,
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
