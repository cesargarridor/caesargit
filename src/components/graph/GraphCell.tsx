import { memo } from "react";
import { laneVar, cv } from "../../lib/themes";
import { initials } from "../layout/Visuals";
import type { GraphRow, GraphSegment } from "../../types/git";

export const LANE_W = 18;
export const ROW_H = 28;
const NODE_R = 8;
export const laneColor = laneVar;
export const laneX = (col: number) => LANE_W / 2 + col * LANE_W;

/** Remapa un carril a otro (color personalizado por rama). */
export type LaneMap = Record<number, number>;
const mapLane = (m: LaneMap | undefined, i: number) => (m && m[i] !== undefined ? m[i] : i);

function segmentPath(s: GraphSegment): string {
  const mid = ROW_H / 2;
  const fx = laneX(s.fromCol);
  const tx = laneX(s.toCol);
  switch (s.kind) {
    case "pass":
      return fx === tx ? `M${fx} 0V${ROW_H}` : `M${fx} 0C${fx} ${mid} ${tx} ${mid} ${tx} ${ROW_H}`;
    case "up":
      return fx === tx ? `M${fx} 0V${mid}` : `M${fx} 0C${fx} ${mid / 2} ${tx} ${mid / 2} ${tx} ${mid}`;
    case "merge":
      return `M${fx} 0C${fx} ${mid} ${tx} ${mid * 0.6} ${tx} ${mid}`;
    case "down":
      return fx === tx ? `M${fx} ${mid}V${ROW_H}` : `M${fx} ${mid}C${fx} ${mid * 1.5} ${tx} ${mid * 1.5} ${tx} ${ROW_H}`;
    case "branch":
      return `M${fx} ${mid}C${fx} ${mid * 1.4} ${tx} ${mid * 1.2} ${tx} ${ROW_H}`;
  }
}

interface Props {
  row: GraphRow;
  width: number;
  selected: boolean;
  /** carril resaltado por hover (el resto se atenúa); null = nada */
  hoverLane: number | null;
  laneMap?: LaneMap;
  /** dibuja una línea desde el borde izquierdo hasta el nodo (conexión desde la pill) */
  connect: boolean;
  onHoverLane: (lane: number | null) => void;
}

const isKind = (row: GraphRow, k: string) => row.commit.refs.some((r) => (r.kind as string) === k);

export const GraphCell = memo(function GraphCell({ row, width, selected, hoverLane, laneMap, connect, onHoverLane }: Props) {
  const cx = laneX(row.column);
  const cy = ROW_H / 2;
  const lane = mapLane(laneMap, row.colorIdx);
  const color = laneColor(lane);
  const isHead = isKind(row, "head");
  const isStash = isKind(row, "stash");
  const dimSeg = (i: number) => (hoverLane !== null && i !== hoverLane ? 0.3 : 1);
  const showAvatar = !row.isWip && !row.isMerge && !isStash;

  return (
    <svg
      width={width} height={ROW_H} className="shrink-0" style={{ overflow: "visible" }}
      onMouseEnter={() => onHoverLane(row.colorIdx)} onMouseLeave={() => onHoverLane(null)}
    >
      {connect && !row.isWip && (
        <line x1={0} x2={cx} y1={cy} y2={cy} strokeWidth={1} strokeOpacity={0.55 * dimSeg(row.colorIdx)} style={{ stroke: color }} />
      )}
      {row.lanes.map((s, i) => (
        <path
          key={i} d={segmentPath(s)} fill="none" style={{ stroke: laneColor(mapLane(laneMap, s.colorIdx)) }} strokeWidth={2} strokeLinecap="round"
          strokeOpacity={dimSeg(s.colorIdx)}
          strokeDasharray={row.isWip ? "3 3" : undefined} className={row.isWip ? "wip-pulse" : undefined}
        />
      ))}
      {selected && !row.isWip && (
        <circle cx={cx} cy={cy} r={NODE_R + 3.5} fill="none" strokeDasharray="2 2.5" strokeWidth={1.25} strokeOpacity={0.75} style={{ stroke: color }} />
      )}
      <g opacity={dimSeg(row.colorIdx)}>
        {row.isWip ? (
          <circle cx={cx} cy={cy} r={NODE_R - 1} className="wip-pulse" style={{ fill: cv("app"), stroke: cv("accent") }} strokeWidth={2} strokeDasharray="3 2" />
        ) : isStash ? (
          <g>
            <rect x={cx - 7} y={cy - 6} width={14} height={12} rx={3} strokeWidth={1.75} strokeDasharray="3 1.5" style={{ fill: cv("elev"), stroke: color }} />
            <path d={`M${cx - 4} ${cy - 1.5}H${cx + 4}`} strokeWidth={1.5} strokeLinecap="round" fill="none" style={{ stroke: color }} />
          </g>
        ) : (
          <>
            {isHead && <circle cx={cx} cy={cy} r={NODE_R + 3} fill="none" className="head-glow" style={{ stroke: cv("accent") }} strokeWidth={1.75} />}
            <circle
              cx={cx} cy={cy} r={NODE_R} className={isHead ? "head-glow" : undefined} strokeWidth={2}
              style={{ fill: row.isMerge ? cv("app") : color, stroke: color }}
            />
            {row.isMerge ? (
              <g transform={`translate(${cx - 5.5} ${cy - 5.5}) scale(0.46)`} fill="none" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: color }}>
                <circle cx={18} cy={18} r={3} />
                <circle cx={6} cy={6} r={3} />
                <path d="M6 21V9a9 9 0 0 0 9 9" />
              </g>
            ) : showAvatar ? (
              <text
                x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={7.5} fontWeight={700}
                style={{ fill: cv("app"), pointerEvents: "none", userSelect: "none" }}
              >
                {initials(row.commit.authorName).slice(0, 2)}
              </text>
            ) : null}
          </>
        )}
      </g>
    </svg>
  );
});
