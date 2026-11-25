import { DiffSkeleton } from "../layout/Visuals";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { RebaseAction, RebaseTodoItem } from "../../types/git";

interface Props {
  baseSha: string;
  onClose?: () => void;
}

const ACTIONS: { v: RebaseAction; l: string; c: string }[] = [
  { v: "pick", l: "Pick", c: "text-gray-200" },
  { v: "reword", l: "Reword", c: "text-git-renamed" },
  { v: "edit", l: "Edit", c: "text-amber" },
  { v: "squash", l: "Squash", c: "text-git-added" },
  { v: "fixup", l: "Fixup", c: "text-git-added" },
  { v: "drop", l: "Drop", c: "text-git-deleted" },
];

export default function InteractiveRebaseModal({ baseSha, onClose }: Props) {
  const run = useRepoStore((s) => s.run);
  const act = useRepoStore((s) => s.act);
  const setModal = useRepoStore((s) => s.setModal);
  const toast = useRepoStore((s) => s.toast);
  const close = onClose ?? (() => setModal(null));

  const [items, setItems] = useState<RebaseTodoItem[] | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    run<RebaseTodoItem[]>("list_rebase_commits", { baseSha })
      .then((l) => live && setItems(l))
      .catch(() => live && close());
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSha, run]);

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

  const kept = items?.filter((x) => x.action !== "drop") ?? [];
  const firstBad = kept.length > 0 && (kept[0].action === "squash" || kept[0].action === "fixup");
  const badReword = items?.some((x) => x.action === "reword" && !(x.newMessage ?? "").trim()) ?? false;
  const valid = !!items && items.length > 0 && kept.length > 0 && !firstBad && !badReword;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 animate-fade-in" onMouseDown={close}>
      <div className="flex max-h-[85vh] w-[720px] max-w-[94vw] flex-col rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="font-semibold text-amber">Interactive Rebase</span>
          <span className="flex-1 font-mono text-xs text-gray-500">sobre {baseSha.slice(0, 7)} · el primero se aplica antes</span>
          <button onClick={close} className="text-gray-400 hover:text-amber"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items === null && <DiffSkeleton />}
          {items?.length === 0 && <div className="p-4 text-xs text-gray-500">No hay commits que reordenar.</div>}
          {items?.map((it, i) => (
            <div
              key={it.sha}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}
              className={`border-b border-line/50 px-3 py-1.5 ${over === i && drag !== null && drag !== i ? "bg-amber/10" : ""} ${it.action === "drop" ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <GripVertical size={14} className="shrink-0 cursor-grab text-gray-600" />
                <select
                  value={it.action}
                  onChange={(e) => update(i, { action: e.target.value as RebaseAction })}
                  className={`rounded border border-line bg-app px-1 py-0.5 ${ACTIONS.find((a) => a.v === it.action)?.c ?? ""}`}
                >
                  {ACTIONS.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}
                </select>
                <span className="font-mono text-amber">{it.sha.slice(0, 7)}</span>
                <span className={`min-w-0 flex-1 truncate ${it.action === "drop" ? "line-through" : ""}`}>{it.subject}</span>
                <button title="Subir" disabled={i === 0} onClick={() => move(i, i - 1)} className="text-gray-400 hover:text-amber disabled:opacity-30"><ArrowUp size={13} /></button>
                <button title="Bajar" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} className="text-gray-400 hover:text-amber disabled:opacity-30"><ArrowDown size={13} /></button>
              </div>
              {it.action === "reword" && (
                <textarea
                  value={it.newMessage ?? it.subject}
                  onChange={(e) => update(i, { newMessage: e.target.value })}
                  onFocus={() => it.newMessage === null && update(i, { newMessage: it.subject })}
                  rows={2}
                  placeholder="Nuevo mensaje"
                  className="mt-1 w-full resize-none rounded border border-line bg-app px-2 py-1 text-xs text-gray-100 outline-none focus:border-amber"
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="flex-1 text-xs text-git-deleted">
            {firstBad ? "El primer commit no puede ser Squash/Fixup." : badReword ? "Reword necesita un mensaje." : ""}
          </span>
          <button onClick={close} className="rounded border border-line px-3 py-1 text-xs text-gray-300 hover:text-amber">Cancelar</button>
          <button onClick={() => void start()} disabled={!valid || busy} className="rounded bg-amber px-4 py-1 text-xs font-semibold text-onacc hover:bg-amber-hover disabled:opacity-40">
            Start Rebase
          </button>
        </div>
      </div>
    </div>
  );
}
