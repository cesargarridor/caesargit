import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useRepoStore } from "../store/useRepoStore";
import { clampZoom, usePrefs } from "../store/usePrefs";
import type { GitProgress } from "../types/git";
import { POPOVER_EVENT, gitActions } from "../components/layout/ActionToolbar";
import { FILTER_EVENT } from "../components/layout/Sidebar";

/** Evento global que el panel de commit (WipPanel/CommitBox) escucha para hacer commit. */
export const COMMIT_SHORTCUT_EVENT = "caesargit:commit";

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || !!el.closest?.(".cm-editor"));
};

export function useGitEvents(): void {
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const last = new Map<string, number>();
    const st0 = useRepoStore.getState;
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const keep = (p: Promise<() => void>) => p.then((u) => { if (disposed) u(); else unlisteners.push(u); }).catch(() => undefined);

    // repo-changed: máx. 1 refresh cada 400 ms por repo, con trailing
    keep(listen<{ repoPath: string }>("repo-changed", (ev) => {
      const tab = useRepoStore.getState().tabs.find((t) => t.info.path === ev.payload.repoPath);
      if (!tab) return;
      const id = tab.info.id;
      if (timers.has(id)) return;
      const wait = Math.max(0, 400 - (Date.now() - (last.get(id) ?? 0)));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        last.set(id, Date.now());
        void useRepoStore.getState().refresh(id);
      }, wait));
    }));

    // progreso de operaciones largas (clone...) -> barra de la StatusBar
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    keep(listen<GitProgress>("git-progress", (ev) => {
      const st = useRepoStore.getState();
      clearTimeout(progressTimer);
      st.setProgress(ev.payload);
      if (ev.payload.percent >= 100) progressTimer = setTimeout(() => useRepoStore.getState().setProgress(null), 1500);
    }));

    // arrastrar una carpeta sobre la ventana abre el repo
    keep(getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop") return;
      for (const p of ev.payload.paths) void useRepoStore.getState().openRepo(p);
    }));

    // auto-fetch periódico (por repo o global; 0 = desactivado)
    const lastAuto = new Map<string, number>();
    const started = Date.now();
    const autoFetch = setInterval(() => {
      const prefs = usePrefs.getState();
      for (const t of useRepoStore.getState().tabs) {
        const mins = t.repoPrefs.autoFetchMinutes ?? prefs.autoFetchMinutes;
        if (!mins || t.busy > 0 || t.status?.operation) continue;
        const since = lastAuto.get(t.info.id) ?? t.lastFetch ?? started;
        if (Date.now() - since < mins * 60_000) continue;
        lastAuto.set(t.info.id, Date.now());
        invoke("fetch", { repoPath: t.info.path, all: true, prune: false })
          .then(() => { useRepoStore.getState().markFetched(t.info.id); void useRepoStore.getState().refresh(t.info.id); })
          .catch(() => undefined); // silencioso: sin red / sin remotos
      }
    }, 30_000);

    const leftVisible = () => st0().activeTab()?.repoPrefs.showLeftPanel ?? usePrefs.getState().showLeftPanel;
    const setLeft = (v: boolean) => {
      if (st0().activeId) st0().setRepoPrefs({ showLeftPanel: v });
      else usePrefs.getState().set({ showLeftPanel: v });
    };
    const focusPane = (pane: "sidebar" | "inspector") => {
      document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      const st = useRepoStore.getState();
      const prefs = usePrefs.getState();
      const mod = e.metaKey || e.ctrlKey;
      const code = e.code;
      const editable = isEditable(e.target);
      const anyOverlay = !!st.dialog;

      // Ctrl+Tab / Ctrl+Shift+Tab: ciclar pestañas
      if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); st.cycleTab(e.shiftKey ? -1 : 1); return; }

      if (!mod) {
        if (e.key === "Escape") {
          if (anyOverlay || st.paletteOpen || st.modal || editable) return;
          if (st.selectedCommits.length > 1) st.setSelectedCommits([]);
          else if (st.newTabOpen && st.tabs.length) st.setNewTabOpen(false);
          return;
        }
        if (e.altKey && st.activeId) {
          const path = st.activeTab()?.info.path;
          if (code === "KeyT" && path) { e.preventDefault(); void invoke("open_in_terminal", { repoPath: path }).catch(() => undefined); }
          else if (code === "KeyO" && path) { e.preventDefault(); void invoke("reveal_in_file_manager", { repoPath: path }).catch(() => undefined); }
          return;
        }
        // H / L: saltar de panel (J/K y ⌘↑/↓ los gestiona el grafo)
        if (!editable && !e.shiftKey && !st.modal && !anyOverlay && !st.paletteOpen && st.activeId) {
          if (e.key === "h") { e.preventDefault(); if (!leftVisible()) setLeft(true); setTimeout(() => focusPane("sidebar"), 0); }
          else if (e.key === "l") { e.preventDefault(); focusPane("inspector"); }
        }
        return;
      }

      const k = e.key.toLowerCase();
      // zoom (⌘+ / ⌘= / ⌘− / ⌘0)
      if (e.key === "+" || e.key === "=" || code === "NumpadAdd") { e.preventDefault(); prefs.set({ zoom: clampZoom(prefs.zoom + 10) }); return; }
      if (e.key === "-" || code === "NumpadSubtract") { e.preventDefault(); prefs.set({ zoom: clampZoom(prefs.zoom - 10) }); return; }
      if (e.key === "0" && !e.altKey) { e.preventDefault(); prefs.set({ zoom: 100 }); return; }
      // ⌘1-9
      if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) { e.preventDefault(); st.activateIndex(Number(e.key) - 1); return; }

      if (e.altKey && code === "KeyF") { e.preventDefault(); if (!leftVisible()) setLeft(true); setTimeout(() => window.dispatchEvent(new CustomEvent(FILTER_EVENT)), 0); return; }
      if (e.altKey) return;

      if (k === "o") { e.preventDefault(); void st.pickAndOpen(); return; }
      if (k === "t" && !e.shiftKey) { e.preventDefault(); st.setNewTabOpen(true); return; }
      if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        if (st.newTabOpen && st.tabs.length) st.setNewTabOpen(false);
        else if (st.activeId) void st.closeTab(st.activeId);
        return;
      }
      if (k === "k" || k === "p") { e.preventDefault(); st.setPaletteOpen(!st.paletteOpen); return; }
      if (e.key === "/" || code === "Slash") { e.preventDefault(); st.setModal({ kind: "shortcuts" }); return; }
      if (e.key === ",") { e.preventDefault(); st.setModal({ kind: "preferences" }); return; }
      if (k === "j") { e.preventDefault(); setLeft(!leftVisible()); return; }

      // el resto exige un repo y no robar el undo nativo de campos de texto
      if (!st.activeId) return;
      if (k === "b" && !e.shiftKey) { e.preventDefault(); window.dispatchEvent(new CustomEvent(POPOVER_EVENT, { detail: "branch" })); return; }
      if (k === "l" && !e.shiftKey) { e.preventDefault(); void gitActions.fetch(true, false); return; }
      if (k === "z" && !editable) { e.preventDefault(); void (e.shiftKey ? st.redo() : st.undo()); return; }
      if (k === "y" && !editable && !e.shiftKey) { e.preventDefault(); void st.redo(); return; }
      if (k === "s" && e.shiftKey) { e.preventDefault(); void st.act("stage_all"); return; }
      if (k === "u" && e.shiftKey) { e.preventDefault(); void st.act("unstage_all"); return; }
      if (k === "d" && !e.shiftKey) {
        const sel = st.selection;
        if (sel?.kind === "file" && !sel.sha) { e.preventDefault(); void st.act("run_difftool", { path: sel.path, staged: sel.staged }); }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
      timers.forEach(clearTimeout);
      clearTimeout(progressTimer);
      clearInterval(autoFetch);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
