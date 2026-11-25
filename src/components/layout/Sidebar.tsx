import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronRight, GitBranch, Pin, Search, Tag as TagIcon, Cloud } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { BranchInfo, StashEntry, TagInfo } from "../../types/git";
import { gitActions } from "./ActionToolbar";

export interface CtxItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
}

export function ContextMenu(props: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(props.x, window.innerWidth - r.width - 8), y: Math.min(props.y, window.innerHeight - r.height - 8) });
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) props.onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", props.onClose);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", props.onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", props.onClose);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", props.onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[210px] rounded-md border border-line bg-elev py-1 text-xs shadow-2xl animate-pop-in"
      onContextMenu={(e) => e.preventDefault()}>
      {props.items.map((it, i) =>
        it.sep ? <div key={i} className="my-1 h-px bg-line" /> : (
          <button key={i} disabled={it.disabled}
            className={`block w-full px-3 py-1.5 text-left hover:bg-amber/15 disabled:opacity-40 disabled:hover:bg-transparent ${it.danger ? "text-git-deleted" : "text-gray-200"}`}
            onClick={() => { props.onClose(); it.onClick?.(); }}>
            {it.label}
          </button>
        ))}
    </div>
  );
}

const st = () => useRepoStore.getState();

function Section(props: { title: string; count: number; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <div>
      <button className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-200"
        onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {props.icon}{props.title}
        <span className="ml-auto font-mono text-[10px] text-gray-500">{props.count}</span>
      </button>
      {open && <div className="pb-1">{props.children}</div>}
    </div>
  );
}

const rowCls = "flex cursor-default items-center gap-1.5 truncate px-3 py-[3px] text-xs hover:bg-elev";

export function Sidebar() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);

  if (!tab) return <div className="h-full bg-panel" />;
  const q = filter.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const current = tab.status?.branch ?? null;
  const upstream = tab.status?.upstream ?? null;

  const open = (e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const select = (sha: string) => st().setSelection({ kind: "commit", sha });

  const local = tab.branches.filter((b) => !b.isRemote && match(b.name));
  const remotes = tab.branches.filter((b) => b.isRemote && !b.name.endsWith("/HEAD") && match(b.name));
  const byRemote = new Map<string, BranchInfo[]>();
  for (const b of remotes) {
    const r = b.remote ?? b.name.split("/")[0];
    byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
  }
  const tags = tab.tags.filter((t) => match(t.name));
  const stashes = tab.stashes.filter((s) => match(s.message) || match(s.refName));
  const firstRemote = [...new Set(tab.branches.filter((b) => b.isRemote).map((b) => b.remote ?? b.name.split("/")[0]))][0] ?? "origin";

  const localMenu = (b: BranchInfo): CtxItem[] => [
    { label: "Checkout", disabled: b.isHead, onClick: () => void gitActions.checkout(b.name) },
    { label: "Create Branch here…", onClick: () => void gitActions.createBranch(b.name) },
    { sep: true },
    { label: `Merge ${b.name} into current`, disabled: b.isHead, onClick: () => void st().act("merge_branch", { name: b.name }) },
    { label: `Rebase current onto ${b.name}`, disabled: b.isHead, onClick: () => void st().act("rebase_onto", { name: b.name }) },
    { sep: true },
    { label: "Rename…", onClick: async () => {
      const r = await st().ask({ title: `Renombrar ${b.name}`, fields: [{ key: "n", label: "Nuevo nombre", initial: b.name }], confirmLabel: "Renombrar" });
      if (r?.n?.trim() && r.n.trim() !== b.name) await st().act("rename_branch", { old: b.name, new: r.n.trim() });
    } },
    { label: "Delete (force)", danger: true, disabled: b.isHead, onClick: async () => {
      const ok = await st().confirm({ title: "Eliminar rama", message: `Se eliminará ${b.name} aunque no esté fusionada.`, confirmLabel: "Eliminar", danger: true });
      if (ok) await st().act("delete_branch", { name: b.name, force: true });
    } },
  ];

  const remoteMenu = (b: BranchInfo, remote: string): CtxItem[] => {
    const short = b.name.startsWith(remote + "/") ? b.name.slice(remote.length + 1) : b.name;
    return [
      { label: "Checkout (tracking)", onClick: () => void st().act("checkout_remote_branch", { remoteBranch: b.name }) },
      { label: "Pull into current", onClick: async () => {
        await st().act("fetch", { all: false, prune: false });
        await st().act("merge_branch", { name: b.name });
      } },
      { label: "Push", disabled: upstream !== b.name, onClick: () => void gitActions.push(false) },
      { sep: true },
      { label: "Delete remote branch", danger: true, onClick: async () => {
        const ok = await st().confirm({ title: "Eliminar rama remota", message: `Se eliminará ${short} de ${remote}. No se puede deshacer.`, confirmLabel: "Eliminar", danger: true });
        if (ok) await st().act("delete_remote_branch", { remote, branch: short });
      } },
    ];
  };

  const tagMenu = (t: TagInfo): CtxItem[] => [
    { label: "Checkout", onClick: () => void gitActions.checkout(t.name) },
    { label: "Create Tag here…", onClick: async () => {
      const r = await st().ask({ title: `Nuevo tag en ${t.name}`, fields: [{ key: "n", label: "Nombre" }, { key: "m", label: "Mensaje (opcional, crea tag anotado)", optional: true }], confirmLabel: "Crear" });
      if (r?.n?.trim()) await st().act("create_tag", { name: r.n.trim(), target: t.sha, message: r.m?.trim() || null });
    } },
    { label: "Push Tag", onClick: () => void st().act("push_tag", { remote: firstRemote, name: t.name }) },
    { sep: true },
    { label: "Delete Tag", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Eliminar tag", message: `Se eliminará el tag ${t.name} localmente.`, confirmLabel: "Eliminar", danger: true }))
        await st().act("delete_tag", { name: t.name });
    } },
  ];

  const stashMenu = (s: StashEntry): CtxItem[] => [
    { label: "Apply", onClick: () => void st().act("stash_apply", { index: s.index }) },
    { label: "Pop", onClick: () => void st().act("stash_pop", { index: s.index }) },
    { label: "Branch from Stash…", onClick: async () => {
      const r = await st().ask({ title: "Rama desde stash", fields: [{ key: "n", label: "Nombre de la rama" }], confirmLabel: "Crear" });
      if (r?.n?.trim()) await st().act("stash_branch", { index: s.index, name: r.n.trim() });
    } },
    { sep: true },
    { label: "Drop", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Descartar stash", message: `Se eliminará ${s.refName}: ${s.message}`, confirmLabel: "Drop", danger: true }))
        await st().act("stash_drop", { index: s.index });
    } },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel text-gray-300">
      <div className="p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-app px-2 py-1">
          <Search size={12} className="text-gray-500" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-gray-600" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Local" count={local.length} icon={<GitBranch size={12} />}>
          {local.map((b) => (
            <div key={b.name} className={`${rowCls} ${b.isHead ? "font-semibold text-amber" : ""}`}
              onClick={() => select(b.sha)} onDoubleClick={() => { if (!b.isHead) void gitActions.checkout(b.name); }}
              onContextMenu={(e) => open(e, localMenu(b))} title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}>
              {b.isHead ? <Pin size={11} className="shrink-0 fill-amber" /> : <GitBranch size={11} className="shrink-0 text-gray-500" />}
              <span className="truncate">{b.name}</span>
              {(b.ahead > 0 || b.behind > 0) && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-400">
                  {b.ahead > 0 && <span className="text-amber">↑{b.ahead}</span>}{b.behind > 0 && <span className="ml-1 text-sky-400">↓{b.behind}</span>}
                </span>
              )}
            </div>
          ))}
        </Section>
        <Section title="Remotes" count={remotes.length} icon={<Cloud size={12} />}>
          {[...byRemote.entries()].map(([remote, bs]) => (
            <div key={remote}>
              <div className="px-3 py-0.5 text-[11px] font-medium text-gray-500">{remote}</div>
              {bs.map((b) => (
                <div key={b.name} className={`${rowCls} pl-6`} onClick={() => select(b.sha)}
                  onDoubleClick={() => void st().act("checkout_remote_branch", { remoteBranch: b.name })}
                  onContextMenu={(e) => open(e, remoteMenu(b, remote))}>
                  <Cloud size={11} className="shrink-0 text-gray-500" />
                  <span className="truncate">{b.name.startsWith(remote + "/") ? b.name.slice(remote.length + 1) : b.name}</span>
                </div>
              ))}
            </div>
          ))}
        </Section>
        <Section title="Tags" count={tags.length} icon={<TagIcon size={12} />} defaultOpen={false}>
          {tags.map((t) => (
            <div key={t.name} className={rowCls} onClick={() => select(t.sha)} onContextMenu={(e) => open(e, tagMenu(t))}
              title={t.message ?? t.name}>
              <TagIcon size={11} className="shrink-0 text-amber/70" /><span className="truncate">{t.name}</span>
            </div>
          ))}
        </Section>
        <Section title="Stashes" count={stashes.length} icon={<Archive size={12} />} defaultOpen={false}>
          {stashes.map((s) => (
            <div key={s.refName} className={rowCls} onContextMenu={(e) => open(e, stashMenu(s))} title={`${s.refName} · ${s.branch}`}>
              <Archive size={11} className="shrink-0 text-gray-500" /><span className="truncate">{s.message || s.refName}</span>
            </div>
          ))}
        </Section>
        {current === null && <div className="px-3 py-2 text-[11px] text-gray-500">HEAD desacoplado</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
