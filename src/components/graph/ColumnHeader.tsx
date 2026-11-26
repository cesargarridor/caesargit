import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { GraphColumn, GraphColumnId } from "../../types/git";
import { COLUMN_LABEL, COLUMN_MIN } from "../../store/useGraphPrefs";
import { ContextMenu, type CtxItem } from "../layout/Sidebar";
import { DEFAULT_COLUMNS } from "../../store/usePrefs";

/** Estilo de celda compartido entre cabecera y filas (el mensaje absorbe el espacio sobrante). */
export const colStyle = (c: GraphColumn): React.CSSProperties =>
  c.id === "message" ? { flex: `1 1 ${c.width}px`, minWidth: c.width } : { flex: `0 0 ${c.width}px`, width: c.width };

interface Props {
  columns: GraphColumn[];
  onChange: (cols: GraphColumn[]) => void;
}

export function ColumnHeader({ columns, onChange }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: GraphColumnId; over: number } | null>(null);
  const cellRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const visible = columns.filter((c) => c.visible);

  const toggle = (id: GraphColumnId) => onChange(columns.map((c) => (c.id === id && id !== "graph" ? { ...c, visible: !c.visible } : c)));
  const menuItems = (): CtxItem[] => [
    ...columns.map((c) => ({
      label: `${c.visible ? "✓" : " "} ${COLUMN_LABEL[c.id]}`, disabled: c.id === "graph", onClick: () => toggle(c.id),
    })),
    { sep: true },
    { label: "Restablecer columnas", onClick: () => onChange(DEFAULT_COLUMNS.map((c) => ({ ...c }))) },
  ];

  const startResize = (e: React.PointerEvent, col: GraphColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = col.width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(COLUMN_MIN[col.id], Math.round(startW + ev.clientX - startX));
      onChange(columns.map((c) => (c.id === col.id ? { ...c, width: w } : c)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startReorder = (e: React.PointerEvent, col: GraphColumn) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    let active = false;
    let over = visible.findIndex((c) => c.id === col.id);
    const overAt = (x: number) => {
      let idx = visible.length - 1;
      for (let i = 0; i < visible.length; i++) {
        const r = cellRefs.current[visible[i].id]?.getBoundingClientRect();
        if (r && x < r.left + r.width / 2) { idx = i; break; }
      }
      return idx;
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - sx) > 6) active = true;
      if (active) { over = overAt(ev.clientX); setDrag({ id: col.id, over }); }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!active) return;
      const from = visible.findIndex((c) => c.id === col.id);
      if (from === over) return;
      const order = visible.map((c) => c.id);
      order.splice(from, 1);
      order.splice(over, 0, col.id);
      const hidden = columns.filter((c) => !c.visible);
      onChange([...order.map((id) => columns.find((c) => c.id === id)!), ...hidden]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="sticky top-0 z-20 flex h-6 select-none items-stretch border-b border-line bg-panel text-[10px] font-semibold tracking-wide text-gray-500"
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {visible.map((c, i) => (
        <div
          key={c.id} ref={(el) => { cellRefs.current[c.id] = el; }} style={colStyle(c)}
          className={`relative flex items-center overflow-hidden px-2 ${drag?.id === c.id ? "opacity-40" : ""} ${drag && drag.over === i && drag.id !== c.id ? "shadow-[inset_2px_0_0_rgb(var(--c-accent))]" : ""}`}
        >
          <span className="cursor-grab truncate active:cursor-grabbing" onPointerDown={(e) => startReorder(e, c)}>{COLUMN_LABEL[c.id]}</span>
          <span
            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-amber/50"
            onPointerDown={(e) => startResize(e, c)}
          />
        </div>
      ))}
      <button
        className="sticky right-0 flex w-7 shrink-0 items-center justify-center bg-panel text-gray-500 hover:text-amber"
        title="Columnas" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left - 180, y: r.bottom }); }}
      >
        <Settings2 size={12} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  );
}
