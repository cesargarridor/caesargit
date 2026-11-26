import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_THEME } from "../lib/themes";
import type { GraphColumn, PullMode } from "../types/git";

export const DEFAULT_COLUMNS: GraphColumn[] = [
  { id: "ref", visible: true, width: 190 },
  { id: "graph", visible: true, width: 160 },
  { id: "message", visible: true, width: 420 },
  { id: "author", visible: true, width: 130 },
  { id: "date", visible: true, width: 110 },
  { id: "sha", visible: true, width: 80 },
];

/** Preferencias persistidas por repositorio (clave = ruta del repo). */
export interface RepoPrefs {
  /** color de carril (índice 0-9) por nombre corto de rama */
  branchColors: Record<string, number>;
  hiddenRefs: string[];
  soloRef: string | null;
  pinnedRefs: string[];
  columns: GraphColumn[];
  /** minutos entre fetch automáticos; null = usa el valor global */
  autoFetchMinutes: number | null;
  /** modo de pull por defecto; null = usa el global */
  pullMode: PullMode | null;
  hideStashesInGraph: boolean;
  /** secciones del panel izquierdo ocultas (local, remote, tags, stashes, submodules, worktrees) */
  hiddenSections: string[];
  showLeftPanel: boolean | null;
  showRightPanel: boolean | null;
}

export const emptyRepoPrefs = (): RepoPrefs => ({
  branchColors: {}, hiddenRefs: [], soloRef: null, pinnedRefs: [],
  columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), autoFetchMinutes: null, pullMode: null,
  hideStashesInGraph: false, hiddenSections: [], showLeftPanel: null, showRightPanel: null,
});

export interface Prefs {
  themeId: string;
  accent: string | null; // acento personalizado (null = el del tema)
  checkUpdates: boolean; // comprobar actualizaciones automáticamente
  /** zoom de la interfaz, 80-300 % */
  zoom: number;
  /** modo de pull por defecto global */
  defaultPull: PullMode;
  /** auto-fetch global en minutos (0 = desactivado) */
  autoFetchMinutes: number;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  /** alias de pestaña por ruta de repo */
  aliases: Record<string, string>;
  /** repos favoritos (rutas) */
  favorites: string[];
  repoPrefs: Record<string, RepoPrefs>;
}

interface PrefsStore extends Prefs {
  set: (p: Partial<Prefs>) => void;
  setRepoPrefs: (path: string, patch: Partial<RepoPrefs>) => void;
  setAlias: (path: string, alias: string | null) => void;
  toggleFavorite: (path: string) => void;
}

export const ZOOM_MIN = 80;
export const ZOOM_MAX = 300;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME, accent: null, checkUpdates: true,
      zoom: 100, defaultPull: "ff", autoFetchMinutes: 0, showLeftPanel: true, showRightPanel: true,
      aliases: {}, favorites: [], repoPrefs: {},
      set: (p) => set(p),
      setRepoPrefs: (path, patch) =>
        set((s) => ({ repoPrefs: { ...s.repoPrefs, [path]: { ...emptyRepoPrefs(), ...s.repoPrefs[path], ...patch } } })),
      setAlias: (path, alias) =>
        set((s) => {
          const aliases = { ...s.aliases };
          if (alias && alias.trim()) aliases[path] = alias.trim();
          else delete aliases[path];
          return { aliases };
        }),
      toggleFavorite: (path) =>
        set((s) => ({ favorites: s.favorites.includes(path) ? s.favorites.filter((p) => p !== path) : [...s.favorites, path] })),
    }),
    {
      name: "caesargit-prefs",
      partialize: (s) => ({
        themeId: s.themeId, accent: s.accent, checkUpdates: s.checkUpdates, zoom: s.zoom, defaultPull: s.defaultPull,
        autoFetchMinutes: s.autoFetchMinutes, showLeftPanel: s.showLeftPanel, showRightPanel: s.showRightPanel,
        aliases: s.aliases, favorites: s.favorites, repoPrefs: s.repoPrefs,
      }),
    },
  ),
);

/** Lee las prefs de un repo con valores por defecto. */
export const getRepoPrefs = (path: string): RepoPrefs => ({ ...emptyRepoPrefs(), ...usePrefs.getState().repoPrefs[path] });

/** Estado de UI efímero (compatibilidad con el antiguo modal de Ajustes). */
export const useSettingsUi = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
