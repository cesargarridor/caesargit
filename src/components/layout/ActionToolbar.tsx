import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown, ArrowUp, ChevronDown, GitBranch, Archive, ArchiveRestore, Search, Loader2, RefreshCw, Settings,
  HardDrive, Workflow, AlertTriangle, FolderGit2,
} from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { getRepoPrefs, usePrefs } from "../../store/usePrefs";
import type { FlowStatus, LfsStatus, PullMode } from "../../types/git";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { UndoRedoButtons } from "./UndoRedoButtons";

const st = () => useRepoStore.getState();

export const SEARCH_EVENT = "caesargit:search";
/** Evento para abrir los popovers inline desde atajos: detail = "branch" | "stash" | "tag". */
export const POPOVER_EVENT = "caesargit:popover";

/** Modo de pull por defecto del repo activo (pref del repo o global). */
export function defaultPullMode(): PullMode {
  const t = st().activeTab();
  return (t && getRepoPrefs(t.info.path).pullMode) || usePrefs.getState().defaultPull;
}

/** Acciones git de alto nivel, compartidas por toolbar, sidebar, paleta y atajos. */
export const gitActions = {
  fetch: (all: boolean, prune: boolean) => st().act("fetch", { all, prune }),
  pull: (mode?: PullMode, autostash?: boolean) => st().act("pull", { mode: mode ?? defaultPullMode(), autostash }),
  push: async (force: boolean, extra: { noVerify?: boolean; tags?: boolean; forceMode?: "lease" | "force" } = {}) => {
    const tab = st().activeTab();
    if (!tab) return;
    if (force) {
      const hard = extra.forceMode === "force";
      const ok = await st().confirm({
        title: hard ? "Force push (sin lease)" : "Force push",
        message: hard
          ? "Se ejecutará push --force y sobrescribirá el historial remoto sin comprobar cambios ajenos. ¿Continuar?"
          : "Se ejecutará push --force-with-lease y puede reescribir el historial remoto. ¿Continuar?",
        confirmLabel: "Force push", danger: true,
      });
      if (!ok) return;
    }
    await st().act("push", {
      force, setUpstream: !tab.status?.upstream, forceMode: force ? (extra.forceMode ?? "lease") : undefined,
      noVerify: extra.noVerify || undefined, tags: extra.tags || undefined,
    });
  },
  createBranch: async (startPoint: string | null = null) => {
    const r = await st().ask({
      title: startPoint ? `Nueva rama desde ${startPoint}` : "Nueva rama desde HEAD",
      fields: [{ key: "name", label: "Nombre de la rama", placeholder: "feature/mi-rama" }],
      confirmLabel: "Crear y cambiar",
    });
    if (r?.name?.trim()) await st().act("create_branch", { name: r.name.trim(), startPoint, checkout: true });
  },
  stash: (message: string | null = null, opts: { untracked?: boolean; stagedOnly?: boolean } = {}) =>
    st().act("stash_push", { message, untracked: opts.untracked ?? true, stagedOnly: opts.stagedOnly || undefined }),
  stashWithMessage: async () => {
    const r = await st().ask({
      title: "Stash",
      fields: [{ key: "message", label: "Mensaje (opcional)", optional: true }],
      confirmLabel: "Guardar stash",
    });
    if (r) await gitActions.stash(r.message?.trim() || null);
  },
  popStash: () => st().act("stash_pop", { index: 0 }),
  undo: () => st().undo(),
  redo: () => st().redo(),
  checkout: (target: string) => st().act("checkout", { target, create: false }),
};

type PopKind = "branch" | "stash" | "tag";

function ToolBtn(props: {
  icon: React.ReactNode; label: string; onMain: () => void; menu?: () => CtxItem[]; disabled?: boolean; title?: string;
  badge?: React.ReactNode; active?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const base = "flex flex-col items-center justify-center text-gray-200 hover:bg-elev disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div ref={ref} className="relative flex items-stretch">
      <button
        className={`${base} h-[38px] min-w-[52px] gap-0.5 px-2 ${props.menu ? "rounded-l" : "rounded"} ${props.active ? "bg-amber/15 text-amber" : ""}`}
        disabled={props.disabled} onClick={props.onMain} title={props.title ?? props.label}
      >
        <span className="flex items-center gap-1">{props.icon}{props.badge}</span>
        <span className="text-[10px] leading-none text-gray-400">{props.label}</span>
      </button>
      {props.menu && (
        <button
          className={`${base} h-[38px] w-4 rounded-r border-l border-line/50`} disabled={props.disabled}
          aria-label={`${props.label} opciones`}
          onClick={() => {
            const r = ref.current?.getBoundingClientRect();
            if (r && props.menu) setMenu({ x: r.left, y: r.bottom + 2, items: props.menu() });
          }}
        >
          <ChevronDown size={11} />
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const Divider = () => <div className="mx-1 h-6 w-px bg-line" />;

/** Popover inline anclado bajo la toolbar: Enter confirma, Esc cancela. */
function InlinePopover(props: { kind: PopKind; x: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [annotated, setAnnotated] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) props.onClose(); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const valid = props.kind === "stash" || name.trim() !== "";
  const submit = async () => {
    if (!valid) return;
    const n = name.trim();
    props.onClose();
    if (props.kind === "branch") await st().act("create_branch", { name: n, startPoint: null, checkout });
    else if (props.kind === "tag") await st().act("create_tag", { name: n, target: null, message: annotated ? (extra.trim() || n) : null });
    else await gitActions.stash(n || null);
  };
  const title = props.kind === "branch" ? "Nueva rama desde HEAD" : props.kind === "tag" ? "Nuevo tag en HEAD" : "Stash de los cambios";
  const ph = props.kind === "branch" ? "feature/mi-rama" : props.kind === "tag" ? "v1.0.0" : "Mensaje (opcional)";
  return (
    <div ref={box} style={{ left: Math.max(8, props.x) }}
      className="fixed top-[calc(var(--h-tab)+var(--h-toolbar)+4px)] z-40 w-[300px] rounded-md border border-line bg-elev p-3 shadow-pop animate-pop-in"
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{title}</div>
      <input ref={ref} value={name} placeholder={ph} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        className="w-full rounded border border-line bg-app px-2 py-1.5 text-xs outline-none focus:border-amber" />
      {props.kind === "branch" && (
        <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} /> Checkout tras crear
        </label>
      )}
      {props.kind === "tag" && (
        <>
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={annotated} onChange={(e) => setAnnotated(e.target.checked)} /> Tag anotado
          </label>
          {annotated && (
            <input value={extra} placeholder="Mensaje del tag" onChange={(e) => setExtra(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              className="mt-2 w-full rounded border border-line bg-app px-2 py-1.5 text-xs outline-none focus:border-amber" />
          )}
        </>
      )}
      <div className="mt-2 text-right text-[10px] text-gray-500">Enter confirma · Esc cancela</div>
    </div>
  );
}

export function DetachedBanner() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const [pop, setPop] = useState(false);
  if (!tab?.status?.detached) return null;
  return (
    <div className="flex items-center gap-3 border-b border-git-modified/40 bg-git-modified/10 px-4 py-1.5 text-xs">
      <AlertTriangle size={13} className="text-git-modified" />
      <span className="text-gray-100">
        HEAD desacoplado en <span className="font-mono">{tab.status.headSha?.slice(0, 7)}</span>: los commits nuevos no pertenecen a ninguna rama.
      </span>
      <button className="ml-auto rounded bg-amber px-2.5 py-1 font-semibold text-onacc hover:bg-amber-hover" onClick={() => setPop(true)}>Create branch</button>
      {pop && <InlinePopover kind="branch" x={window.innerWidth - 330} onClose={() => setPop(false)} />}
    </div>
  );
}

export function ActionToolbar() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const tabs = useRepoStore((s) => s.tabs);
  const refresh = useRepoStore((s) => s.refresh);
  const aliases = usePrefs((s) => s.aliases);
  usePrefs((s) => s.repoPrefs); // re-render al cambiar el pull por defecto
  usePrefs((s) => s.defaultPull);
  const modalNull = tab?.modal == null;
  const off = !tab;
  const status = tab?.status;
  const busy = (tab?.busy ?? 0) > 0;
  const [pop, setPop] = useState<{ kind: PopKind; x: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [lfs, setLfs] = useState<LfsStatus | null>(null);
  const [flow, setFlow] = useState<FlowStatus | null>(null);
  const path = tab?.info.path;
  const pullMode = tab ? defaultPullMode() : "ff";

  useEffect(() => {
    const h = (e: Event) => {
      const k = (e as CustomEvent<PopKind>).detail;
      if (k === "branch" || k === "stash" || k === "tag") setPop({ kind: k, x: k === "branch" ? 330 : 520 });
    };
    window.addEventListener(POPOVER_EVENT, h);
    return () => window.removeEventListener(POPOVER_EVENT, h);
  }, []);

  useEffect(() => {
    if (!path) { setLfs(null); setFlow(null); return; }
    let alive = true;
    invoke<LfsStatus>("lfs_status", { repoPath: path }).then((r) => alive && setLfs(r)).catch(() => alive && setLfs(null));
    invoke<FlowStatus>("flow_status", { repoPath: path }).then((r) => alive && setFlow(r)).catch(() => alive && setFlow(null));
    return () => { alive = false; };
  }, [path, modalNull]);

  const modeItems = (label: (m: PullMode) => string, run: (m: PullMode) => void, checked?: PullMode): CtxItem[] => [
    { label: label("merge"), checked: checked === "merge", onClick: () => run("merge") },
    { label: label("ff"), checked: checked === "ff", onClick: () => run("ff") },
    { label: label("rebase"), checked: checked === "rebase", onClick: () => run("rebase") },
  ];
  const modeName: Record<PullMode, string> = { merge: "Fast-forward si es posible", ff: "Solo fast-forward", rebase: "Rebase" };

  const pullMenu = (): CtxItem[] => [
    ...modeItems((m) => `Pull: ${modeName[m]}`, (m) => void gitActions.pull(m), pullMode),
    { label: "Pull con autostash (rebase)", onClick: () => void gitActions.pull("rebase", true) },
    { sep: true },
    { label: "Definir por defecto", children: modeItems((m) => modeName[m], (m) => st().setRepoPrefs({ pullMode: m }), pullMode) },
    { sep: true },
    { label: "Fetch", onClick: () => void gitActions.fetch(false, false) },
    { label: "Fetch All", hint: "⌘L", onClick: () => void gitActions.fetch(true, false) },
    { label: "Fetch & Prune", onClick: () => void gitActions.fetch(true, true) },
  ];
  const pushMenu = (): CtxItem[] => [
    { label: "Push", onClick: () => void gitActions.push(false) },
    { label: "Push (--no-verify)", onClick: () => void gitActions.push(false, { noVerify: true }) },
    { label: "Push tags", onClick: () => void gitActions.push(false, { tags: true }) },
    { sep: true },
    { label: "Force push (with lease)", danger: true, onClick: () => void gitActions.push(true) },
    { label: "Force push (sin lease)", danger: true, onClick: () => void gitActions.push(true, { forceMode: "force" }) },
  ];
  const branchMenu = (): CtxItem[] => [
    { label: "Crear tag aquí…", onClick: () => setPop({ kind: "tag", x: 330 }) },
    { sep: true },
    { label: "Remotos…", onClick: () => st().setModal({ kind: "remotes" }) },
    { label: "Submódulos…", onClick: () => st().setModal({ kind: "submodules" }) },
    { label: "Worktrees…", onClick: () => st().setModal({ kind: "worktrees" }) },
    { label: "Git LFS…", onClick: () => st().setModal({ kind: "lfs" }) },
    { label: "Gitflow…", onClick: () => st().setModal({ kind: "gitflow" }) },
  ];
  const stashMenu = (): CtxItem[] => [
    { label: "Stash rápido (incluye untracked)", onClick: () => void gitActions.stash(null) },
    { label: "Stash sin untracked", onClick: () => void gitActions.stash(null, { untracked: false }) },
    { label: "Stash solo lo staged", onClick: () => void gitActions.stash(null, { stagedOnly: true }) },
    { label: "Stash con mensaje…", onClick: () => setPop({ kind: "stash", x: 520 }) },
  ];

  const openSelector = (e: React.MouseEvent, kind: "repo" | "branch") => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: CtxItem[] = kind === "repo"
      ? [
        ...tabs.map((t) => ({ label: aliases[t.info.path] ?? t.info.name, checked: t.info.id === tab?.info.id, onClick: () => st().setActive(t.info.id) })),
        { sep: true },
        { label: "Abrir repositorio…", hint: "⌘⇧O", onClick: () => void st().pickAndOpen() },
        { label: "Nueva pestaña", hint: "⌘T", onClick: () => st().setNewTabOpen(true) },
      ]
      : (tab?.branches.filter((b) => !b.isRemote).map((b) => ({
        label: b.name, checked: b.isHead, onClick: () => { if (!b.isHead) void gitActions.checkout(b.name); },
      })) ?? []);
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };

  return (
    <>
      <div className="flex h-[var(--h-toolbar)] shrink-0 items-center gap-0.5 border-b border-line bg-panel px-2">
        <button disabled={off} onClick={(e) => openSelector(e, "repo")} title="Cambiar de repositorio"
          className="flex h-8 max-w-[190px] items-center gap-1.5 rounded px-2 text-xs font-medium text-gray-100 hover:bg-elev disabled:opacity-40">
          <FolderGit2 size={15} className="shrink-0 text-gray-400" />
          <span className="truncate">{tab ? (aliases[tab.info.path] ?? tab.info.name) : "Sin repositorio"}</span>
          <ChevronDown size={11} className="shrink-0 text-gray-500" />
        </button>
        <button disabled={off} onClick={(e) => openSelector(e, "branch")} title="Cambiar de rama"
          className="flex h-8 max-w-[210px] items-center gap-1.5 rounded px-2 font-mono text-xs text-amber hover:bg-elev disabled:opacity-40">
          <GitBranch size={14} className="shrink-0" />
          <span className="truncate">{status?.branch ?? (status?.detached ? "detached" : "—")}</span>
          <ChevronDown size={11} className="shrink-0 text-gray-500" />
        </button>
        <Divider />
        <UndoRedoButtons />
        <Divider />
        <ToolBtn
          icon={<ArrowDown size={17} strokeWidth={1.75} />} label="Pull" disabled={off}
          title={`Pull (${modeName[pullMode]})`} onMain={() => void gitActions.pull()} menu={pullMenu}
          badge={status && status.behind > 0 ? <span className="font-mono text-[10px] text-sky-400">{status.behind}</span> : null}
        />
        <ToolBtn
          icon={<ArrowUp size={17} strokeWidth={1.75} />} label="Push" disabled={off} onMain={() => void gitActions.push(false)} menu={pushMenu}
          badge={status && status.ahead > 0 ? <span className="font-mono text-[10px] text-amber">{status.ahead}</span> : null}
        />
        <Divider />
        <ToolBtn icon={<GitBranch size={17} strokeWidth={1.75} />} label="Branch" disabled={off} title="Crear rama (⌘B)"
          onMain={() => setPop({ kind: "branch", x: 330 })} menu={branchMenu} active={pop?.kind === "branch"} />
        <ToolBtn icon={<Archive size={17} strokeWidth={1.75} />} label="Stash" disabled={off} title="Stash"
          onMain={() => setPop({ kind: "stash", x: 520 })} menu={stashMenu} active={pop?.kind === "stash"} />
        <ToolBtn icon={<ArchiveRestore size={17} strokeWidth={1.75} />} label="Pop" title="Pop Stash" disabled={off || (tab?.stashes.length ?? 0) === 0}
          onMain={() => void gitActions.popStash()} />
        {lfs?.installed && (lfs.patterns.length > 0 || lfs.files.length > 0) && (
          <ToolBtn icon={<HardDrive size={17} strokeWidth={1.75} />} label="LFS" title="Git LFS" onMain={() => st().setModal({ kind: "lfs" })} />
        )}
        {flow?.initialized && (
          <ToolBtn icon={<Workflow size={17} strokeWidth={1.75} />} label="Gitflow" title="Gitflow" onMain={() => st().setModal({ kind: "gitflow" })} />
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {status?.upstream && (
            <span className="font-mono text-[11px] text-gray-400" title={`Upstream: ${status.upstream}`}>
              <span className={status.ahead ? "text-amber" : ""}>↑{status.ahead}</span>{" "}
              <span className={status.behind ? "text-sky-400" : ""}>↓{status.behind}</span>
            </span>
          )}
          {busy && <Loader2 size={14} className="animate-spin text-amber" />}
          <button className="rounded p-1.5 text-gray-400 hover:bg-elev disabled:opacity-40" disabled={off}
            onClick={() => void refresh()} title="Refrescar"><RefreshCw size={14} /></button>
          <button
            className="flex h-8 items-center gap-2 rounded border border-line bg-app px-2.5 text-xs text-gray-400 hover:border-amber/50 disabled:opacity-40"
            disabled={off} onClick={() => window.dispatchEvent(new CustomEvent(SEARCH_EVENT))} title="Buscar commits (⌘F)"
          >
            <Search size={13} /> Buscar <kbd className="font-mono text-[10px] text-gray-500">⌘F</kbd>
          </button>
          <button className="rounded p-1.5 text-gray-400 hover:bg-elev hover:text-amber" title="Preferencias"
            onClick={() => st().setModal({ kind: "preferences" })}><Settings size={15} /></button>
        </div>
      </div>
      <DetachedBanner />
      {pop && <InlinePopover key={pop.kind} kind={pop.kind} x={pop.x} onClose={() => setPop(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
