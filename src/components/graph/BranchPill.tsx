import { useState } from "react";
import { Archive, Check, Cloud, Monitor, Tag } from "lucide-react";
import { laneColor } from "./GraphCell";
import { beginRefDrag, dropAttrs } from "./DragDropLayer";
import type { RefLabel } from "../../types/git";

export interface PillModel {
  key: string;
  /** nombre mostrado (rama local fusionada con su remota, tag o stash) */
  label: string;
  local: boolean;
  head: boolean;
  /** remotas completas ("origin/main") fusionadas en la pill */
  remotes: string[];
  tag: boolean;
  stash: boolean;
}

const remoteBranch = (full: string) => full.slice(full.indexOf("/") + 1);
const remoteName = (full: string) => (full.includes("/") ? full.slice(0, full.indexOf("/")) : "origin");

/** Agrupa refs de un commit: local+remota de la misma rama en una sola pill. */
export function groupRefs(refs: RefLabel[]): PillModel[] {
  const pills: PillModel[] = [];
  const byLocal = new Map<string, PillModel>();
  for (const r of refs) {
    if (r.kind === "local" || r.kind === "head") {
      const p: PillModel = { key: `l:${r.name}`, label: r.name, local: true, head: r.kind === "head", remotes: [], tag: false, stash: false };
      byLocal.set(r.name, p);
      pills.push(p);
    }
  }
  for (const r of refs) {
    if (r.kind !== "remote" || /\/HEAD$/.test(r.name)) continue;
    const p = byLocal.get(remoteBranch(r.name));
    if (p) p.remotes.push(r.name);
    else pills.push({ key: `r:${r.name}`, label: r.name, local: false, head: false, remotes: [r.name], tag: false, stash: false });
  }
  for (const r of refs) {
    if (r.kind === "tag") pills.push({ key: `t:${r.name}`, label: r.name, local: false, head: false, remotes: [], tag: true, stash: false });
    else if (r.kind === "stash") pills.push({ key: `s:${r.name}`, label: r.name, local: false, head: false, remotes: [], tag: false, stash: true });
  }
  return pills.sort((a, b) => Number(b.head) - Number(a.head));
}

/** Nombre de ref corto usable en filtros/hide/solo. */
export const pillRefName = (p: PillModel) => (p.local || p.tag || p.stash ? p.label : p.remotes[0] ?? p.label);

interface PillProps {
  pill: PillModel;
  /** índice de carril de la fila (color por defecto) */
  lane: number;
  /** carril personalizado por rama */
  custom?: number;
  onContext?: (e: React.MouseEvent, p: PillModel) => void;
  onHover?: (on: boolean) => void;
}

export function BranchPill({ pill, lane, custom, onContext, onHover }: PillProps) {
  const color = laneColor(custom ?? lane);
  const draggable = !pill.tag && !pill.stash;
  const style: React.CSSProperties = pill.head
    ? { background: "rgb(var(--c-accent))", color: "rgb(var(--c-on-accent))", borderColor: "rgb(var(--c-accent))" }
    : { background: `color-mix(in srgb, ${color} 20%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 55%, transparent)` };
  const tip = [pill.local ? `Local: ${pill.label}` : "", ...pill.remotes.map((r) => `Remota: ${r}`), pill.tag ? `Tag: ${pill.label}` : "", pill.stash ? `Stash: ${pill.label}` : ""]
    .filter(Boolean).join("\n");
  const dropProps = pill.local ? dropAttrs.pill(pill.label, "local", pill.remotes[0] ? remoteName(pill.remotes[0]) : undefined)
    : pill.remotes.length ? dropAttrs.pill(pill.remotes[0], "remote") : {};
  return (
    <span
      {...dropProps}
      title={tip}
      onPointerDown={draggable ? (e) => beginRefDrag(e, pill.local ? { name: pill.label, kind: "local" } : { name: pill.remotes[0], kind: "remote", remote: remoteName(pill.remotes[0]) }) : undefined}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { if (onContext) { e.preventDefault(); e.stopPropagation(); onContext(e, pill); } }}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}
      className={`inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-[10px] border px-1.5 py-px font-mono text-[11px] leading-4 transition-shadow data-[drop-hot]:ring-2 data-[drop-hot]:ring-amber ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${pill.head ? "font-semibold" : ""}`}
      style={style}
    >
      {pill.head && <Check size={11} strokeWidth={3} className="shrink-0" />}
      {pill.local && !pill.head && <Monitor size={11} className="shrink-0" />}
      {pill.local && pill.head && <Monitor size={11} className="shrink-0 opacity-70" />}
      {pill.remotes.length > 0 && <Cloud size={11} className="shrink-0" />}
      {pill.tag && <Tag size={11} className="shrink-0" />}
      {pill.stash && <Archive size={11} className="shrink-0" />}
      <span className="truncate">{pill.label}</span>
    </span>
  );
}

/** Contenido de la columna BRANCH/TAG de una fila. */
export function PillGroup({
  pills, lane, branchColors, onContext, onHoverLane, connect,
}: {
  pills: PillModel[];
  lane: number;
  branchColors: Record<string, number>;
  onContext: (e: React.MouseEvent, p: PillModel) => void;
  onHoverLane: (lane: number | null) => void;
  /** línea de conexión pill -> nodo */
  connect: boolean;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  if (pills.length === 0) return null;
  const first = pills[0];
  const rest = pills.slice(1);
  const custom = (p: PillModel) => branchColors[pillRefName(p)] ?? branchColors[p.label];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <BranchPill pill={first} lane={lane} custom={custom(first)} onContext={onContext} onHover={(on) => onHoverLane(on ? lane : null)} />
      {rest.length > 0 && (
        <span
          className="shrink-0 cursor-default rounded-[10px] bg-elev px-1.5 font-mono text-[10px] leading-4 text-gray-400 ring-1 ring-line"
          onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left, y: r.bottom + 4 }); }}
          onMouseLeave={() => setTip(null)}
        >
          +{rest.length}
        </span>
      )}
      {connect && <span className="h-px min-w-1 flex-1" style={{ background: laneColor(custom(first) ?? lane), opacity: 0.55 }} />}
      {tip && (
        <div className="pointer-events-none fixed z-[80] flex max-w-[280px] flex-col gap-1 rounded-md border border-line bg-elev p-2 shadow-pop" style={{ left: tip.x, top: tip.y }}>
          {pills.map((p) => <BranchPill key={p.key} pill={p} lane={lane} custom={custom(p)} />)}
        </div>
      )}
    </div>
  );
}
