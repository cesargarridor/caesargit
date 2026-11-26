import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRepoStore, isFilterActive, type RepoTab } from "../../store/useRepoStore";
import { normalizeColumns } from "../../store/useGraphPrefs";
import type { GraphColumn, GraphRow } from "../../types/git";
import { GraphSkeleton, EmptyState, Avatar } from "../layout/Visuals";
import { GraphCell, LANE_W, ROW_H, type LaneMap } from "./GraphCell";
import { ColumnHeader, colStyle } from "./ColumnHeader";
import { BranchPill, PillGroup, groupRefs, type PillModel } from "./BranchPill";
import { DragDropLayer } from "./DragDropLayer";
import { SearchBar, highlight, useGraphSearch } from "./SearchBar";
import {
  ColorPicker, ResetDialog, buildCommitMenu, buildPillMenu, CommitContextMenu, type CommitMenuState,
} from "./CommitContextMenu";

const st = () => useRepoStore.getState();
const HEADER_H = 24;

function relTime(ts: number): string {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "ahora";
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)} mes`;
  return `${Math.floor(d / 86400 / 365)} a`;
}

/** Resumen "N cambios +A ~M −D" del WIP (por archivo). */
function wipSummary(tab: RepoTab) {
  let a = 0, m = 0, d = 0;
  const files = tab.status?.files ?? [];
  for (const f of files) {
    const x = `${f.index}${f.worktree}`;
    if (f.conflicted || x.includes("U")) m++;
    else if (x.includes("D")) d++;
    else if (f.index === "A" || f.worktree === "?" || f.index === "?") a++;
    else m++;
  }
  return { n: files.length, a, m, d };
}

interface RowProps {
  row: GraphRow;
  columns: GraphColumn[];
  graphW: number;
  selected: boolean;
  isMatch: boolean;
  isCurrentMatch: boolean;
  query: string;
  scope: string;
  hoverLane: number | null;
  laneMap: LaneMap;
  branchColors: Record<string, number>;
  head: string | null;
  branch: string | null;
  wip: { n: number; a: number; m: number; d: number };
  top: number;
  onSelect: (e: React.MouseEvent, r: GraphRow) => void;
  onMenu: (e: React.MouseEvent, r: GraphRow) => void;
  onPillMenu: (e: React.MouseEvent, p: PillModel, r: GraphRow) => void;
  onHoverLane: (l: number | null) => void;
}

const Row = memo(function Row(p: RowProps) {
  const { row: r, columns } = p;
  const c = r.commit;
  const visible = columns.filter((x) => x.visible);
  const dim = p.hoverLane !== null && r.colorIdx !== p.hoverLane ? { opacity: 0.3 } : undefined;
  const pills = useMemo(() => groupRefs(c.refs), [c.refs]);
  const firstBranch = c.refs.find((x) => x.kind === "local" || x.kind === "head")?.name;
  const wipPill: PillModel | null = p.branch
    ? { key: "wip", label: p.branch, local: true, head: true, remotes: [], tag: false, stash: false } : null;
  const hl = p.scope === "all" || p.scope === "message";

  return (
    <div
      data-drop-sha={c.sha} data-drop-branch={firstBranch}
      onClick={(e) => p.onSelect(e, r)} onContextMenu={(e) => p.onMenu(e, r)}
      className={`absolute left-0 flex w-full cursor-default items-center text-xs transition-colors duration-100 data-[drop-hot]:bg-amber/20 ${
        p.selected ? "bg-amber/10 shadow-[inset_2px_0_0_rgb(var(--c-accent))]" : p.isMatch ? "bg-amber/5 hover:bg-elev/60" : "hover:bg-elev/60"
      } ${p.isCurrentMatch ? "ring-1 ring-inset ring-amber/60" : ""}`}
      style={{ top: 0, height: ROW_H, transform: `translateY(${p.top}px)` }}
    >
      {visible.map((col, i) => {
        const next = visible[i + 1];
        switch (col.id) {
          case "ref":
            return (
              <div key="ref" style={{ ...colStyle(col), ...dim }} className="flex h-full items-center overflow-hidden px-2">
                {r.isWip
                  ? wipPill && <BranchPill pill={wipPill} lane={r.colorIdx} />
                  : <PillGroup
                      pills={pills} lane={r.colorIdx} branchColors={p.branchColors} connect={next?.id === "graph"}
                      onContext={(e, pill) => p.onPillMenu(e, pill, r)} onHoverLane={p.onHoverLane}
                    />}
              </div>
            );
          case "graph":
            return (
              <div key="graph" style={colStyle(col)} className="h-full overflow-hidden">
                <GraphCell
                  row={r} width={p.graphW} selected={p.selected} hoverLane={p.hoverLane} laneMap={p.laneMap}
                  connect={visible[i - 1]?.id === "ref" && pills.length > 0} onHoverLane={p.onHoverLane}
                />
              </div>
            );
          case "message":
            return (
              <div key="message" style={{ ...colStyle(col), ...dim }} className="flex min-w-0 items-center gap-2 overflow-hidden px-2">
                {r.isWip ? (
                  <>
                    <span className="shrink-0 font-mono italic text-amber">// WIP</span>
                    <span className="truncate text-gray-400">
                      {p.wip.n === 0 ? "sin cambios" : (
                        <>
                          {p.wip.n} {p.wip.n === 1 ? "cambio" : "cambios"}
                          {p.wip.a > 0 && <span className="ml-1.5 text-git-added">+{p.wip.a}</span>}
                          {p.wip.m > 0 && <span className="ml-1.5 text-git-modified">~{p.wip.m}</span>}
                          {p.wip.d > 0 && <span className="ml-1.5 text-git-deleted">−{p.wip.d}</span>}
                        </>
                      )}
                    </span>
                  </>
                ) : (
                  <span className="truncate text-gray-200" title={c.subject}>{hl ? highlight(c.subject, p.query) : c.subject}</span>
                )}
              </div>
            );
          case "author":
            return (
              <div key="author" style={{ ...colStyle(col), ...dim }} className="flex min-w-0 items-center gap-1.5 overflow-hidden px-2">
                {!r.isWip && (
                  <>
                    <Avatar name={c.authorName} email={c.authorEmail} size={16} />
                    <span className="truncate text-gray-400" title={`${c.authorName} <${c.authorEmail}>`}>
                      {p.scope === "author" ? highlight(c.authorName, p.query) : c.authorName}
                    </span>
                  </>
                )}
              </div>
            );
          case "date":
            return (
              <div key="date" style={{ ...colStyle(col), ...dim }} className="overflow-hidden px-2 text-[11px] text-gray-500" title={r.isWip ? "" : new Date(c.authorDate * 1000).toLocaleString()}>
                {r.isWip ? "" : relTime(c.authorDate)}
              </div>
            );
          case "sha":
            return (
              <div key="sha" style={{ ...colStyle(col), ...dim }} className="overflow-hidden px-1">
                {!r.isWip && (
                  <button
                    className="rounded px-1 font-mono text-[11px] text-gray-400 hover:bg-line hover:text-amber" title="Copiar SHA"
                    onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(c.sha); st().toast(`SHA ${c.shortSha} copiado`, "info"); }}
                  >
                    {p.scope === "sha" ? highlight(c.sha.slice(0, 7), p.query) : c.sha.slice(0, 7)}
                  </button>
                )}
              </div>
            );
        }
      })}
      <span style={{ width: 28 }} className="shrink-0" />
    </div>
  );
});

export function CommitGraph() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const parentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<CommitMenuState | null>(null);
  const [reset, setReset] = useState<{ sha: string; short: string } | null>(null);
  const [color, setColor] = useState<{ x: number; y: number; name: string } | null>(null);
  const [hoverLane, setHoverLane] = useState<number | null>(null);
  const search = useGraphSearch();
  const rows = tab?.rows ?? [];

  const columns = useMemo(() => normalizeColumns(tab?.repoPrefs.columns), [tab?.repoPrefs.columns]);
  const branchColors = tab?.repoPrefs.branchColors ?? {};

  const virt = useVirtualizer({
    count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 12, scrollPaddingStart: HEADER_H,
  });

  const graphW = useMemo(() => {
    const cols = Math.min(24, rows.reduce((m, r) => Math.max(m, r.maxColumns, r.column + 1), 1));
    return cols * LANE_W + 4;
  }, [rows]);

  // color personalizado por rama: remapea el carril de la fila donde está la rama
  const laneMap = useMemo(() => {
    const m: LaneMap = {};
    if (!Object.keys(branchColors).length) return m;
    for (const r of rows) {
      if (m[r.colorIdx] !== undefined) continue;
      for (const ref of r.commit.refs) {
        const short = ref.kind === "remote" ? ref.name.slice(ref.name.indexOf("/") + 1) : ref.name;
        const v = branchColors[ref.name] ?? branchColors[short];
        if (v !== undefined) { m[r.colorIdx] = v; break; }
      }
    }
    return m;
  }, [rows, branchColors]);

  const totalW = useMemo(() => columns.filter((c) => c.visible).reduce((s, c) => s + c.width, 28), [columns]);

  // paginación incremental
  const items = virt.getVirtualItems();
  const lastIdx = items.length ? items[items.length - 1].index : 0;
  useEffect(() => {
    if (tab && tab.nextCursor !== null && rows.length > 0 && lastIdx >= rows.length - 30) void st().loadMore();
  }, [lastIdx, rows.length, tab?.nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  const selection = tab?.selection ?? null;
  const selectedCommits = tab?.selectedCommits;
  const selectedSet = useMemo(() => {
    const s = new Set(selectedCommits ?? []);
    if (selection?.kind === "commit") s.add(selection.sha);
    return s;
  }, [selectedCommits, selection]);

  // scroll a la selección (sidebar, paleta, búsqueda, teclado)
  useEffect(() => {
    if (selection?.kind === "commit") {
      const idx = rows.findIndex((r) => r.commit.sha === selection.sha);
      if (idx >= 0) virt.scrollToIndex(idx, { align: "auto" });
    } else if (selection?.kind === "wip") virt.scrollToIndex(0, { align: "auto" });
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchSet = useMemo(() => new Set(search.matches), [search.matches]);
  const currentMatch = search.current >= 0 ? search.matches[search.current] : undefined;
  const wip = useMemo(() => (tab ? wipSummary(tab) : { n: 0, a: 0, m: 0, d: 0 }), [tab?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectOnly = useCallback((r: GraphRow) => {
    anchorRef.current = r.isWip ? null : r.commit.sha;
    st().setSelectedCommits(r.isWip ? [] : [r.commit.sha]);
    st().setSelection(r.isWip ? { kind: "wip" } : { kind: "commit", sha: r.commit.sha });
  }, []);

  const onSelect = useCallback((e: React.MouseEvent, r: GraphRow) => {
    parentRef.current?.focus({ preventScroll: true });
    if (r.isWip) { selectOnly(r); return; }
    const sha = r.commit.sha;
    const cur = st().activeTab();
    if (!cur) return;
    const list = cur.rows;
    if (e.shiftKey && anchorRef.current) {
      const a = list.findIndex((x) => x.commit.sha === anchorRef.current);
      const b = list.findIndex((x) => x.commit.sha === sha);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const shas = list.slice(lo, hi + 1).filter((x) => !x.isWip).map((x) => x.commit.sha);
        st().setSelectedCommits(shas);
        st().setSelection({ kind: "commit", sha });
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      const base = new Set(cur.selectedCommits);
      if (cur.selection?.kind === "commit") base.add(cur.selection.sha);
      if (base.has(sha)) base.delete(sha); else base.add(sha);
      anchorRef.current = sha;
      const next = [...base];
      st().setSelectedCommits(next);
      st().setSelection(next.length ? { kind: "commit", sha: base.has(sha) ? sha : next[next.length - 1] } : null);
      return;
    }
    selectOnly(r);
  }, [selectOnly]);

  const onMenu = useCallback(async (e: React.MouseEvent, r: GraphRow) => {
    e.preventDefault();
    const cur = st().activeTab();
    if (!cur) return;
    if (r.isWip) { selectOnly(r); return; }
    const { clientX: x, clientY: y } = e;
    let selected = [...new Set([...cur.selectedCommits, ...(cur.selection?.kind === "commit" ? [cur.selection.sha] : [])])];
    if (!selected.includes(r.commit.sha)) { selectOnly(r); selected = [r.commit.sha]; }
    const items = await buildCommitMenu({
      tab: cur, rows: cur.rows, row: r, selected, openReset: (sha, short) => setReset({ sha, short }),
    });
    setMenu({ x, y, items });
  }, [selectOnly]);

  const onMenuRow = useCallback((e: React.MouseEvent, r: GraphRow) => { void onMenu(e, r); }, [onMenu]);

  const onPillMenu = useCallback((e: React.MouseEvent, p: PillModel, r: GraphRow) => {
    const cur = st().activeTab();
    if (!cur) return;
    setMenu({ x: e.clientX, y: e.clientY, items: buildPillMenu(cur, p, r, (name) => setColor({ x: e.clientX, y: e.clientY, name })) });
  }, []);

  // teclado: J/K (siguiente/anterior), flechas con el grafo enfocado, ⌘↑/⌘↓ primero/último
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const cur = st().activeTab();
      if (!cur || cur.modal || st().dialog || e.altKey) return;
      const list = cur.rows;
      if (!list.length) return;
      const mod = e.metaKey || e.ctrlKey;
      const focused = !!parentRef.current && parentRef.current.contains(document.activeElement);
      let delta = 0;
      let abs: number | null = null;
      const k = e.key;
      if (!mod && (k === "j" || k === "J")) delta = 1;
      else if (!mod && (k === "k" || k === "K")) delta = -1;
      else if (!mod && focused && k === "ArrowDown") delta = 1;
      else if (!mod && focused && k === "ArrowUp") delta = -1;
      else if (mod && k === "ArrowUp") abs = 0;
      else if (mod && k === "ArrowDown") abs = list.length - 1;
      else return;
      e.preventDefault();
      const curSha = cur.selection?.kind === "commit" ? cur.selection.sha : null;
      const curIdx = cur.selection?.kind === "wip" ? list.findIndex((r) => r.isWip)
        : curSha ? list.findIndex((r) => r.commit.sha === curSha) : -1;
      const idx = abs !== null ? abs : Math.min(list.length - 1, Math.max(0, (curIdx < 0 ? (delta > 0 ? -1 : list.length) : curIdx) + delta));
      const target = list[idx];
      if (!target) return;
      if (e.shiftKey && !target.isWip && abs === null) {
        if (!anchorRef.current) anchorRef.current = curSha ?? target.commit.sha;
        const a = list.findIndex((r) => r.commit.sha === anchorRef.current);
        const [lo, hi] = a < idx ? [a, idx] : [idx, a];
        st().setSelectedCommits(list.slice(Math.max(0, lo), hi + 1).filter((r) => !r.isWip).map((r) => r.commit.sha));
        st().setSelection({ kind: "commit", sha: target.commit.sha });
      } else {
        selectOnly(target);
      }
      virt.scrollToIndex(idx, { align: "auto" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectOnly, virt]);

  if (!tab) return null;
  const head = tab.status?.headSha ?? null;
  const branch = tab.status?.branch ?? null;
  const refsFiltered = tab.repoPrefs.hiddenRefs.length > 0 || !!tab.repoPrefs.soloRef;
  const anyFilter = isFilterActive(tab.graphFilter) || refsFiltered;

  const setCols = (cols: GraphColumn[]) => st().setColumns(cols);

  let body: React.ReactNode;
  if (tab.loading && rows.length === 0) {
    body = <GraphSkeleton />;
  } else if (rows.length === 0) {
    body = anyFilter ? (
      <EmptyState art="commits" title="Sin resultados" hint="Ningún commit coincide con los filtros activos.">
        <button
          className="mt-2 rounded-md border border-line px-3 py-1 text-xs text-gray-200 hover:border-amber hover:text-amber"
          onClick={() => {
            st().clearGraphFilter();
            if (tab.repoPrefs.soloRef) st().toggleSolo(tab.repoPrefs.soloRef);
            if (tab.repoPrefs.hiddenRefs.length) st().hideRefs(tab.repoPrefs.hiddenRefs, false);
          }}
        >
          Quitar filtros
        </button>
      </EmptyState>
    ) : (
      <EmptyState art="commits" title="Aún no hay commits" hint="Haz tu primer commit desde el nodo WIP y el historial aparecerá aquí." />
    );
  } else {
    body = (
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {items.map((v) => {
          const r = rows[v.index];
          const c = r.commit;
          const isSel = r.isWip ? selection?.kind === "wip" : selectedSet.has(c.sha);
          return (
            <Row
              key={r.isWip ? "WIP" : c.sha} row={r} columns={columns} graphW={graphW} selected={isSel}
              isMatch={!r.isWip && matchSet.has(c.sha)} isCurrentMatch={!r.isWip && c.sha === currentMatch}
              query={search.open ? search.query : ""} scope={search.scope}
              hoverLane={hoverLane} laneMap={laneMap} branchColors={branchColors} head={head} branch={branch} wip={wip}
              top={v.start} onSelect={onSelect} onMenu={onMenuRow} onPillMenu={onPillMenu} onHoverLane={setHoverLane}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="relative h-full bg-app">
      <div ref={parentRef} tabIndex={0} className="h-full overflow-auto outline-none">
        <div style={{ minWidth: totalW }}>
          <ColumnHeader columns={columns} onChange={setCols} />
          {body}
        </div>
      </div>
      <SearchBar />
      <DragDropLayer />
      {menu && <CommitContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {reset && <ResetDialog sha={reset.sha} short={reset.short} branch={branch ?? "HEAD"} onClose={() => setReset(null)} />}
      {color && <ColorPicker x={color.x} y={color.y} name={color.name} current={branchColors[color.name]} onClose={() => setColor(null)} />}
    </div>
  );
}
