import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";

export interface CtxItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  /** marca de check a la izquierda */
  checked?: boolean;
  /** color CSS de muestra (por ejemplo laneVar(i)) */
  swatch?: string;
  /** atajo mostrado a la derecha */
  hint?: string;
  /** submenú */
  children?: CtxItem[];
}

function Items(props: { items: CtxItem[]; onClose: () => void; sub?: boolean }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {props.items.map((it, i) =>
        it.sep ? <div key={i} className="my-1 h-px bg-line" /> : (
          <div key={i} className="relative" onMouseEnter={() => setOpenSub(it.children ? i : null)}>
            <button disabled={it.disabled}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber/15 disabled:opacity-40 disabled:hover:bg-transparent ${it.danger ? "text-git-deleted" : "text-gray-200"}`}
              onClick={() => { if (it.children) { setOpenSub(i); return; } props.onClose(); it.onClick?.(); }}>
              <span className="flex w-3 shrink-0 justify-center">{it.checked && <Check size={11} />}</span>
              {it.swatch && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: it.swatch }} />}
              <span className="flex-1 truncate">{it.label}</span>
              {it.hint && <span className="font-mono text-[10px] text-gray-500">{it.hint}</span>}
              {it.children && <ChevronRight size={11} className="text-gray-500" />}
            </button>
            {it.children && openSub === i && (
              <div className="absolute left-full top-0 z-10 -ml-0.5 min-w-[190px] rounded-md border border-line bg-elev py-1 text-xs shadow-2xl">
                <Items items={it.children} onClose={props.onClose} sub />
              </div>
            )}
          </div>
        ))}
    </>
  );
}

/** Menú contextual genérico con separadores, checks, muestras de color y submenús. */
export function ContextMenu(props: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 8)), y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 8)) });
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
      className="fixed z-50 min-w-[220px] rounded-md border border-line bg-elev py-1 text-xs shadow-2xl animate-pop-in"
      onContextMenu={(e) => e.preventDefault()}>
      <Items items={props.items} onClose={props.onClose} />
    </div>
  );
}

/** Popover pequeño anclado a un punto (para DnD: Merge/Rebase/Fast-forward, Push/Force). */
export function PointPopover(props: { x: number; y: number; title?: string; items: CtxItem[]; onClose: () => void }) {
  return (
    <div>
      <ContextMenu x={props.x} y={props.y} items={props.title ? [{ label: props.title, disabled: true }, { sep: true }, ...props.items] : props.items} onClose={props.onClose} />
    </div>
  );
}
