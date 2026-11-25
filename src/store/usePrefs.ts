import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_THEME } from "../lib/themes";

export interface Prefs {
  themeId: string;
  accent: string | null; // acento personalizado (null = el del tema)
  checkUpdates: boolean; // comprobar actualizaciones automáticamente
}

interface PrefsStore extends Prefs {
  set: (p: Partial<Prefs>) => void;
}

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({ themeId: DEFAULT_THEME, accent: null, checkUpdates: true, set: (p) => set(p) }),
    {
      name: "caesargit-prefs",
      partialize: (s) => ({ themeId: s.themeId, accent: s.accent, checkUpdates: s.checkUpdates }),
    },
  ),
);

/** Estado de UI efímero (modal de Ajustes). */
export const useSettingsUi = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
