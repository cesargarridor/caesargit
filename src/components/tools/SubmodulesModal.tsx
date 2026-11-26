import { useState } from "react";
import { ExternalLink, Package, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Check, Empty, ErrorBox, Field, Modal, SectionTitle, Spinner, inputCls, rd, shortSha, useLoad, useRepoPath } from "./ui";
import type { Submodule, ToolProps } from "./types";

const STATUS: Record<Submodule["status"], { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-git-added/15 text-git-added" },
  uninitialized: { label: "Sin inicializar", cls: "bg-line text-gray-400" },
  modified: { label: "Modificado", cls: "bg-git-modified/15 text-git-modified" },
  conflict: { label: "Conflicto", cls: "bg-git-conflict/15 text-git-conflict" },
};

export default function SubmodulesModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const { data, loading, error, reload } = useLoad<Submodule[]>(() => rd("list_submodules", { repoPath }), [repoPath]);
  const [recursive, setRecursive] = useState(true);
  const [remote, setRemote] = useState(false);
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const doit = async (key: string, cmd: string, args: Record<string, unknown>) => {
    setBusy(key);
    await useRepoStore.getState().act(cmd, args);
    setBusy(null);
    reload();
  };
  const add = async () => {
    setBusy("add");
    const ok = await useRepoStore.getState().act("submodule_add", { url: url.trim(), path: path.trim(), branch: branch.trim() || null });
    setBusy(null);
    if (ok !== undefined) { setUrl(""); setPath(""); setBranch(""); }
    reload();
  };
  const remove = async (s: Submodule) => {
    const st = useRepoStore.getState();
    if (!(await st.confirm({ title: `Eliminar submódulo «${s.name}»`, message: "Se desinicializa, se borra su carpeta y se limpia .gitmodules.", confirmLabel: "Eliminar", danger: true }))) return;
    await doit(`rm:${s.path}`, "submodule_remove", { path: s.path });
  };
  const openSub = (s: Submodule) => {
    const base = repoPath ?? "";
    const sep = base.includes("\\") ? "\\" : "/";
    void useRepoStore.getState().openRepo(`${base.replace(/[/\\]+$/, "")}${sep}${s.path}`);
    onClose?.();
  };

  return (
    <Modal title="Submódulos" icon={<Package size={15} />} onClose={onClose} width={720}>
      <div className="flex flex-wrap items-center gap-3">
        <Check checked={recursive} onChange={setRecursive}>Recursive</Check>
        <Check checked={remote} onChange={setRemote}>Remote (último de la rama)</Check>
        <div className="ml-auto flex gap-2">
          <Btn small onClick={() => doit("init", "submodule_init", {})} busy={busy === "init"}>Init todos</Btn>
          <Btn small onClick={() => doit("update", "submodule_update", { recursive, remote })} busy={busy === "update"}>Update todos</Btn>
          <Btn small onClick={() => doit("sync", "submodule_sync", { recursive })} busy={busy === "sync"}><RefreshCw size={11} /> Sync</Btn>
        </div>
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && data.length === 0 && <Empty>Este repositorio no tiene submódulos.</Empty>}
      <div className="space-y-2">
        {data?.map((s) => (
          <div key={s.path} className="flex items-center gap-2 rounded-md border border-line bg-panel p-3 transition hover:border-amber/40">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-100">{s.path}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
                <span className="font-mono text-[11px] text-gray-500">{shortSha(s.sha)}</span>
                {s.branch && <span className="text-[11px] text-gray-400">{s.branch}</span>}
              </div>
              <div className="truncate font-mono text-[11px] text-gray-400" title={s.url}>{s.url}</div>
            </div>
            {s.status === "uninitialized"
              ? <Btn small onClick={() => doit(`i:${s.path}`, "submodule_init", { path: s.path })} busy={busy === `i:${s.path}`}>Init</Btn>
              : <Btn small onClick={() => openSub(s)} title="Abrir como repositorio"><ExternalLink size={11} /> Abrir</Btn>}
            <Btn small onClick={() => doit(`u:${s.path}`, "submodule_update", { path: s.path, recursive, remote })} busy={busy === `u:${s.path}`}>Update</Btn>
            <Btn small onClick={() => remove(s)} title="Eliminar"><Trash2 size={12} className="text-git-deleted" /></Btn>
          </div>
        ))}
      </div>
      <SectionTitle>Añadir submódulo</SectionTitle>
      <div className="grid grid-cols-[1fr_160px_110px_auto] items-end gap-2">
        <Field label="URL"><input className={inputCls} value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Ruta"><input className={inputCls} value={path} placeholder="libs/foo" onChange={(e) => setPath(e.target.value)} /></Field>
        <Field label="Rama"><input className={inputCls} value={branch} placeholder="opcional" onChange={(e) => setBranch(e.target.value)} /></Field>
        <Btn variant="primary" onClick={add} busy={busy === "add"} disabled={!url.trim() || !path.trim()}><Plus size={13} /> Añadir</Btn>
      </div>
    </Modal>
  );
}
