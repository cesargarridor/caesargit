import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppError, BranchInfo, GraphPage, GraphRow, ModalState, RepoInfo, RepoStatus, Selection,
  StashEntry, TagInfo,
} from "../types/git";

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
}

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

const READ_ONLY = /^(get_|list_|search_|is_|blame_|file_history|last_commit_message|watch_|unwatch_|open_repo|resolve_conflict_preview)/;

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
      let mirror: Partial<RepoState> = {};
      const tabs = s.tabs.map((t) => {
        if (t.info.id !== id) return t;
        const nt = { ...t, ...(typeof patch === "function" ? patch(t) : patch) };
        if (id === s.activeId) mirror = { selection: nt.selection, modal: nt.modal };
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
    selection: null,
    modal: null,
    paletteOpen: false,
    dialog: null,
    toasts: [],

    activeTab: activeOf,

    openRepo: async (path) => {
      try {
        const info = await invoke<RepoInfo>("open_repo", { path });
        const existing = get().tabs.find((t) => t.info.id === info.id);
        if (existing) {
          get().setActive(info.id);
          return;
        }
        const tab: RepoTab = {
          info, status: null, rows: [], nextCursor: null, total: null, branches: [], tags: [],
          stashes: [], selection: null, modal: null, loading: true, loadingMore: false, busy: 0,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: info.id, selection: null, modal: null }));
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
      set({ tabs, activeId, selection: next?.selection ?? null, modal: next?.modal ?? null });
    },

    setActive: (id) => {
      const t = get().tabs.find((x) => x.info.id === id);
      if (t) set({ activeId: id, selection: t.selection, modal: t.modal });
    },

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
        const [page, branches, tags, stashes] = await Promise.all([
          invoke<GraphPage>("get_graph", { repoPath, cursor: 0, limit, hasWip: status.files.length > 0 }),
          invoke<BranchInfo[]>("list_branches", { repoPath }),
          invoke<TagInfo[]>("list_tags", { repoPath }),
          invoke<StashEntry[]>("list_stashes", { repoPath }),
        ]);
        if (refreshTokens.get(tab.info.id) !== token) return;
        patchTab(tab.info.id, (t) => {
          // si la selección apuntaba a WIP y ya no hay cambios, limpiar
          let selection = t.selection;
          if (selection?.kind === "wip" && status.files.length === 0) selection = null;
          return {
            status, rows: page.rows, nextCursor: page.nextCursor, total: page.total,
            branches, tags, stashes, loading: false, selection,
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
          repoPath: tab.info.path, cursor: tab.nextCursor, limit: PAGE_SIZE, hasWip: false,
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
        return await invoke<T>(cmd, { repoPath: tab.info.path, ...args });
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
