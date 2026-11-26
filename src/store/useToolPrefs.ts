import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DateFormat = "relative" | "short" | "iso";
export type Density = "compact" | "normal" | "comfortable";

export interface ToolPrefs {
  // General
  dateFormat: DateFormat;
  defaultBranch: string;
  uiFont: string; // "" = por defecto
  // UI
  density: Density;
  showAuthor: boolean;
  showDate: boolean;
  showSha: boolean;
  // Herramientas externas
  editor: string; // "" = editor del sistema
  terminal: string;
  diffTool: string;
  mergeTool: string;
  gitPath: string;
  // Firma por defecto
  signCommits: boolean;
  signTags: boolean;
  gpgFormat: "openpgp" | "ssh" | "x509";
  signingKey: string;
}

export const TOOL_PREF_DEFAULTS: ToolPrefs = {
  dateFormat: "relative", defaultBranch: "main", uiFont: "",
  density: "normal", showAuthor: true, showDate: true, showSha: true,
  editor: "", terminal: "", diffTool: "", mergeTool: "", gitPath: "",
  signCommits: false, signTags: false, gpgFormat: "openpgp", signingKey: "",
};

interface Store extends ToolPrefs {
  set: (p: Partial<ToolPrefs>) => void;
  reset: () => void;
}

export const useToolPrefs = create<Store>()(
  persist(
    (set) => ({
      ...TOOL_PREF_DEFAULTS,
      set: (p) => set(p),
      reset: () => set({ ...TOOL_PREF_DEFAULTS }),
    }),
    {
      name: "caesargit-tool-prefs",
      partialize: (s) => {
        const { set: _s, reset: _r, ...rest } = s;
        void _s; void _r;
        return rest;
      },
    },
  ),
);

/** Aplica al DOM los ajustes visuales (densidad, fuente). El zoom lo gestiona usePrefs. */
export function applyToolPrefs(p: ToolPrefs = useToolPrefs.getState()): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = p.density;
  document.body.style.fontFamily = p.uiFont.trim() ? `${p.uiFont.trim()}, Inter, system-ui, sans-serif` : "";
}

applyToolPrefs();
useToolPrefs.subscribe((s) => applyToolPrefs(s));
