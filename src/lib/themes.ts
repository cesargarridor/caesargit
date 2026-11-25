import { useSyncExternalStore } from "react";

/** Temas de CaesarGit: variables CSS (canales RGB «r g b») que consumen Tailwind y los componentes. */

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  bg: string;
  text: string;
  accent: string;
  /** [added, modified, deleted, renamed, conflict] */
  git: [string, string, string, string, string];
  /** 8 colores de carriles del grafo */
  lanes: string[];
  panel?: string;
  elev?: string;
  line?: string;
}

export const THEMES: Theme[] = [
  { id: "auto", name: "Automático (sistema)", dark: true, bg: "#0D0E11", panel: "#13151A", elev: "#1A1D24", line: "#262A34", text: "#E5E7EB", accent: "#F59E0B",
    git: ["#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#F43F5E"], lanes: ["#F59E0B", "#38BDF8", "#10B981", "#A78BFA", "#FB7185", "#2DD4BF", "#FBBF24", "#818CF8"] },
  { id: "graphite", name: "Graphite & Amber", dark: true, bg: "#0D0E11", panel: "#13151A", elev: "#1A1D24", line: "#262A34", text: "#E5E7EB", accent: "#F59E0B",
    git: ["#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#F43F5E"], lanes: ["#F59E0B", "#38BDF8", "#10B981", "#A78BFA", "#FB7185", "#2DD4BF", "#FBBF24", "#818CF8"] },
  { id: "monokai", name: "Monokai", dark: true, bg: "#272822", panel: "#2d2e27", elev: "#3a3b33", line: "#49483e", text: "#f8f8f2", accent: "#a6e22e",
    git: ["#a6e22e", "#e6db74", "#f92672", "#66d9ef", "#fd971f"], lanes: ["#a6e22e", "#66d9ef", "#f92672", "#ae81ff", "#fd971f", "#e6db74", "#4ec9b0", "#f8a5c2"] },
  { id: "dracula", name: "Dracula", dark: true, bg: "#282a36", panel: "#21222c", elev: "#343746", line: "#44475a", text: "#f8f8f2", accent: "#bd93f9",
    git: ["#50fa7b", "#f1fa8c", "#ff5555", "#8be9fd", "#ff79c6"], lanes: ["#bd93f9", "#8be9fd", "#50fa7b", "#ff79c6", "#ffb86c", "#f1fa8c", "#ff5555", "#6272a4"] },
  { id: "tokyo-night", name: "Tokyo Night", dark: true, bg: "#1a1b26", panel: "#16161e", elev: "#24283b", line: "#33384f", text: "#c0caf5", accent: "#7aa2f7",
    git: ["#9ece6a", "#e0af68", "#f7768e", "#7aa2f7", "#ff9e64"], lanes: ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#ff9e64", "#73daca"] },
  { id: "nord", name: "Nord", dark: true, bg: "#2e3440", panel: "#2b303b", elev: "#3b4252", line: "#4c566a", text: "#eceff4", accent: "#88c0d0",
    git: ["#a3be8c", "#ebcb8b", "#bf616a", "#81a1c1", "#d08770"], lanes: ["#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#bf616a", "#8fbcbb", "#d08770", "#81a1c1"] },
  { id: "gruvbox", name: "Gruvbox Dark", dark: true, bg: "#282828", panel: "#242424", elev: "#3c3836", line: "#504945", text: "#ebdbb2", accent: "#fabd2f",
    git: ["#b8bb26", "#fabd2f", "#fb4934", "#83a598", "#fe8019"], lanes: ["#fabd2f", "#83a598", "#b8bb26", "#d3869b", "#fb4934", "#8ec07c", "#fe8019", "#a89984"] },
  { id: "one-dark", name: "One Dark", dark: true, bg: "#282c34", panel: "#21252b", elev: "#2c313a", line: "#3e4451", text: "#abb2bf", accent: "#61afef",
    git: ["#98c379", "#e5c07b", "#e06c75", "#61afef", "#d19a66"], lanes: ["#61afef", "#98c379", "#e5c07b", "#c678dd", "#e06c75", "#56b6c2", "#d19a66", "#7f8c9d"] },
  { id: "catppuccin", name: "Catppuccin Mocha", dark: true, bg: "#1e1e2e", panel: "#181825", elev: "#313244", line: "#45475a", text: "#cdd6f4", accent: "#cba6f7",
    git: ["#a6e3a1", "#f9e2af", "#f38ba8", "#89b4fa", "#fab387"], lanes: ["#cba6f7", "#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8", "#94e2d5", "#fab387", "#f5c2e7"] },
  { id: "github-dark", name: "GitHub Dark", dark: true, bg: "#0d1117", panel: "#161b22", elev: "#21262d", line: "#30363d", text: "#e6edf3", accent: "#58a6ff",
    git: ["#3fb950", "#d29922", "#f85149", "#58a6ff", "#db6d28"], lanes: ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f85149", "#39c5cf", "#db6d28", "#ff7b72"] },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, bg: "#002b36", panel: "#00252e", elev: "#073642", line: "#13505e", text: "#93a1a1", accent: "#b58900",
    git: ["#859900", "#b58900", "#dc322f", "#268bd2", "#d33682"], lanes: ["#b58900", "#268bd2", "#859900", "#6c71c4", "#dc322f", "#2aa198", "#cb4b16", "#d33682"] },
  { id: "github-light", name: "GitHub Light", dark: false, bg: "#ffffff", panel: "#f6f8fa", elev: "#eaeef2", line: "#d0d7de", text: "#1f2328", accent: "#0969da",
    git: ["#1a7f37", "#9a6700", "#cf222e", "#0969da", "#bc4c00"], lanes: ["#0969da", "#1a7f37", "#9a6700", "#8250df", "#cf222e", "#1b7c83", "#bc4c00", "#6e7781"] },
  { id: "solarized-light", name: "Solarized Light", dark: false, bg: "#fdf6e3", panel: "#f5eed8", elev: "#eee8d5", line: "#d9d2bc", text: "#586e75", accent: "#268bd2",
    git: ["#859900", "#b58900", "#dc322f", "#268bd2", "#d33682"], lanes: ["#268bd2", "#859900", "#b58900", "#6c71c4", "#dc322f", "#2aa198", "#cb4b16", "#d33682"] },
];

export const DEFAULT_THEME = "graphite";

export const systemDark = (): boolean =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;

/** «auto» elige Graphite (oscuro) o GitHub Light (claro) según el sistema. */
export function resolveTheme(themeId: string): Theme {
  const id = themeId === "auto" ? (systemDark() ? "graphite" : "github-light") : themeId;
  return THEMES.find((x) => x.id === id) ?? THEMES.find((x) => x.id === "graphite")!;
}

export function useIsDarkTheme(themeId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => resolveTheme(themeId).dark,
  );
}

type RGB = [number, number, number];
const parse = (hex: string): RGB => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB;
};
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;
const str = (c: RGB) => c.join(" ");
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Color CSS de una variable del tema, con alfa opcional: cv("accent", 0.2). */
export const cv = (name: string, alpha?: number) => (alpha === undefined ? `rgb(var(--c-${name}))` : `rgb(var(--c-${name}) / ${alpha})`);
export const laneVar = (i: number) => `rgb(var(--lane-${((i % 8) + 8) % 8}))`;

export function applyTheme(themeId: string, accentOverride: string | null) {
  const t = resolveTheme(themeId);
  const bg = parse(t.bg);
  const text = parse(t.text);
  const accent = parse(accentOverride || t.accent);
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const white: RGB = [255, 255, 255];
  const black: RGB = [0, 0, 0];

  set("--c-app", str(bg));
  set("--c-panel", str(t.panel ? parse(t.panel) : mix(bg, text, 0.03)));
  set("--c-elev", str(t.elev ? parse(t.elev) : mix(bg, text, 0.07)));
  set("--c-line", str(t.line ? parse(t.line) : mix(bg, text, 0.14)));
  set("--c-text", str(text));
  // Escala de texto (sustituye a gray-*): del texto hacia el fondo
  const g: [string, number][] = [["50", 0], ["100", 0], ["200", 0.1], ["300", 0.25], ["400", 0.42], ["500", 0.58], ["600", 0.72]];
  for (const [k, p] of g) set(`--c-gray-${k}`, str(mix(text, bg, p)));
  set("--c-accent", str(accent));
  set("--c-accent-hover", str(t.dark ? mix(accent, black, 0.2) : mix(accent, black, 0.25)));
  set("--c-accent-soft", str(t.dark ? mix(accent, white, 0.25) : mix(accent, black, 0.2)));
  const ink: RGB = [11, 11, 12];
  const cr = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  set("--c-on-accent", cr(accent, ink) >= cr(accent, white) ? str(ink) : "255 255 255");
  const gitNames = ["added", "modified", "deleted", "renamed", "conflict"];
  gitNames.forEach((n, i) => set(`--c-git-${n}`, str(parse(t.git[i]))));
  // Tonos suaves para textos sobre fondo (sustituyen sky/emerald/red)
  const soft = (c: string) => str(t.dark ? mix(parse(c), white, 0.3) : mix(parse(c), black, 0.1));
  set("--c-sky", soft(t.git[3]));
  set("--c-emerald", soft(t.git[0]));
  set("--c-red", soft(t.git[2]));
  t.lanes.forEach((c, i) => set(`--lane-${i}`, str(parse(c))));
  set("--c-scrim", t.dark ? "0 0 0" : "30 41 59");
  root.style.colorScheme = t.dark ? "dark" : "light";
  root.dataset.theme = t.id;
}
