import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, Check, ChevronDown, ChevronRight, Cloud, Eye, EyeOff, Folder, FolderOpen, GitBranch, GitFork, Lock,
  MoreHorizontal, Pin, Search, Tag as TagIcon, Boxes, FolderGit2,
} from "lucide-react";
import { useRepoStore, type RepoTab } from "../../store/useRepoStore";
import type { BranchInfo, StashEntry, Submodule, TagInfo, Worktree } from "../../types/git";
import { gitActions } from "./ActionToolbar";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { LANE_COUNT, laneVar } from "../../lib/themes";
import { beginRefDrag, dropAttrs, type DragSource } from "../graph/DragDropLayer";

// Compatibilidad: otros componentes importaban estos símbolos desde aquí.
export { ContextMenu, type CtxItem } from "./ContextMenu";

export const FILTER_EVENT = "caesargit:filter";

const st = () => useRepoStore.getState();
const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => st().toast(`${what} copiado`, "info"));
const shortOf = (name: string, remote: string) => (name.startsWith(remote + "/") ? name.slice(remote.length + 1) : name);
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

interface TreeNode { name: string; full: string; children: Map<string, TreeNode>; leaf?: BranchInfo }
function buildTree(items: { key: string; b: BranchInfo }[]): TreeNode {
  const root: TreeNode = { name: "", full: "", children: new Map() };
  for (const { key, b } of items) {
    let cur = root;
    const parts = key.split("/");
    parts.forEach((p, i) => {
      const full = parts.slice(0, i + 1).join("/");
      let n = cur.children.get(p);
      if (!n) { n = { name: p, full, children: new Map() }; cur.children.set(p, n); }
      if (i === parts.length - 1) n.leaf = b;
      cur = n;
    });
  }
  return root;
}

const sortNodes = (n: TreeNode) =>
  [...n.children.values()].sort((a, b) => Number(b.children.size > 0 && !b.leaf) - Number(a.children.size > 0 && !a.leaf) || a.name.localeCompare(b.name));

function Row(props: {
  depth?: number; selected?: boolean; dim?: boolean; bold?: boolean; icon: React.ReactNode; label: React.ReactNode; right?: React.ReactNode;
  actions?: React.ReactNode; title?: string; dragSrc?: DragSource;
  onClick?: (e: React.MouseEvent) => void; onDoubleClick?: () => void; onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const drop = props.dragSrc ? dropAttrs.pill(props.dragSrc.name, props.dragSrc.kind, props.dragSrc.remote) : {};
  return (
    <div
      {...drop}
      className={`group row-h row-hover flex cursor-default items-center gap-1.5 pr-2 text-xs data-[drop-hot]:outline data-[drop-hot]:outline-1 data-[drop-hot]:outline-amber/70 ${props.selected ? "row-selected" : ""} ${props.dim ? "opacity-45" : ""} ${props.bold ? "font-semibold text-gray-50" : ""}`}
      style={{ paddingLeft: 10 + (props.depth ?? 0) * 12 }}
      title={props.title}
      onPointerDown={(e) => { if (props.dragSrc) beginRefDrag(e, props.dragSrc); }}
      onClick={props.onClick} onDoubleClick={props.onDoubleClick}
      onContextMenu={(e) => { e.stopPropagation(); props.onContextMenu?.(e); }}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.right}
      {props.actions && <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{props.actions}</span>}
    </div>
  );
}

const IconBtn = (p: { title: string; onClick: () => void; children: React.ReactNode; on?: boolean }) => (
  <button title={p.title} className={`rounded p-0.5 hover:bg-line ${p.on ? "text-amber" : "text-gray-500 hover:text-gray-100"}`}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}>{p.children}</button>
);

function Section(props: {
  title: string; count: number; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
  forceOpen?: boolean; onMenu: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const isOpen = open || !!props.forceOpen;
  return (
    <div>
      <button
        className="flex h-[26px] w-full items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-100"
        onClick={() => setOpen(!isOpen)} onContextMenu={(e) => { e.stopPropagation(); props.onMenu(e); }}>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {props.icon}{props.title}
        <span className="ml-auto rounded bg-line/70 px-1.5 font-mono text-[10px] text-gray-400">{props.count}</span>
      </button>
      {isOpen && <div className="pb-1">{props.children}</div>}
    </div>
  );
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "pinned", label: "Pinned" }, { id: "local", label: "Local" }, { id: "remote", label: "Remote" }, { id: "tags", label: "Tags" },
  { id: "stashes", label: "Stashes" }, { id: "submodules", label: "Submodules" }, { id: "worktrees", label: "Worktrees" },
];

const colorItems = (name: string, current: number | undefined): CtxItem[] => [
  { label: "Automático", checked: current === undefined, onClick: () => st().setBranchColor(name, null) },
  { sep: true },
  ...Array.from({ length: LANE_COUNT }, (_, i) => ({
    label: `Color ${i + 1}`, swatch: laneVar(i), checked: current === i, onClick: () => st().setBranchColor(name, i),
  })),
];

export function Sidebar() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const hiddenRefs = useRepoStore((s) => s.hiddenRefs);
  const soloRef = useRepoStore((s) => s.soloRef);
  const pinnedRefs = useRepoStore((s) => s.pinnedRefs);
  const branchColors = useRepoStore((s) => s.branchColors);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [folders, setFolders] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = () => { filterRef.current?.focus(); filterRef.current?.select(); };
    window.addEventListener(FILTER_EVENT, h);
    return () => window.removeEventListener(FILTER_EVENT, h);
  }, []);

  const q = filter.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  const local = useMemo(() => (tab?.branches ?? []).filter((b) => !b.isRemote && match(b.name)), [tab?.branches, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const remotesAll = useMemo(() => (tab?.branches ?? []).filter((b) => b.isRemote && !b.name.endsWith("/HEAD")), [tab?.branches]);
  const remotesF = useMemo(() => remotesAll.filter((b) => match(b.name)), [remotesAll, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const flatLocal = useMemo(() => { // orden visible (para Shift)
    const out: string[] = [];
    const walk = (n: TreeNode) => {
      sortNodes(n).forEach((c) => {
        if (c.leaf) out.push(c.leaf.name);
        walk(c);
      });
    };
    walk(buildTree(local.map((b) => ({ key: b.name, b }))));
    return out;
  }, [local]);

  if (!tab) return <div className="h-full bg-panel" />;
  const t: RepoTab = tab;
  const hiddenSections = t.repoPrefs.hiddenSections;
  const showSec = (id: string) => !hiddenSections.includes(id);
  const current = t.status?.branch ?? null;
  const remoteNames = [...new Set([...t.remotes.map((r) => r.name), ...remotesAll.map((b) => b.remote ?? b.name.split("/")[0])])];
  const firstRemote = remoteNames[0] ?? "origin";
  const remoteOfUpstream = (up: string) => remoteNames.find((r) => up.startsWith(r + "/")) ?? firstRemote;
  const worktreeBranches = new Map(t.worktrees.filter((w) => !w.isMain && w.branch).map((w) => [w.branch as string, w]));
  const tags = t.tags.filter((x) => match(x.name));
  const stashes = t.stashes.filter((x) => match(x.message) || match(x.refName));
  const subs = t.submodules.filter((x) => match(x.name) || match(x.path));
  const wts = t.worktrees.filter((w) => match(w.path) || match(w.branch ?? ""));

  const open = (e: React.MouseEvent, items: CtxItem[]) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }); };
  const select = (sha: string) => st().setSelection({ kind: "commit", sha });
  const confirmDelete = async (names: string[]) => {
    const ok = await st().confirm({
      title: names.length > 1 ? `Eliminar ${names.length} ramas` : "Eliminar rama",
      message: names.length > 1 ? `Se eliminarán (aunque no estén fusionadas): ${names.join(", ")}.` : `Se eliminará ${names[0]} aunque no esté fusionada.`,
      confirmLabel: "Eliminar", danger: true,
    });
    if (ok) { await st().act("delete_branches", { names, force: true }); setSel([]); }
  };

  // ---------- secciones: visibilidad ----------
  const sectionMenu = (extra: CtxItem[] = []): CtxItem[] => [
    ...extra,
    ...(extra.length ? [{ sep: true } as CtxItem] : []),
    { label: "Mostrar / ocultar secciones", disabled: true },
    ...SECTIONS.map((s) => ({
      label: s.label, checked: showSec(s.id),
      onClick: () => st().setRepoPrefs({ hiddenSections: showSec(s.id) ? [...hiddenSections, s.id] : hiddenSections.filter((x) => x !== s.id) }),
    })),
  ];
  const allHidden = (names: string[]) => names.length > 0 && names.every((n) => hiddenRefs.includes(n));

  // ---------- menús ----------
  const refVisibility = (name: string): CtxItem[] => [
    { label: hiddenRefs.includes(name) ? "Show" : "Hide", onClick: () => st().toggleHidden(name) },
    { label: soloRef === name ? "Unsolo" : "Solo", checked: soloRef === name, onClick: () => st().toggleSolo(name) },
  ];

  const localMenu = (b: BranchInfo): CtxItem[] => {
    if (sel.length > 1 && sel.includes(b.name)) {
      const del = sel.filter((n) => n !== current);
      return [
        { label: `Delete ${del.length} branches`, danger: true, disabled: del.length === 0, onClick: () => void confirmDelete(del) },
        { label: `Hide ${sel.length} branches`, onClick: () => st().hideRefs(sel, true) },
        { label: `Show ${sel.length} branches`, onClick: () => st().hideRefs(sel, false) },
      ];
    }
    const wt = worktreeBranches.get(b.name);
    const upRemote = b.upstream ? remoteOfUpstream(b.upstream) : firstRemote;
    return [
      { label: "Checkout", disabled: b.isHead, onClick: () => void gitActions.checkout(b.name) },
      { label: `Merge ${b.name} into ${current ?? "HEAD"}`, disabled: b.isHead, onClick: () => void st().act("merge_branch", { name: b.name, mode: "default" }) },
      { label: `Rebase ${current ?? "HEAD"} onto ${b.name}`, disabled: b.isHead, onClick: () => void st().act("rebase_onto", { name: b.name }) },
      { label: `Fast-forward ${current ?? "HEAD"} to ${b.name}`, disabled: b.isHead || !current, onClick: () => void st().act("fast_forward_branch", { name: current, target: b.name }) },
      { sep: true },
      { label: "Create branch here…", onClick: () => void gitActions.createBranch(b.name) },
      { label: "Create worktree from…", onClick: async () => {
        const r = await st().ask({ title: `Worktree desde ${b.name}`, message: "Si indicas una rama nueva se crea desde esta; si no, se saca esta rama.",
          fields: [{ key: "path", label: "Carpeta (ruta absoluta)" }, { key: "nb", label: "Rama nueva (opcional)", optional: true }], confirmLabel: "Crear" });
        if (!r) return;
        const nb = r.nb?.trim();
        await st().act("add_worktree", nb
          ? { path: r.path.trim(), branch: nb, newBranch: true, startPoint: b.name }
          : { path: r.path.trim(), branch: b.name, newBranch: false });
      } },
      ...(wt ? [{ label: "Open this worktree in new tab", onClick: () => void st().openRepo(wt.path) } as CtxItem] : []),
      { sep: true },
      { label: "Rename…", onClick: async () => {
        const r = await st().ask({ title: `Renombrar ${b.name}`, fields: [{ key: "n", label: "Nuevo nombre", initial: b.name }], confirmLabel: "Renombrar" });
        if (r?.n?.trim() && r.n.trim() !== b.name) await st().act("rename_branch", { old: b.name, new: r.n.trim() });
      } },
      { label: "Delete…", danger: true, disabled: b.isHead, onClick: () => void confirmDelete([b.name]) },
      ...(b.upstream ? [{ label: "Delete local and remote…", danger: true, disabled: b.isHead, onClick: async () => {
        const up = b.upstream as string;
        const ok = await st().confirm({ title: "Eliminar rama local y remota", message: `Se eliminará ${b.name} y ${up}. La rama remota no se puede recuperar.`, confirmLabel: "Eliminar", danger: true });
        if (!ok) return;
        await st().act("delete_branch", { name: b.name, force: true });
        await st().act("delete_remote_branch", { remote: upRemote, branch: shortOf(up, upRemote) });
      } } as CtxItem] : []),
      { sep: true },
      { label: t.repoPrefs.pinnedRefs.includes(b.name) ? "Unpin" : "Pin to left", onClick: () => st().togglePin(b.name) },
      ...refVisibility(b.name),
      { label: "Change branch color", children: colorItems(b.name, branchColors[b.name]) },
      { sep: true },
      { label: "Set upstream", disabled: remotesAll.length === 0,
        children: remotesAll.map((r) => ({ label: r.name, checked: b.upstream === r.name, onClick: () => void st().act("set_upstream", { branch: b.name, remoteBranch: r.name }) })) },
      ...(b.upstream ? [{ label: `Unset upstream (${b.upstream})`, onClick: () => void st().act("unset_upstream", { branch: b.name }) } as CtxItem] : []),
      { label: "Push", onClick: () => (b.isHead ? void gitActions.push(false)
        : void st().act("push_branch", { remote: upRemote, local: b.name, remoteBranch: b.upstream ? shortOf(b.upstream, upRemote) : b.name, force: false })) },
      { label: "Pull", disabled: !b.upstream, onClick: () => (b.isHead ? void gitActions.pull() : void st().act("fast_forward_branch", { name: b.name })) },
      { label: "Fetch", onClick: () => void gitActions.fetch(true, false) },
      { sep: true },
      { label: "Copy branch name", onClick: () => copy(b.name, "Nombre") },
    ];
  };

  const remoteMenu = (b: BranchInfo, remote: string): CtxItem[] => {
    const short = shortOf(b.name, remote);
    return [
      { label: "Checkout (tracking)", onClick: () => void st().act("checkout_remote_branch", { remoteBranch: b.name }) },
      { label: `Merge ${b.name} into ${current ?? "HEAD"}`, onClick: () => void st().act("merge_branch", { name: b.name, mode: "default" }) },
      { label: `Rebase ${current ?? "HEAD"} onto ${b.name}`, onClick: () => void st().act("rebase_onto", { name: b.name }) },
      { label: "Create branch here…", onClick: () => void gitActions.createBranch(b.name) },
      { label: "Pull into current", onClick: async () => {
        await st().act("fetch", { all: false, prune: false });
        await st().act("merge_branch", { name: b.name, mode: "default" });
      } },
      { sep: true },
      { label: t.repoPrefs.pinnedRefs.includes(b.name) ? "Unpin" : "Pin to left", onClick: () => st().togglePin(b.name) },
      ...refVisibility(b.name),
      { label: "Change branch color", children: colorItems(b.name, branchColors[b.name]) },
      { sep: true },
      { label: "Delete remote branch", danger: true, onClick: async () => {
        const ok = await st().confirm({ title: "Eliminar rama remota", message: `Se eliminará ${short} de ${remote}. No se puede deshacer.`, confirmLabel: "Eliminar", danger: true });
        if (ok) await st().act("delete_remote_branch", { remote, branch: short });
      } },
      { label: "Copy branch name", onClick: () => copy(b.name, "Nombre") },
    ];
  };

  const addRemote = async () => {
    const r = await st().ask({ title: "Añadir remoto", fields: [{ key: "name", label: "Nombre", placeholder: "origin" }, { key: "url", label: "URL" }], confirmLabel: "Añadir" });
    if (r) await st().act("add_remote", { name: r.name.trim(), url: r.url.trim() });
  };
  const remoteHeaderMenu = (remote: string): CtxItem[] => {
    const info = t.remotes.find((r) => r.name === remote);
    return [
      { label: `Fetch ${remote}`, onClick: () => void gitActions.fetch(true, false) },
      { label: "Edit…", onClick: async () => {
        const r = await st().ask({ title: `Editar remoto ${remote}`, fields: [{ key: "url", label: "URL", initial: info?.fetchUrl ?? "" }], confirmLabel: "Guardar" });
        if (r?.url.trim()) await st().act("set_remote_url", { name: remote, url: r.url.trim() });
      } },
      { label: "Delete…", danger: true, onClick: async () => {
        if (await st().confirm({ title: "Eliminar remoto", message: `Se quitará el remoto ${remote} y sus ramas de seguimiento.`, confirmLabel: "Eliminar", danger: true }))
          await st().act("remove_remote", { name: remote });
      } },
      { sep: true },
      { label: "Add remote…", onClick: () => void addRemote() },
      { label: "Manage remotes…", onClick: () => st().setModal({ kind: "remotes" }) },
    ];
  };

  const tagMenu = (x: TagInfo): CtxItem[] => [
    { label: "Checkout", onClick: () => void gitActions.checkout(x.name) },
    { label: "Create branch here…", onClick: () => void gitActions.createBranch(x.name) },
    { label: "Create Tag here…", onClick: async () => {
      const r = await st().ask({ title: `Nuevo tag en ${x.name}`, fields: [{ key: "n", label: "Nombre" }, { key: "m", label: "Mensaje (opcional, crea tag anotado)", optional: true }], confirmLabel: "Crear" });
      if (r?.n?.trim()) await st().act("create_tag", { name: r.n.trim(), target: x.sha, message: r.m?.trim() || null });
    } },
    { label: "Push Tag", onClick: () => void st().act("push_tag", { remote: firstRemote, name: x.name }) },
    { sep: true },
    { label: "Delete Tag", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Eliminar tag", message: `Se eliminará el tag ${x.name} localmente.`, confirmLabel: "Eliminar", danger: true }))
        await st().act("delete_tag", { name: x.name });
    } },
    { label: `Delete Tag from ${firstRemote}`, danger: true, onClick: async () => {
      if (await st().confirm({ title: "Eliminar tag remoto", message: `Se eliminará ${x.name} de ${firstRemote}.`, confirmLabel: "Eliminar", danger: true }))
        await st().act("delete_remote_tag", { remote: firstRemote, name: x.name });
    } },
    { sep: true },
    ...refVisibility(x.name),
    { label: "Copy tag name", onClick: () => copy(x.name, "Nombre") },
  ];

  const stashMenu = (s: StashEntry): CtxItem[] => [
    { label: "Apply", onClick: () => void st().act("stash_apply", { index: s.index }) },
    { label: "Pop", onClick: () => void st().act("stash_pop", { index: s.index }) },
    { label: "Apply file…", onClick: async () => {
      const r = await st().ask({ title: `Aplicar un archivo de ${s.refName}`, fields: [{ key: "p", label: "Ruta del archivo (relativa al repo)" }], confirmLabel: "Aplicar" });
      if (r?.p.trim()) await st().act("stash_apply_file", { index: s.index, path: r.p.trim() });
    } },
    { label: "Branch from Stash…", onClick: async () => {
      const r = await st().ask({ title: "Rama desde stash", fields: [{ key: "n", label: "Nombre de la rama" }], confirmLabel: "Crear" });
      if (r?.n?.trim()) await st().act("stash_branch", { index: s.index, name: r.n.trim() });
    } },
    { label: "Edit stash message…", onClick: async () => {
      const r = await st().ask({ title: `Mensaje de ${s.refName}`, fields: [{ key: "m", label: "Mensaje", initial: s.message }], confirmLabel: "Guardar" });
      if (r?.m.trim()) await st().act("stash_rename", { index: s.index, message: r.m.trim() });
    } },
    { sep: true },
    { label: "Delete", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Descartar stash", message: `Se eliminará ${s.refName}: ${s.message}`, confirmLabel: "Drop", danger: true }))
        await st().act("stash_drop", { index: s.index });
    } },
    { sep: true },
    { label: "Copy message", onClick: () => copy(s.message || s.refName, "Mensaje") },
  ];

  const subPath = (x: Submodule) => `${t.info.path.replace(/[\\/]$/, "")}/${x.path}`;
  const subMenu = (x: Submodule): CtxItem[] => [
    { label: "Open", disabled: x.status === "uninitialized", onClick: () => void st().openRepo(subPath(x)) },
    { label: "Update", onClick: () => void st().act("submodule_update", { recursive: false, remote: false, path: x.path }) },
    { label: "Init", disabled: x.status !== "uninitialized", onClick: () => void st().act("submodule_init", { path: x.path }) },
    { sep: true },
    { label: "Remove…", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Eliminar submódulo", message: `Se hará deinit y se borrará ${x.path} del repositorio.`, confirmLabel: "Eliminar", danger: true }))
        await st().act("submodule_remove", { path: x.path });
    } },
  ];
  const subHeaderMenu = (): CtxItem[] => [
    { label: "Update all (recursive)", onClick: () => void st().act("submodule_update", { recursive: true, remote: false }) },
    { label: "Init all", onClick: () => void st().act("submodule_init", {}) },
    { label: "Sync", onClick: () => void st().act("submodule_sync", { recursive: true }) },
    { label: "Add submodule…", onClick: async () => {
      const r = await st().ask({ title: "Añadir submódulo", fields: [{ key: "url", label: "URL" }, { key: "path", label: "Carpeta dentro del repo" }], confirmLabel: "Añadir" });
      if (r) await st().act("submodule_add", { url: r.url.trim(), path: r.path.trim() });
    } },
    { label: "Manage submodules…", onClick: () => st().setModal({ kind: "submodules" }) },
  ];

  const wtMenu = (w: Worktree): CtxItem[] => [
    { label: "Open in new tab", disabled: w.isMain, onClick: () => void st().openRepo(w.path) },
    { label: w.locked ? "Unlock" : "Lock", disabled: w.isMain, onClick: async () => {
      if (w.locked) { await st().act("unlock_worktree", { path: w.path }); return; }
      const r = await st().ask({ title: "Bloquear worktree", fields: [{ key: "r", label: "Motivo (opcional)", optional: true }], confirmLabel: "Bloquear" });
      if (r) await st().act("lock_worktree", { path: w.path, reason: r.r?.trim() || undefined });
    } },
    { label: "Remove…", danger: true, disabled: w.isMain, onClick: async () => {
      const r = await st().ask({ title: "Eliminar worktree", message: w.path, confirmLabel: "Eliminar", danger: true,
        fields: [{ key: "force", label: "Forzar (aunque tenga cambios)", type: "checkbox" }, { key: "del", label: "Borrar también la rama", type: "checkbox" }] });
      if (r) await st().act("remove_worktree", { path: w.path, force: r.force === "true", deleteBranch: r.del === "true" });
    } },
    { sep: true },
    { label: "Copy path", onClick: () => copy(w.path, "Ruta") },
  ];
  const wtHeaderMenu = (): CtxItem[] => [
    { label: "Add worktree…", onClick: () => st().setModal({ kind: "worktrees" }) },
    { label: "Prune", onClick: async () => {
      const n = await st().act<number>("prune_worktrees");
      if (n !== undefined) st().toast(`Worktrees obsoletos eliminados: ${n}`, "info");
    } },
  ];

  // ---------- filas ----------
  const colorDot = (name: string) => (branchColors[name] !== undefined
    ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: laneVar(branchColors[name]) }} /> : null);
  const visBtns = (name: string) => (
    <>
      <IconBtn title={t.repoPrefs.pinnedRefs.includes(name) ? "Unpin" : "Pin to left"} on={t.repoPrefs.pinnedRefs.includes(name)} onClick={() => st().togglePin(name)}><Pin size={11} /></IconBtn>
      <IconBtn title={hiddenRefs.includes(name) ? "Mostrar en el grafo" : "Ocultar del grafo"} on={hiddenRefs.includes(name)} onClick={() => st().toggleHidden(name)}>
        {hiddenRefs.includes(name) ? <EyeOff size={11} /> : <Eye size={11} />}
      </IconBtn>
    </>
  );

  const clickLocal = (e: React.MouseEvent, b: BranchInfo) => {
    if (e.metaKey || e.ctrlKey) { setSel(sel.includes(b.name) ? sel.filter((n) => n !== b.name) : [...sel, b.name]); setAnchor(b.name); return; }
    if (e.shiftKey && anchor) {
      const a = flatLocal.indexOf(anchor); const z = flatLocal.indexOf(b.name);
      if (a >= 0 && z >= 0) { setSel(flatLocal.slice(Math.min(a, z), Math.max(a, z) + 1)); return; }
    }
    setSel([b.name]); setAnchor(b.name); select(b.sha);
  };

  const soloTag = (name: string) => (soloRef === name ? <span className="ml-1 text-[9px] font-semibold uppercase text-amber">solo</span> : null);

  const localRow = (b: BranchInfo, depth: number, label?: string) => (
    <Row key={"l:" + b.name} depth={depth} selected={sel.includes(b.name)} dim={hiddenRefs.includes(b.name)} bold={b.isHead}
      title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
      icon={b.isHead ? <Check size={12} className="shrink-0 text-amber" />
        : worktreeBranches.has(b.name) ? <FolderGit2 size={12} className="shrink-0 text-gray-400" /> : <GitBranch size={12} className="shrink-0 text-gray-500" />}
      label={<>{label ?? b.name}{soloTag(b.name)}</>}
      right={<span className="flex items-center gap-1">{colorDot(b.name)}
        {(b.ahead > 0 || b.behind > 0) && (
          <span className="font-mono text-[10px] text-gray-400">
            {b.ahead > 0 && <span className="text-amber">↑{b.ahead}</span>}{b.behind > 0 && <span className="ml-1 text-sky-400">↓{b.behind}</span>}
          </span>)}</span>}
      actions={visBtns(b.name)}
      dragSrc={{ name: b.name, kind: "local" }}
      onClick={(e) => clickLocal(e, b)} onDoubleClick={() => { if (!b.isHead) void gitActions.checkout(b.name); }}
      onContextMenu={(e) => { if (!sel.includes(b.name)) setSel([b.name]); open(e, localMenu(b)); }} />
  );
  const remoteRow = (b: BranchInfo, remote: string, depth: number, label?: string) => (
    <Row key={"r:" + b.name} depth={depth} dim={hiddenRefs.includes(b.name)} title={b.name}
      icon={<Cloud size={12} className="shrink-0 text-gray-500" />}
      label={<>{label ?? shortOf(b.name, remote)}{soloTag(b.name)}</>}
      right={colorDot(b.name)} actions={visBtns(b.name)}
      dragSrc={{ name: b.name, kind: "remote", remote }}
      onClick={() => select(b.sha)} onDoubleClick={() => void st().act("checkout_remote_branch", { remoteBranch: b.name })}
      onContextMenu={(e) => open(e, remoteMenu(b, remote))} />
  );

  const renderTree = (node: TreeNode, depth: number, keyPrefix: string, leafRow: (b: BranchInfo, depth: number, label: string) => React.ReactNode): React.ReactNode[] =>
    sortNodes(node).flatMap((c) => {
      const out: React.ReactNode[] = [];
      const hasKids = c.children.size > 0;
      if (hasKids && !c.leaf) {
        const key = keyPrefix + c.full;
        const isOpen = q ? true : folders[key] !== false;
        out.push(
          <Row key={"f:" + key} depth={depth} icon={isOpen ? <FolderOpen size={12} className="shrink-0 text-gray-500" /> : <Folder size={12} className="shrink-0 text-gray-500" />}
            label={c.name} onClick={() => setFolders({ ...folders, [key]: !isOpen })} />,
        );
        if (isOpen) out.push(...renderTree(c, depth + 1, keyPrefix, leafRow));
      } else if (c.leaf) {
        out.push(leafRow(c.leaf, depth, c.name));
        if (hasKids) out.push(...renderTree(c, depth + 1, keyPrefix, leafRow));
      }
      return out;
    });

  const localTree = buildTree(local.map((b) => ({ key: b.name, b })));
  const byRemote = new Map<string, BranchInfo[]>();
  for (const b of remotesF) {
    const r = b.remote ?? b.name.split("/")[0];
    byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
  }
  if (!q) for (const r of remoteNames) if (!byRemote.has(r)) byRemote.set(r, []);
  const pinnedBranches = pinnedRefs.map((n) => t.branches.find((b) => b.name === n)).filter((b): b is BranchInfo => !!b && match(b.name));
  const remoteBranchNames = remotesAll.map((b) => b.name);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel text-gray-300">
      <div className="flex items-center gap-1 p-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-line bg-app px-2 py-1 focus-within:border-amber">
          <Search size={12} className="text-gray-500" />
          <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (⌘⌥F)"
            onKeyDown={(e) => { if (e.key === "Escape") { setFilter(""); (e.target as HTMLInputElement).blur(); } }}
            className="w-full bg-transparent text-xs outline-none placeholder:text-gray-600" />
        </div>
        <button className="rounded p-1 text-gray-500 hover:bg-elev hover:text-gray-100" title="Secciones"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2, items: sectionMenu() }); }}>
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto" onContextMenu={(e) => open(e, sectionMenu())}>
        {showSec("pinned") && pinnedBranches.length > 0 && (
          <Section title="Pinned" count={pinnedBranches.length} icon={<Pin size={11} />} onMenu={(e) => open(e, sectionMenu())}>
            {pinnedBranches.map((b) => (b.isRemote ? remoteRow(b, b.remote ?? b.name.split("/")[0], 0, b.name) : localRow(b, 0)))}
          </Section>
        )}
        {showSec("local") && (
          <Section title="Local" count={local.length} icon={<GitBranch size={11} />} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu([
              { label: "Create branch…", onClick: () => void gitActions.createBranch() },
              { label: "Hide all in graph", disabled: allHidden(local.map((b) => b.name)), onClick: () => st().hideRefs(local.map((b) => b.name), true) },
              { label: "Show all in graph", onClick: () => st().hideRefs(local.map((b) => b.name), false) },
            ]))}>
            {renderTree(localTree, 0, "l/", (b, d, label) => localRow(b, d, label))}
          </Section>
        )}
        {showSec("remote") && (
          <Section title="Remote" count={remotesF.length} icon={<Cloud size={11} />} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu([
              { label: "Add remote…", onClick: () => void addRemote() },
              { label: "Hide all in graph", disabled: allHidden(remoteBranchNames), onClick: () => st().hideRefs(remoteBranchNames, true) },
              { label: "Show all in graph", onClick: () => st().hideRefs(remoteBranchNames, false) },
            ]))}>
            {[...byRemote.entries()].map(([remote, bs]) => {
              const key = "remote:" + remote;
              const isOpen = q ? true : folders[key] !== false;
              const tree = buildTree(bs.map((b) => ({ key: shortOf(b.name, remote), b })));
              return (
                <div key={remote}>
                  <Row icon={isOpen ? <ChevronDown size={11} className="shrink-0 text-gray-500" /> : <ChevronRight size={11} className="shrink-0 text-gray-500" />}
                    label={<span className="flex items-center gap-1.5 font-medium text-gray-300"><Cloud size={12} className="text-gray-500" />{remote}</span>}
                    right={<span className="font-mono text-[10px] text-gray-500">{bs.length}</span>}
                    onClick={() => setFolders({ ...folders, [key]: !isOpen })} onContextMenu={(e) => open(e, remoteHeaderMenu(remote))} />
                  {isOpen && renderTree(tree, 1, remote + "/", (b, d, label) => remoteRow(b, remote, d, label))}
                </div>
              );
            })}
          </Section>
        )}
        {showSec("tags") && (
          <Section title="Tags" count={tags.length} icon={<TagIcon size={11} />} defaultOpen={false} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu([
              { label: "Push all tags", onClick: () => void st().act("push_all_tags", { remote: firstRemote }) },
              { label: "Hide all in graph", onClick: () => st().hideRefs(t.tags.map((x) => x.name), true) },
              { label: "Show all in graph", onClick: () => st().hideRefs(t.tags.map((x) => x.name), false) },
            ]))}>
            {tags.map((x) => (
              <Row key={x.name} dim={hiddenRefs.includes(x.name)} title={x.message ?? x.name}
                icon={<TagIcon size={12} className="shrink-0 text-amber/70" />} label={x.name}
                actions={<IconBtn title={hiddenRefs.includes(x.name) ? "Mostrar" : "Ocultar"} onClick={() => st().toggleHidden(x.name)}>{hiddenRefs.includes(x.name) ? <EyeOff size={11} /> : <Eye size={11} />}</IconBtn>}
                onClick={() => select(x.sha)} onContextMenu={(e) => open(e, tagMenu(x))} />
            ))}
          </Section>
        )}
        {showSec("stashes") && (
          <Section title="Stashes" count={stashes.length} icon={<Archive size={11} />} defaultOpen={false} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu([
              { label: t.repoPrefs.hideStashesInGraph ? "Show stashes in graph" : "Hide stashes in graph",
                onClick: () => { st().setRepoPrefs({ hideStashesInGraph: !t.repoPrefs.hideStashesInGraph }); void st().refresh(); } },
            ]))}>
            {stashes.map((s) => (
              <Row key={s.refName} title={`${s.refName} · ${s.branch}`} icon={<Archive size={12} className="shrink-0 text-gray-500" />}
                label={s.message || s.refName}
                actions={<IconBtn title="Apply" onClick={() => void st().act("stash_apply", { index: s.index })}><Check size={11} /></IconBtn>}
                onDoubleClick={() => void st().act("stash_apply", { index: s.index })}
                onContextMenu={(e) => open(e, stashMenu(s))} />
            ))}
          </Section>
        )}
        {showSec("submodules") && (
          <Section title="Submodules" count={subs.length} icon={<Boxes size={11} />} defaultOpen={false} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu(subHeaderMenu()))}>
            {subs.map((x) => (
              <Row key={x.path} title={`${x.url}\n${x.path}`} icon={<Boxes size={12} className="shrink-0 text-gray-500" />} label={x.name}
                right={x.status !== "ok" ? <span className={`text-[9px] uppercase ${x.status === "conflict" ? "text-git-conflict" : "text-git-modified"}`}>{x.status}</span> : undefined}
                onDoubleClick={() => { if (x.status !== "uninitialized") void st().openRepo(subPath(x)); }}
                onContextMenu={(e) => open(e, subMenu(x))} />
            ))}
          </Section>
        )}
        {showSec("worktrees") && (
          <Section title="Worktrees" count={wts.length} icon={<GitFork size={11} />} defaultOpen={false} forceOpen={!!q}
            onMenu={(e) => open(e, sectionMenu(wtHeaderMenu()))}>
            {wts.map((w) => (
              <Row key={w.path} title={w.path} icon={w.locked ? <Lock size={12} className="shrink-0 text-git-modified" /> : <FolderGit2 size={12} className="shrink-0 text-gray-500" />}
                label={<>{baseName(w.path)}{w.branch && <span className="ml-1.5 font-mono text-[10px] text-gray-500">{w.branch}</span>}</>}
                right={w.isMain ? <span className="text-[9px] uppercase text-gray-500">main</span> : w.prunable ? <span className="text-[9px] uppercase text-git-deleted">prunable</span> : undefined}
                onDoubleClick={() => { if (!w.isMain) void st().openRepo(w.path); }}
                onContextMenu={(e) => open(e, wtMenu(w))} />
            ))}
          </Section>
        )}
        {t.status?.detached && <div className="px-3 py-2 text-[11px] text-gray-500">HEAD desacoplado</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
