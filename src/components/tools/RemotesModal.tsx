import { useState } from "react";
import { CloudDownload, Pencil, Plus, Trash2 } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Empty, ErrorBox, Field, Modal, SectionTitle, Spinner, inputCls, rd, useLoad, useRepoPath } from "./ui";
import type { RemoteInfo, ToolProps } from "./types";

export default function RemotesModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const { act, confirm, toast } = useRepoStore.getState();
  const { data, loading, error, reload } = useLoad<RemoteInfo[]>(() => rd("list_remotes", { repoPath }), [repoPath]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [fetching, setFetching] = useState<string | null>(null);

  const add = async () => {
    if ((await act("add_remote", { name: name.trim(), url: url.trim() })) !== undefined) {
      setName(""); setUrl("");
    }
    reload();
  };
  const startEdit = (r: RemoteInfo) => { setEditing(r.name); setEditName(r.name); setEditUrl(r.fetchUrl); };
  const saveEdit = async (r: RemoteInfo) => {
    if (editName.trim() !== r.name) await act("rename_remote", { old: r.name, new: editName.trim() });
    const target = editName.trim();
    if (editUrl.trim() !== r.fetchUrl) {
      await act("set_remote_url", { name: target, url: editUrl.trim() });
      if (r.pushUrl === r.fetchUrl) await act("set_remote_url", { name: target, url: editUrl.trim(), push: true });
    }
    setEditing(null); reload();
  };
  const del = async (r: RemoteInfo) => {
    if (!(await confirm({ title: `Eliminar remoto «${r.name}»`, message: "Se borrarán también sus ramas de seguimiento.", confirmLabel: "Eliminar", danger: true }))) return;
    await act("remove_remote", { name: r.name });
    reload();
  };
  // el backend solo ofrece fetch de todos los remotos (con o sin prune)
  const fetchAll = async (prune: boolean) => {
    setFetching(prune ? "prune" : "all");
    const ok = await act("fetch", { all: true, prune });
    setFetching(null);
    if (ok !== undefined) toast("Fetch de todos los remotos completado", "info");
  };

  return (
    <Modal title="Remotos" icon={<CloudDownload size={15} />} onClose={onClose} width={620}>
      {data && data.length > 0 && (
        <div className="flex gap-2">
          <Btn small onClick={() => fetchAll(false)} busy={fetching === "all"} disabled={fetching !== null}>Fetch todos</Btn>
          <Btn small onClick={() => fetchAll(true)} busy={fetching === "prune"} disabled={fetching !== null}>Fetch &amp; Prune</Btn>
        </div>
      )}
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && data.length === 0 && <Empty>Este repositorio no tiene remotos.</Empty>}
      <div className="space-y-2">
        {data?.map((r) => (
          <div key={r.name} className="rounded-md border border-line bg-panel p-3 transition hover:border-amber/40">
            {editing === r.name ? (
              <div className="space-y-2 animate-fade-in">
                <Field label="Nombre"><input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
                <Field label="URL"><input className={inputCls} value={editUrl} onChange={(e) => setEditUrl(e.target.value)} /></Field>
                <div className="flex justify-end gap-2">
                  <Btn small onClick={() => setEditing(null)}>Cancelar</Btn>
                  <Btn small variant="primary" onClick={() => saveEdit(r)} disabled={!editName.trim() || !editUrl.trim()}>Guardar</Btn>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-gray-100">{r.name}</div>
                  <div className="truncate font-mono text-[11px] text-gray-400" title={r.fetchUrl}>{r.fetchUrl}</div>
                  {r.pushUrl !== r.fetchUrl && <div className="truncate font-mono text-[11px] text-gray-500" title={r.pushUrl}>push: {r.pushUrl}</div>}
                </div>
                <Btn small onClick={() => startEdit(r)} title="Editar"><Pencil size={12} /></Btn>
                <Btn small onClick={() => del(r)} title="Eliminar"><Trash2 size={12} className="text-git-deleted" /></Btn>
              </div>
            )}
          </div>
        ))}
      </div>
      <SectionTitle>Añadir remoto</SectionTitle>
      <div className="flex items-end gap-2">
        <div className="w-32"><Field label="Nombre"><input className={inputCls} value={name} placeholder="origin" onChange={(e) => setName(e.target.value)} /></Field></div>
        <div className="flex-1"><Field label="URL"><input className={inputCls} value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></Field></div>
        <Btn variant="primary" onClick={add} disabled={!name.trim() || !url.trim()}><Plus size={13} /> Añadir</Btn>
      </div>
    </Modal>
  );
}
