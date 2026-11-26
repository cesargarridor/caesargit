import { DiffSkeleton } from "../layout/Visuals";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowRight, GripVertical, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { RebaseAction, RebaseTodoItem } from "../../types/git";

interface Props {
  baseSha: string;
  onClose?: () => void;
}

const ACTIONS: { v: RebaseAction; l: string; c: string; hint: string }[] = [
  { v: "pick", l: "Pick", c: "text-gray-200", hint: "Usar el commit tal cual" },
  { v: "reword", l: "Reword", c: "text-git-renamed", hint: "Cambiar el mensaje" },
  { v: "edit", l: "Edit", c: "text-amber", hint: "Pausar el rebase en este commit" },
  { v: "squash", l: "Squash", c: "text-git-added", hint: "Fusionar con el anterior y combinar mensajes" },
  { v: "fixup", l: "Fixup", c: "text-git-added", hint: "Fusionar con el anterior y descartar su mensaje" },
  { v: "drop", l: "Drop", c: "text-git-deleted", hint: "Eliminar el commit" },
];

interface Preview { subject: string; shas: string[]; flags: string[] }

/** Simula el resultado del rebase (de más antiguo a más nuevo). */
function simulate(items: RebaseTodoItem[]): Preview[] {
  const out: Preview[] = [];
  for (const it of items) {
    if (it.action === "drop") continue;
    if (it.action === "squash" || it.action === "fixup") {
      const prev = out[out.length - 1];
      if (!prev) continue;
      prev.shas.push(it.sha);
      prev.flags.push(it.action === "squash" ? "+squash" : "+fixup");
      continue;
    }
    const msg = it.action === "reword" ? (it.newMessage ?? it.subject).split("\n")[0] : it.subject;
    out.push({ subject: msg, shas: [it.sha], flags: it.action === "reword" ? ["reword"] : it.action === "edit" ? ["pausa (edit)"] : [] });
  }
  return out;
}

/** Vista grande (a pantalla completa) del rebase interactivo: lista arrastrable, acciones, mensaje en reword y vista previa. */
export default function InteractiveRebaseModal({ baseSha, onClose }: Props) {
  const run = useRepoStore((s) => s.run);
  const act = useRepoStore((s) => s.act);
  const setModal = useRepoStore((s) => s.setModal);
  const toast = useRepoStore((s) => s.toast);
  const close = onClose ?? (() => setModal(null));

  const [items, setItems] = useState<RebaseTodoItem[] | null>(null);
  const [orig, setOrig] = useState<string[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const [drop, setDrop] = useState<number | null>(null); // posición de inserción 0..n
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    run<RebaseTodoItem[]>("list_rebase_commits", { baseSha })
      .then((l) => { if (live) { setItems(l); setOrig(l.map((x) => x.sha)); } })
      .catch(() => live && close());
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSha, run]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useRepoStore.getState().dialog && !(e.target as HTMLElement | null)?.closest?.("textarea,input")) close();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (i: number, patch: Partial<RebaseTodoItem>) =>
    setItems((l) => l && l.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (from: number, to: number) =>
    setItems((l) => {
      if (!l || to < 0 || to >= l.length || from === to) return l;
      const c = [...l];
      const [x] = c.splice(from, 1);
      c.splice(to, 0, x);
      return c;
    });
  const setAction = (i: number, action: RebaseAction) =>
    update(i, { action, newMessage: action === "reword" ? items?.[i].newMessage ?? items?.[i].subject ?? "" : null });

  const kept = items?.filter((x) => x.action !== "drop") ?? [];
  const firstBad = kept.length > 0 && (kept[0].action === "squash" || kept[0].action === "fixup");
  const badReword = items?.some((x) => x.action === "reword" && !(x.newMessage ?? "").trim()) ?? false;
  const valid = !!items && items.length > 0 && kept.length > 0 && !firstBad && !badReword;
  const preview = useMemo(() => (items ? simulate(items) : []), [items]);
  const reordered = !!items && items.map((x) => x.sha).join() !== orig.join();
  const changed = !!items && (reordered || items.some((x) => x.action !== "pick"));

  const start = async () => {
    if (!items || !valid) return;
    setBusy(true);
    const r = await act("rebase_interactive", {
      baseSha,
      items: items.map((x) => ({ ...x, newMessage: x.action === "reword" ? x.newMessage : null })),
    });
    setBusy(false);
    if (r !== undefined) { toast("Rebase interactivo completado", "info"); close(); }
  };

  const onDragOver = (e: React.DragEvent, i: number) => {
    if (drag === null) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrop(e.clientY < r.top + r.height / 2 ? i : i + 1);
  };
  const onDrop = () => {
    if (drag !== null && drop !== null) {
      const to = drop > drag ? drop - 1 : drop;
      move(drag, to);
    }
    setDrag(null); setDrop(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app animate-fade-in">
      <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-3">
        <span className="font-semibold text-amber">Interactive Rebase</span>
        <span className="flex-1 font-mono text-xs text-gray-500">sobre {baseSha.slice(0, 7)} · el primero se aplica antes (arriba = más antiguo)</span>
        <button onClick={close} className="text-gray-400 hover:text-amber" title="Cerrar (Esc)"><X size={16} /></button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto" onDragLeave={(e) => { if (e.currentTarget === e.target) setDrop(null); }}>
          {items === null && <DiffSkeleton />}
          {items?.length === 0 && <div className="p-6 text-sm text-gray-500">No hay commits que reordenar.</div>}
          {items?.map((it, i) => (
            <div
              key={it.sha}
              onDragOver={(e) => onDragOver(e, i)}
              onDrop={onDrop}
              className={`relative border-b border-line/50 px-3 py-2 ${drag === i ? "opacity-40" : ""} ${it.action === "drop" ? "opacity-50" : ""}`}
            >
              {drop === i && drag !== null && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-amber" />}
              {drop === items.length && i === items.length - 1 && drag !== null && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-amber" />}
              <div className="flex items-center gap-2 text-xs">
                <span
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.sha); setDrag(i); }}
                  onDragEnd={() => { setDrag(null); setDrop(null); }}
                  title="Arrastra para reordenar"
                  className="cursor-grab text-gray-500 hover:text-amber active:cursor-grabbing"
                >
                  <GripVertical size={16} />
                </span>
                <select
                  value={it.action}
                  onChange={(e) => setAction(i, e.target.value as RebaseAction)}
                  title={ACTIONS.find((a) => a.v === it.action)?.hint}
                  className={`w-24 rounded border border-line bg-app px-1 py-1 ${ACTIONS.find((a) => a.v === it.action)?.c ?? ""}`}
                >
                  {ACTIONS.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}
                </select>
                <span className="font-mono text-amber">{it.sha.slice(0, 7)}</span>
                <span className={`min-w-0 flex-1 truncate text-[13px] ${it.action === "drop" ? "line-through" : ""}`}>{it.subject}</span>
                <button title="Subir" disabled={i === 0} onClick={() => move(i, i - 1)} className="text-gray-400 hover:text-amber disabled:opacity-30"><ArrowUp size={14} /></button>
                <button title="Bajar" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} className="text-gray-400 hover:text-amber disabled:opacity-30"><ArrowDown size={14} /></button>
              </div>
              {it.action === "reword" && (
                <textarea
                  value={it.newMessage ?? it.subject}
                  onChange={(e) => update(i, { newMessage: e.target.value })}
                  rows={3}
                  placeholder="Nuevo mensaje del commit"
                  className="mt-2 w-full resize-y rounded border border-line bg-app px-2 py-1 text-xs text-gray-100 outline-none focus:border-amber"
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex w-[340px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-gray-400">
            <span>Vista previa</span>
            <span className="flex-1" />
            {items && <span className="font-normal text-gray-500">{items.length} <ArrowRight size={10} className="inline" /> {preview.length} commits</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {preview.length === 0 && <div className="p-3 text-xs text-gray-500">Sin commits resultantes.</div>}
            {[...preview].reverse().map((p, i) => (
              <div key={p.shas[0]} className="flex gap-2 border-b border-line/40 px-3 py-1.5 text-xs">
                <div className="flex flex-col items-center pt-1">
                  <span className="h-2 w-2 rounded-full bg-amber" />
                  {i < preview.length - 1 && <span className="mt-0.5 w-px flex-1 bg-line" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-gray-200" title={p.subject}>{p.subject}</div>
                  <div className="truncate font-mono text-[10px] text-gray-500">
                    {p.shas.map((s) => s.slice(0, 7)).join(" + ")}{p.flags.length ? ` · ${p.flags.join(" ")}` : ""}
                  </div>
                </div>
              </div>
            ))}
            <div className="px-3 py-2 text-[10px] text-gray-500">↑ más nuevo · base {baseSha.slice(0, 7)} ↓</div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <span className="flex-1 text-xs text-git-deleted">
          {firstBad ? "El primer commit no puede ser Squash/Fixup." : badReword ? "Reword necesita un mensaje." : kept.length === 0 && items?.length ? "No puedes descartar todos los commits." : ""}
        </span>
        {!changed && items && items.length > 0 && <span className="text-xs text-gray-500">Sin cambios sobre el orden/acciones originales</span>}
        <button onClick={close} className="rounded border border-line px-3 py-1 text-xs text-gray-300 hover:text-amber">Cancelar</button>
        <button onClick={() => void start()} disabled={!valid || busy} className="rounded bg-amber px-5 py-1.5 text-xs font-semibold text-onacc hover:bg-amber-hover disabled:opacity-40">
          Start Rebase
        </button>
      </div>
    </div>
  );
}
