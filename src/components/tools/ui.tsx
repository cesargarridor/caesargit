import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useRepoStore } from "../../store/useRepoStore";

/** Ruta del repo activo (o null). */
export function useRepoPath(): string | null {
  return useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.info.path ?? null);
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function Modal({
  title, icon, onClose, children, footer, width = 560, z = 50,
}: {
  title: string; icon?: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; width?: number; z?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-scrim/60 animate-fade-in" style={{ zIndex: z }} onMouseDown={() => onClose?.()}>
      <div className="flex max-h-[86vh] max-w-[94vw] flex-col rounded-lg border border-line bg-elev shadow-pop animate-pop-in"
        style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          {icon && <span className="text-amber">{icon}</span>}
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          <button onClick={() => onClose?.()} className="ml-auto text-gray-400 transition hover:text-amber" aria-label="Cerrar"><X size={15} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-xs text-gray-300">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export const inputCls =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-xs text-gray-100 outline-none transition placeholder:text-gray-500 focus:border-amber/70 focus:shadow-glow disabled:opacity-50";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 text-xs text-gray-300 ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" className="accent-amber" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

type Variant = "primary" | "ghost" | "danger";
export function Btn({
  children, onClick, variant = "ghost", disabled, busy, title, small,
}: {
  children: ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean; busy?: boolean; title?: string; small?: boolean;
}) {
  const v =
    variant === "primary" ? "bg-amber font-semibold text-onacc hover:bg-amber-hover"
    : variant === "danger" ? "bg-git-deleted font-semibold text-onacc hover:opacity-90"
    : "border border-line text-gray-200 hover:bg-line";
  return (
    <button title={title} disabled={disabled || busy} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md transition active:scale-[.97] disabled:opacity-40 ${small ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs"} ${v}`}>
      {busy && <Loader2 size={12} className="animate-spin" />}
      {children}
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{children}</h3>;
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center gap-2 py-6 text-gray-500"><Loader2 size={14} className="animate-spin" />{label ?? "Cargando…"}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-gray-500">{children}</div>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-git-deleted/40 bg-git-deleted/10 px-3 py-2 text-git-deleted">{children}</div>;
}

export function Select({ value, onChange, options, disabled }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean;
}) {
  return (
    <select className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * Carga de datos de un comando de lectura con recarga manual.
 * Los errores se muestran en `error` (no en toast).
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null; loading: boolean; error: string | null; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    setLoading(true);
    fnRef.current().then(
      (d) => { if (live) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (live) { setError(errMsg(e)); setLoading(false); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, loading, error, reload: () => setN((x) => x + 1) };
}

export const shortSha = (s: string) => s.slice(0, 7);

/** Lectura directa (sin busy/refresh ni toast): para comandos que no modifican el repo. */
export function rd<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(cmd, args);
}
