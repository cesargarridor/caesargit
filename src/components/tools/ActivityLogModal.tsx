import { useMemo, useState } from "react";
import { Copy, RefreshCw, ScrollText } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Check, Empty, ErrorBox, Modal, Select, Spinner, inputCls, rd, useLoad } from "./ui";
import type { ActivityEntry, ToolProps } from "./types";

export default function ActivityLogModal({ onClose }: ToolProps) {
  const { data, loading, error, reload } = useLoad<ActivityEntry[]>(() => rd("get_activity_log", { limit: 500 }), []);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [onlyErr, setOnlyErr] = useState(false);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter((e) => (!kind || e.kind === kind) && (!onlyErr || !e.ok) && (!t || `${e.command} ${e.repo}`.toLowerCase().includes(t)));
  }, [data, q, kind, onlyErr]);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    useRepoStore.getState().toast("Copiado", "info");
  };

  return (
    <Modal title="Registro de actividad" icon={<ScrollText size={15} />} onClose={onClose} width={900}>
      <div className="flex items-center gap-3">
        <input autoFocus className={inputCls} placeholder="Filtrar comandos o repositorio…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="w-36 shrink-0"><Select value={kind} onChange={setKind} options={[{ value: "", label: "Lecturas y escrituras" }, { value: "write", label: "Solo escrituras" }, { value: "read", label: "Solo lecturas" }]} /></div>
        <div className="shrink-0"><Check checked={onlyErr} onChange={setOnlyErr}>Solo errores</Check></div>
        <Btn small onClick={reload} title="Recargar"><RefreshCw size={11} /></Btn>
        <Btn small onClick={() => copy(rows.map((e) => e.command).join("\n"))} disabled={rows.length === 0}><Copy size={11} /> Copiar todo</Btn>
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && rows.length === 0 && <Empty>Sin entradas.</Empty>}
      <div className="max-h-[58vh] overflow-auto rounded-md border border-line">
        {rows.map((e) => (
          <div key={e.id} className="group flex items-start gap-3 border-b border-line/60 px-3 py-1.5 last:border-0 hover:bg-line/40">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${e.ok ? "bg-git-added" : "bg-git-deleted"}`} title={e.ok ? "OK" : "Error"} />
            <span className="w-16 shrink-0 font-mono text-[10px] text-gray-500">{new Date(e.timestampMs).toLocaleTimeString()}</span>
            <span className={`w-12 shrink-0 rounded px-1 text-center text-[10px] ${e.kind === "write" ? "bg-amber/15 text-amber" : "bg-line text-gray-400"}`}>{e.kind === "write" ? "escribe" : "lee"}</span>
            <div className="min-w-0 flex-1">
              <div className="break-all font-mono text-[11px] text-gray-200">{e.command}</div>
              {e.error && <div className="mt-0.5 text-[11px] text-git-deleted">{e.error}</div>}
            </div>
            <span className="w-20 shrink-0 truncate text-right text-[10px] text-gray-500" title={e.repo}>{e.repo}</span>
            <span className="w-14 shrink-0 text-right font-mono text-[10px] text-gray-400">{e.durationMs} ms</span>
            <button onClick={() => copy(e.command)} className="shrink-0 text-gray-600 opacity-0 transition hover:text-amber group-hover:opacity-100" title="Copiar comando"><Copy size={12} /></button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
