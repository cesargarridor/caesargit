import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRepoStore } from "../store/useRepoStore";

/** Evento global que WipPanel (D2) puede escuchar para hacer commit con Cmd/Ctrl+Enter. */
export const COMMIT_SHORTCUT_EVENT = "caesargit:commit";

export function useGitEvents(): void {
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const last = new Map<string, number>();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    // throttle: máx. 1 refresh cada 400 ms por repo, con trailing
    listen<{ repoPath: string }>("repo-changed", (ev) => {
      const path = ev.payload.repoPath;
      const tab = useRepoStore.getState().tabs.find((t) => t.info.path === path);
      if (!tab) return;
      const id = tab.info.id;
      if (timers.has(id)) return;
      const wait = Math.max(0, 400 - (Date.now() - (last.get(id) ?? 0)));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        last.set(id, Date.now());
        void useRepoStore.getState().refresh(id);
      }, wait));
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useRepoStore.getState();
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        void st.pickAndOpen();
      } else if (k === "k") {
        e.preventDefault();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (k === "w") {
        if (st.activeId) {
          e.preventDefault();
          void st.closeTab(st.activeId);
        }
      } else if (e.key === "Enter") {
        window.dispatchEvent(new CustomEvent(COMMIT_SHORTCUT_EVENT));
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      unlisten?.();
      timers.forEach(clearTimeout);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
