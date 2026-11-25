import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, GitBranch, Archive, ArchiveRestore, Undo2, CloudDownload, Search,
  Loader2, RefreshCw, Settings,
} from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { useSettingsUi } from "../../store/usePrefs";
import type { PullMode } from "../../types/git";

const st = () => useRepoStore.getState();

/** Acciones git de alto nivel, compartidas por toolbar, sidebar y paleta. */
export const gitActions = {
  fetch: (all: boolean, prune: boolean) => st().act("fetch", { all, prune }),
  pull: (mode: PullMode) => st().act("pull", { mode }),
  push: async (force: boolean) => {
    const tab = st().activeTab();
    if (!tab) return;
    if (force) {
      const ok = await st().confirm({
        title: "Force push",
        message: "Se ejecutará push --force-with-lease y puede reescribir el historial remoto. ¿Continuar?",
        confirmLabel: "Force push", danger: true,
      });
      if (!ok) return;
    }
    await st().act("push", { force, setUpstream: !tab.status?.upstream });
  },
  createBranch: async (startPoint: string | null = null) => {
    const r = await st().ask({
      title: startPoint ? `Nueva rama desde ${startPoint}` : "Nueva rama desde HEAD",
      fields: [{ key: "name", label: "Nombre de la rama", placeholder: "feature/mi-rama" }],
      confirmLabel: "Crear y cambiar",
    });
    if (r?.name?.trim()) await st().act("create_branch", { name: r.name.trim(), startPoint, checkout: true });
  },
  stash: (message: string | null = null) => st().act("stash_push", { message }),
  stashWithMessage: async () => {
    const r = await st().ask({
      title: "Stash",
      fields: [{ key: "message", label: "Mensaje (opcional)", optional: true }],
      confirmLabel: "Guardar stash",
    });
    if (r) await gitActions.stash(r.message?.trim() || null);
  },
  popStash: () => st().act("stash_pop", { index: 0 }),
  undo: async () => {
    const ok = await st().confirm({
      title: "Deshacer último commit",
      message: "Se ejecutará reset --soft HEAD~1: los cambios quedan en staging.",
      confirmLabel: "Deshacer",
    });
    if (ok) await st().act("undo_last_commit");
  },
  checkout: (target: string) => st().act("checkout", { target, create: false }),
};

interface MenuItem { label: string; onClick: () => void; danger?: boolean }

function SplitButton(props: {
  icon: React.ReactNode; label: string; onMain: () => void; menu?: MenuItem[]; disabled?: boolean; title?: string;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const base = "flex items-center gap-1.5 h-8 text-xs text-gray-200 hover:bg-elev disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div ref={ref} className="relative flex items-center">
      <button
        className={`${base} px-2.5 ${props.menu ? "rounded-l-md" : "rounded-md"}`}
        disabled={props.disabled} onClick={props.onMain} title={props.title ?? props.label}
      >
        {props.icon}<span>{props.label}</span>{props.badge}
      </button>
      {props.menu && (
        <button
          className={`${base} px-1 rounded-r-md border-l border-line/60`}
          disabled={props.disabled} onClick={() => setOpen((o) => !o)} aria-label={`${props.label} opciones`}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {open && props.menu && (
        <div className="absolute left-0 top-9 z-40 min-w-[190px] rounded-md border border-line bg-elev py-1 shadow-xl animate-pop-in">
          {props.menu.map((m) => (
            <button
              key={m.label}
              className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-amber/15 ${m.danger ? "text-git-deleted" : "text-gray-200"}`}
              onClick={() => { setOpen(false); m.onClick(); }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActionToolbar() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const setPaletteOpen = useRepoStore((s) => s.setPaletteOpen);
  const refresh = useRepoStore((s) => s.refresh);
  const off = !tab;
  const status = tab?.status;
  const busy = (tab?.busy ?? 0) > 0;

  return (
    <div className="flex h-11 items-center gap-1 border-b border-line bg-gradient-to-r from-amber/[0.07] via-panel to-panel px-2">
      <SplitButton
        icon={<CloudDownload size={14} />} label="Fetch" disabled={off} onMain={() => void gitActions.fetch(false, false)}
        menu={[
          { label: "Fetch All", onClick: () => void gitActions.fetch(true, false) },
          { label: "Fetch & Prune", onClick: () => void gitActions.fetch(true, true) },
        ]}
      />
      <SplitButton
        icon={<ArrowDown size={14} />} label="Pull" disabled={off} onMain={() => void gitActions.pull("ff")}
        badge={status && status.behind > 0 ? <span className="font-mono text-[10px] text-sky-400">↓{status.behind}</span> : null}
        menu={[
          { label: "Pull (Fast-forward only)", onClick: () => void gitActions.pull("ff") },
          { label: "Pull (Rebase)", onClick: () => void gitActions.pull("rebase") },
          { label: "Pull (Merge)", onClick: () => void gitActions.pull("merge") },
        ]}
      />
      <SplitButton
        icon={<ArrowUp size={14} />} label="Push" disabled={off} onMain={() => void gitActions.push(false)}
        badge={status && status.ahead > 0 ? <span className="font-mono text-[10px] text-amber">↑{status.ahead}</span> : null}
        menu={[
          { label: "Push", onClick: () => void gitActions.push(false) },
          { label: "Force push (with lease)", danger: true, onClick: () => void gitActions.push(true) },
        ]}
      />
      <div className="mx-1 h-5 w-px bg-line" />
      <SplitButton icon={<GitBranch size={14} />} label="Branch" disabled={off} onMain={() => void gitActions.createBranch()} />
      <SplitButton
        icon={<Archive size={14} />} label="Stash" disabled={off} onMain={() => void gitActions.stash()}
        menu={[{ label: "Stash con mensaje…", onClick: () => void gitActions.stashWithMessage() }]}
      />
      <SplitButton
        icon={<ArchiveRestore size={14} />} label="Pop" title="Pop Stash" disabled={off || (tab?.stashes.length ?? 0) === 0}
        onMain={() => void gitActions.popStash()}
      />
      <SplitButton icon={<Undo2 size={14} />} label="Undo" disabled={off} onMain={() => void gitActions.undo()} />

      <div className="ml-auto flex items-center gap-2">
        {status && (
          <span className="font-mono text-[11px] text-gray-400" title={status.upstream ?? "sin upstream"}>
            {status.branch ?? "HEAD desacoplado"}
            {status.upstream && (
              <>
                {" "}<span className={status.ahead ? "text-amber" : ""}>↑{status.ahead}</span>{" "}
                <span className={status.behind ? "text-sky-400" : ""}>↓{status.behind}</span>
              </>
            )}
          </span>
        )}
        {busy && <Loader2 size={14} className="animate-spin text-amber" />}
        <button className="rounded-md p-1.5 text-gray-400 hover:bg-elev disabled:opacity-40" disabled={off}
          onClick={() => void refresh()} title="Refrescar"><RefreshCw size={14} /></button>
        <button
          className="flex h-8 items-center gap-2 rounded-md border border-line bg-app px-2.5 text-xs text-gray-400 hover:border-amber/50"
          onClick={() => setPaletteOpen(true)}
        >
          <Search size={13} /> Buscar <kbd className="font-mono text-[10px] text-gray-500">⌘K</kbd>
        </button>
        <button className="rounded-md p-1.5 text-gray-400 hover:bg-elev hover:text-amber" title="Ajustes"
          onClick={() => useSettingsUi.getState().setOpen(true)}><Settings size={15} /></button>
      </div>
    </div>
  );
}
