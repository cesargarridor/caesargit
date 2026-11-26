import { create } from "zustand";
import { useRepoStore } from "../../store/useRepoStore";

export function statusColor(c: string): string {
  switch (c) {
    case "A": case "?": return "text-git-added";
    case "D": return "text-git-deleted";
    case "R": case "C": return "text-git-renamed";
    case "U": return "text-git-conflict";
    default: return "text-git-modified";
  }
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function baseName(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

export const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
export function extOf(p: string): string {
  const n = baseName(p).name;
  const i = n.lastIndexOf(".");
  return i <= 0 ? "" : n.slice(i + 1).toLowerCase();
}
export const isImage = (p: string) => IMAGE_EXT.includes(extOf(p));

export function copyText(text: string) {
  const toast = useRepoStore.getState().toast;
  navigator.clipboard.writeText(text).then(() => toast("Copiado", "info")).catch(() => toast("No se pudo copiar"));
}

/** Elementos de edición donde las teclas S/U/etc. no deben disparar atajos. */
export function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest?.(".cm-editor");
}

/* ---------- preferencias de vista de diff / archivos (persistentes) ---------- */

export type DiffMode = "hunk" | "inline" | "split";
export type FileView = "path" | "tree";
/** 3 / 10 / 25 líneas de contexto o archivo completo. */
export type ContextSize = 3 | 10 | 25 | "full";

interface DiffPrefs {
  mode: DiffMode;
  ignoreWhitespace: boolean;
  context: ContextSize;
  wordDiff: boolean;
  fileView: FileView;
  set: (p: Partial<Omit<DiffPrefs, "set">>) => void;
}

const KEY = "caesargit.diffprefs";
function load(): Partial<DiffPrefs> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DiffPrefs>; } catch { return {}; }
}

export const useDiffPrefs = create<DiffPrefs>((set, get) => ({
  mode: "hunk", ignoreWhitespace: false, context: 3, wordDiff: false, fileView: "path",
  ...load(),
  set: (p) => {
    set(p);
    const { mode, ignoreWhitespace, context, wordDiff, fileView } = get();
    localStorage.setItem(KEY, JSON.stringify({ mode, ignoreWhitespace, context, wordDiff, fileView }));
  },
}));

export const contextLines = (c: ContextSize): number => (c === "full" ? 100000 : c);

/** Argumentos comunes de get_file_diff / get_commit_file_diff según las preferencias. */
export function diffArgs(p: Pick<DiffPrefs, "ignoreWhitespace" | "context" | "wordDiff">) {
  return { ignoreWhitespace: p.ignoreWhitespace, contextLines: contextLines(p.context), wordDiff: p.wordDiff };
}
