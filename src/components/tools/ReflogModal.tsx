import { useMemo, useState } from "react";
import { GitBranchPlus, History, RotateCcw } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Empty, ErrorBox, Modal, Select, Spinner, inputCls, rd, shortSha, useLoad, useRepoPath } from "./ui";
import type { ReflogEntry, ToolProps } from "./types";

type Mode = "soft" | "mixed" | "hard";
const MODE_DESC: Record<Mode, string> = {
  soft: "Mueve HEAD y conserva índice y archivos.",
  mixed: "Mueve HEAD y reinicia el índice; conserva los archivos.",
  hard: "Mueve HEAD y DESCARTA índice y cambios del working tree.",
};

export default function ReflogModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const { data, loading, error, reload } = useLoad<ReflogEntry[]>(() => rd("get_reflog", { repoPath, limit: 500 }), [repoPath]);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [mode, setMode] = useState<Mode>("mixed");
  const [open, setOpen] = useState<string | null>(null);

  const actions = useMemo(() => [...new Set((data ?? []).map((e) => e.action))].sort(), [data]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter((e) =>
      (!action || e.action === action) && (!t || `${e.sha} ${e.message} ${e.selector}`.toLowerCase().includes(t)));
  }, [data, q, action]);

  const reset = async (e: ReflogEntry) => {
    const st = useRepoStore.getState();
    const ok = await st.confirm({
      title: `Reset ${mode} a ${shortSha(e.sha)}`, message: `${e.message}\n\n${MODE_DESC[mode]}`,
      confirmLabel: `Reset ${mode}`, danger: mode === "hard",
    });
    if (ok && (await st.act("reset_to", { sha: e.sha, mode })) !== undefined) { st.toast("Reset completado", "info"); reload(); }
  };
  const checkout = async (e: ReflogEntry) => {
    const st = useRepoStore.getState();
    if ((await st.act("checkout", { target: e.sha, create: false })) !== undefined) reload();
  };
  const branch = async (e: ReflogEntry) => {
    const st = useRepoStore.getState();
    const r = await st.ask({ title: `Crear rama en ${shortSha(e.sha)}`, fields: [{ key: "name", label: "Nombre de la rama", placeholder: "rescate" }], confirmLabel: "Crear" });
    if (r?.name?.trim()) await st.act("create_branch", { name: r.name.trim(), startPoint: e.sha, checkout: true });
  };

  return (
    <Modal title="Reflog" icon={<History size={15} />} onClose={onClose} width={820}>
      <div className="flex items-center gap-2">
        <input className={inputCls} placeholder="Filtrar por mensaje, sha o selector…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="w-44 shrink-0"><Select value={action} onChange={setAction} options={[{ value: "", label: "Todas las acciones" }, ...actions.map((a) => ({ value: a, label: a }))]} /></div>
        <div className="w-32 shrink-0"><Select value={mode} onChange={(v) => setMode(v as Mode)} options={[
          { value: "soft", label: "Reset soft" }, { value: "mixed", label: "Reset mixed" }, { value: "hard", label: "Reset hard" }]} /></div>
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && rows.length === 0 && <Empty>Sin entradas.</Empty>}
      <div className="max-h-[56vh] overflow-auto rounded-md border border-line">
        {rows.map((e) => (
          <div key={e.selector} className="border-b border-line/60 last:border-0">
            <button onClick={() => setOpen(open === e.selector ? null : e.selector)}
              className={`flex w-full items-center gap-3 px-3 py-1.5 text-left transition hover:bg-line/50 ${open === e.selector ? "bg-amber/10" : ""}`}>
              <span className="w-24 shrink-0 font-mono text-[11px] text-amber">{e.selector}</span>
              <span className="w-16 shrink-0 font-mono text-[11px] text-gray-400">{shortSha(e.sha)}</span>
              <span className="w-20 shrink-0 truncate rounded bg-line px-1.5 text-center text-[10px] text-gray-300">{e.action}</span>
              <span className="min-w-0 flex-1 truncate text-gray-200">{e.message}</span>
              <span className="shrink-0 text-[10px] text-gray-500">{new Date(e.date).toLocaleString()}</span>
            </button>
            {open === e.selector && (
              <div className="flex flex-wrap items-center gap-2 bg-panel px-3 py-2 animate-fade-in">
                <Btn small variant={mode === "hard" ? "danger" : "ghost"} onClick={() => reset(e)}><RotateCcw size={11} /> Reset to this ({mode})</Btn>
                <Btn small onClick={() => checkout(e)}>Checkout</Btn>
                <Btn small onClick={() => branch(e)}><GitBranchPlus size={11} /> Create branch here</Btn>
                <span className="ml-auto text-[11px] text-gray-500">{MODE_DESC[mode]}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
