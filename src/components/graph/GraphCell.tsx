import { memo } from "react";
import { laneVar, cv } from "../../lib/themes";
import type { GraphRow, GraphSegment } from "../../types/git";

export const LANE_W = 16;
export const ROW_H = 30;
export const laneColor = laneVar;
export const laneX = (col: number) => LANE_W / 2 + col * LANE_W;

function segmentPath(s: GraphSegment): string {
  const mid = ROW_H / 2;
  const fx = laneX(s.fromCol);
  const tx = laneX(s.toCol);
  switch (s.kind) {
    case "pass": // atraviesa la fila entera
      return fx === tx ? `M${fx} 0V${ROW_H}` : `M${fx} 0C${fx} ${mid} ${tx} ${mid} ${tx} ${ROW_H}`;
    case "up": // desde arriba hasta el nodo
      return fx === tx ? `M${fx} 0V${mid}` : `M${fx} 0C${fx} ${mid / 2} ${tx} ${mid / 2} ${tx} ${mid}`;
    case "merge": // carril que converge al commit desde arriba
      return `M${fx} 0C${fx} ${mid} ${tx} ${mid * 0.6} ${tx} ${mid}`;
    case "down": // desde el nodo hacia abajo (padre)
      return fx === tx ? `M${fx} ${mid}V${ROW_H}` : `M${fx} ${mid}C${fx} ${mid * 1.5} ${tx} ${mid * 1.5} ${tx} ${ROW_H}`;
    case "branch": // desde el nodo a un carril nuevo (padre extra)
      return `M${fx} ${mid}C${fx} ${mid * 1.4} ${tx} ${mid * 1.2} ${tx} ${ROW_H}`;
  }
}

interface Props { row: GraphRow; width: number; selected: boolean }

export const GraphCell = memo(function GraphCell({ row, width, selected }: Props) {
  const cx = laneX(row.column);
  const cy = ROW_H / 2;
  const color = laneColor(row.colorIdx);
  const isHead = row.commit.refs.some((r) => r.kind === "head");
  const hasTag = row.commit.refs.some((r) => r.kind === "tag");

  return (
    <svg width={width} height={ROW_H} className="shrink-0" style={{ overflow: "visible" }}>
      {row.lanes.map((s, i) => (
        <path
          key={i} d={segmentPath(s)} fill="none" style={{ stroke: laneColor(s.colorIdx) }} strokeWidth={2} strokeLinecap="round"
          strokeDasharray={row.isWip ? "3 3" : undefined} className={row.isWip ? "wip-pulse" : undefined}
        />
      ))}
      {row.isWip ? (
        <circle cx={cx} cy={cy} r={5} className="wip-pulse" style={{ fill: cv("app"), stroke: cv("accent") }} strokeWidth={2} strokeDasharray="3 2" />
      ) : (
        <>
          {isHead && <circle cx={cx} cy={cy} r={9} fill="none" className="head-glow" style={{ stroke: cv("accent") }} strokeWidth={1.5} />}
          {selected && !isHead && <circle cx={cx} cy={cy} r={9} fill="none" style={{ stroke: color }} strokeOpacity={0.5} strokeWidth={1.5} />}
          {hasTag ? (
            <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} style={{ fill: color, stroke: cv("app") }} strokeWidth={1.5} />
          ) : (
            <circle cx={cx} cy={cy} r={5.5} className={isHead ? "head-glow" : undefined} style={{ fill: row.isMerge ? cv("app") : color, stroke: color }} strokeWidth={2} />
          )}
          {row.isMerge && !hasTag && <circle cx={cx} cy={cy} r={2} style={{ fill: color }} />}
        </>
      )}
    </svg>
  );
});
