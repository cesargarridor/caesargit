import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  children?: MenuItem[];
  hint?: string;
}

function List({ items, onClose, sub }: { items: MenuItem[]; onClose: () => void; sub?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className={`${sub ? "absolute left-full top-0 -mt-1 ml-0.5" : ""} min-w-[190px] rounded border border-line bg-elev py-1 text-xs shadow-pop animate-pop-in`}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <div key={i} className="relative" onMouseEnter={() => setOpen(it.children ? i : null)}>
            <button
              disabled={it.disabled}
              onClick={() => { if (it.children) { setOpen(i); return; } it.onClick?.(); onClose(); }}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-panel disabled:opacity-40 ${it.danger ? "text-git-deleted" : "text-gray-200 hover:text-amber"}`}
            >
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.hint && <span className="font-mono text-[10px] text-gray-500">{it.hint}</span>}
              {it.children && <ChevronRight size={12} className="text-gray-500" />}
            </button>
            {it.children && open === i && <List items={it.children} onClose={onClose} sub />}
          </div>
        ),
      )}
    </div>
  );
}

/** Menú contextual con submenús y separadores, anclado a coordenadas de pantalla. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} className="fixed z-[61]" style={{ left: pos.x, top: pos.y }}>
        <List items={items} onClose={onClose} />
      </div>
    </>
  );
}

/** Hook auxiliar: estado del menú + handler onContextMenu. */
export function useContextMenu<T>() {
  const [m, setM] = useState<{ x: number; y: number; data: T } | null>(null);
  return {
    menu: m,
    open: (e: React.MouseEvent, data: T) => { e.preventDefault(); e.stopPropagation(); setM({ x: e.clientX, y: e.clientY, data }); },
    close: () => setM(null),
  };
}
