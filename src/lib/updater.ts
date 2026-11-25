import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Estado compartido del actualizador (store propio, independiente de usePrefs). */
export interface UpdaterState {
  current: string;
  available: { version: string; notes?: string } | null;
  checking: boolean;
  installing: boolean;
  progress: number | null;
  error: string | null;
}

interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
}

let state: UpdaterState = { current: "", available: null, checking: false, installing: false, progress: null, error: null };
const listeners = new Set<() => void>();
const set = (p: Partial<UpdaterState>) => {
  state = { ...state, ...p };
  listeners.forEach((f) => f());
};

let progressHooked = false;
function hookProgress() {
  if (progressHooked) return;
  progressHooked = true;
  listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
    const { downloaded, total } = e.payload;
    if (total) set({ progress: Math.min(100, Math.round((downloaded / total) * 100)) });
  }).catch(() => {
    progressHooked = false; // fuera de Tauri
  });
}

let versionLoaded = false;
async function loadVersion() {
  if (versionLoaded) return;
  versionLoaded = true;
  try {
    set({ current: await invoke<string>("app_version") });
  } catch {
    versionLoaded = false;
  }
}

/** Preferencia `checkUpdates` (por defecto true) leída de localStorage["caesargit-prefs"]. */
export function checkUpdatesEnabled(): boolean {
  try {
    const raw = localStorage.getItem("caesargit-prefs");
    if (!raw) return true;
    const j = JSON.parse(raw);
    const v = j?.state?.checkUpdates ?? j?.checkUpdates;
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

async function check(manual = false): Promise<void> {
  if (state.checking || state.installing) return;
  hookProgress();
  void loadVersion();
  set({ checking: true, error: null });
  try {
    const info = await invoke<UpdateInfo | null>("check_update");
    set({
      checking: false,
      available: info ? { version: info.version, notes: info.notes ?? undefined } : null,
    });
  } catch (e) {
    // Búsqueda automática: sin red no se molesta al usuario.
    set({ checking: false, error: manual ? String(e) : null });
  }
}

async function install(): Promise<void> {
  if (state.installing) return;
  set({ installing: true, progress: null, error: null });
  try {
    await invoke("install_update"); // reinicia la app al terminar
  } catch (e) {
    set({ installing: false, error: String(e) });
  }
}

function dismiss() {
  set({ available: null });
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

export function useUpdater(): {
  current: string;
  available: { version: string; notes?: string } | null;
  checking: boolean;
  installing: boolean;
  progress: number | null;
  error: string | null;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
} {
  const s = useSyncExternalStore(subscribe, () => state);
  void loadVersion();
  return { ...s, check, install, dismiss };
}
