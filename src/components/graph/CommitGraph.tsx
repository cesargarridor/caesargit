import { GraphSkeleton, EmptyState, Avatar } from "../layout/Visuals";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { useRepoStore } from "../../store/useRepoStore";
import type { GraphRow, RefLabel, ResetMode } from "../../types/git";
import { GraphCell, LANE_W, ROW_H } from "./GraphCell";
import { ContextMenu, type CtxItem } from "../layout/Sidebar";
import { gitActions } from "../layout/ActionToolbar";

const st = () => useRepoStore.getState();

function relTime(ts: number): string {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "ahora";
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)} mes`;
  return `${Math.floor(d / 86400 / 365)} a`;
}

function Pill({ r }: { r: RefLabel }) {
  const cls =
    r.kind === "head" ? "bg-amber text-onacc font-semibold"
    : r.kind === "local" ? "bg-amber/20 text-amber border border-amber/40"
    : r.kind === "remote" ? "bg-sky-400/15 text-sky-300 border border-sky-400/30"
    : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
  return <span className={`shrink-0 rounded px-1.5 py-px font-mono text-[10px] leading-4 ${cls}`}>{r.kind === "tag" ? "🏷 " : ""}{r.name}</span>;
}

export function CommitGraph() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const parentRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const rows = tab?.rows ?? [];

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 12 });

  const graphWidth = useMemo(() => {
    const cols = Math.min(14, rows.reduce((m, r) => Math.max(m, r.maxColumns, r.column + 1), 1));
    return cols * LANE_W + 4;
  }, [rows]);

  // paginación incremental
  const items = virt.getVirtualItems();
  const lastIdx = items.length ? items[items.length - 1].index : 0;
  useEffect(() => {
    if (tab && tab.nextCursor !== null && rows.length > 0 && lastIdx >= rows.length - 30) void st().loadMore();
  }, [lastIdx, rows.length, tab?.nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // scroll a la selección (p. ej. desde sidebar o paleta)
  const selection = tab?.selection ?? null;
  useEffect(() => {
    if (selection?.kind === "commit") {
      const idx = rows.findIndex((r) => r.commit.sha === selection.sha);
      if (idx >= 0) virt.scrollToIndex(idx, { align: "auto" });
    }
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tab) return null;
  const headSha = tab.status?.headSha ?? null;

  const select = (r: GraphRow) => st().setSelection(r.isWip ? { kind: "wip" } : { kind: "commit", sha: r.commit.sha });

  const openMenu = async (e: React.MouseEvent, r: GraphRow) => {
    e.preventDefault();
    select(r);
    if (r.isWip) return;
    const { x, y } = { x: e.clientX, y: e.clientY };
    const sha = r.commit.sha;
    const short = r.commit.shortSha;
    let canRebase = false;
    try {
      canRebase = r.commit.parents.length > 0 && (await invoke<boolean>("is_ancestor_of_head", { repoPath: tab.info.path, sha }));
    } catch { /* sin rebase */ }
    const reset = (mode: ResetMode) => async () => {
      const ok = await st().confirm({
        title: `Reset ${mode} a ${short}`,
        message: mode === "hard"
          ? "Reset --hard descarta TODOS los cambios sin commit y mueve la rama. No se puede deshacer fácilmente."
          : mode === "mixed" ? "Mueve la rama y deja los cambios sin staging." : "Mueve la rama y conserva los cambios en staging.",
        confirmLabel: `Reset ${mode}`, danger: mode === "hard",
      });
      if (ok) await st().act("reset_to", { sha, mode });
    };
    setMenu({ x, y, items: [
      { label: "Checkout (detached)", disabled: sha === headSha, onClick: () => void gitActions.checkout(sha) },
      { label: "Create branch here…", onClick: () => void gitActions.createBranch(sha) },
      { label: "Create tag here…", onClick: async () => {
        const a = await st().ask({ title: `Nuevo tag en ${short}`, fields: [{ key: "n", label: "Nombre" }, { key: "m", label: "Mensaje (opcional, tag anotado)", optional: true }], confirmLabel: "Crear" });
        if (a?.n?.trim()) await st().act("create_tag", { name: a.n.trim(), target: sha, message: a.m?.trim() || null });
      } },
      { sep: true },
      { label: "Cherry-pick", onClick: () => void st().act("cherry_pick", { sha }) },
      { label: "Revert", onClick: () => void st().act("revert_commit", { sha }) },
      { sep: true },
      { label: "Reset soft a este commit", onClick: reset("soft") },
      { label: "Reset mixed a este commit", onClick: reset("mixed") },
      { label: "Reset hard a este commit", danger: true, onClick: reset("hard") },
      { sep: true },
      ...(canRebase ? [{ label: "Interactive Rebase desde aquí…", onClick: () => st().setModal({ kind: "rebase", baseSha: r.commit.parents[0] }) } as CtxItem] : []),
      ...(canRebase ? [{ sep: true } as CtxItem] : []),
      { label: "Copy SHA", onClick: () => void navigator.clipboard.writeText(sha) },
      { label: "Copy message", onClick: () => void navigator.clipboard.writeText(r.commit.body ? `${r.commit.subject}\n\n${r.commit.body}` : r.commit.subject) },
    ] });
  };

  if (tab.loading && rows.length === 0)
    return <GraphSkeleton />;
  if (rows.length === 0)
    return <EmptyState art="commits" title="Aún no hay commits" hint="Haz tu primer commit desde el nodo WIP y el historial aparecerá aquí." />;

  return (
    <div ref={parentRef} className="h-full overflow-auto bg-app">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {items.map((v) => {
          const r = rows[v.index];
          const c = r.commit;
          const isSel = r.isWip ? selection?.kind === "wip" : selection?.kind === "commit" && selection.sha === c.sha;
          const nChanges = tab.status?.files.length ?? 0;
          return (
            <div
              key={r.isWip ? "WIP" : c.sha}
              onClick={() => select(r)} onContextMenu={(e) => void openMenu(e, r)}
              className={`absolute left-0 flex w-full cursor-default items-center gap-2 pr-3 text-xs transition-colors duration-100 ${isSel ? "bg-amber/10 shadow-[inset_2px_0_0_rgb(var(--c-accent))]" : "hover:bg-elev/60"}`}
              style={{ top: 0, height: ROW_H, transform: `translateY(${v.start}px)` }}
            >
              <div style={{ width: graphWidth }} className="overflow-hidden"><GraphCell row={r} width={graphWidth} selected={isSel} /></div>
              {r.isWip ? (
                <span className="italic text-amber">// WIP · {nChanges} {nChanges === 1 ? "archivo modificado" : "archivos modificados"}</span>
              ) : (
                <>
                  <div className="flex min-w-0 shrink items-center gap-1">
                    {c.refs.slice(0, 4).map((x) => <Pill key={x.kind + x.name} r={x} />)}
                    {c.refs.length > 4 && <span className="font-mono text-[10px] text-gray-500">+{c.refs.length - 4}</span>}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-gray-200" title={c.subject}>{c.subject}</span>
                  <Avatar name={c.authorName} email={c.authorEmail} />
                  <button className="shrink-0 rounded px-1 font-mono text-[11px] text-gray-400 hover:bg-line hover:text-amber"
                    title="Copiar SHA" onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(c.sha); st().toast(`SHA ${c.shortSha} copiado`, "info"); }}>
                    {c.sha.slice(0, 7)}
                  </button>
                  <span className="w-12 shrink-0 text-right text-[11px] text-gray-500" title={new Date(c.authorDate * 1000).toLocaleString()}>
                    {relTime(c.authorDate)}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
