import { useMemo, useState } from "react";
import { ExternalLink, FolderOpen, FolderTree, Lock, Trash2, Unlock } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Check, Empty, ErrorBox, Field, Modal, SectionTitle, Select, Spinner, inputCls, rd, shortSha, useLoad, useRepoPath } from "./ui";
import type { ToolProps, Worktree } from "./types";

export default function WorktreesModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const branches = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.branches);
  const { data, loading, error, reload } = useLoad<Worktree[]>(() => rd("list_worktrees", { repoPath }), [repoPath]);
  const [newBranch, setNewBranch] = useState(false);
  const [branch, setBranch] = useState("");
  const [start, setStart] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const local = useMemo(() => (branches ?? []).filter((b) => !b.isRemote), [branches]);
  const used = new Set((data ?? []).map((w) => w.branch).filter(Boolean));
  const folder = (branch.trim() || "worktree").replace(/[^\w.-]+/g, "-");
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const dest = parent ? `${parent.replace(/[/\\]+$/, "")}${sep}${folder}` : "";

  const doit = async (key: string, cmd: string, args: Record<string, unknown>) => {
    setBusy(key);
    const r = await useRepoStore.getState().act(cmd, args);
    setBusy(null);
    reload();
    return r;
  };
  const pick = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: "Carpeta que contendrá el worktree" });
    if (typeof p === "string") setParent(p);
  };
  const create = async () => {
    const ok = await doit("add", "add_worktree", {
      path: dest, branch: branch.trim(), newBranch, startPoint: newBranch && start.trim() ? start.trim() : null,
    });
    if (ok !== undefined) { setBranch(""); setStart(""); }
  };
  const lock = async (w: Worktree) => {
    const r = await useRepoStore.getState().ask({ title: "Bloquear worktree", fields: [{ key: "reason", label: "Motivo (opcional)", optional: true }], confirmLabel: "Bloquear" });
    if (r) await doit(`l:${w.path}`, "lock_worktree", { path: w.path, reason: r.reason?.trim() || null });
  };
  const remove = async (w: Worktree) => {
    const r = await useRepoStore.getState().ask({
      title: "Eliminar worktree", message: `${w.path}\n\nSe borra su carpeta de trabajo.`, danger: true, confirmLabel: "Eliminar",
      fields: [
        { key: "deleteBranch", label: "Borrar también la rama", type: "checkbox", optional: true },
        { key: "force", label: "Forzar (cambios sin guardar / rama sin fusionar)", type: "checkbox", optional: true },
      ],
    });
    if (r) await doit(`r:${w.path}`, "remove_worktree", { path: w.path, force: r.force === "true", deleteBranch: r.deleteBranch === "true" });
  };
  const prune = async () => {
    const n = await doit("prune", "prune_worktrees", {});
    if (typeof n === "number") useRepoStore.getState().toast(n > 0 ? `${n} worktrees obsoletos eliminados` : "Nada que limpiar", "info");
  };

  return (
    <Modal title="Worktrees" icon={<FolderTree size={15} />} onClose={onClose} width={720}>
      <div className="flex items-center justify-between">
        <SectionTitle>Worktrees del repositorio</SectionTitle>
        <Btn small onClick={prune} busy={busy === "prune"}>Prune</Btn>
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && data.length === 0 && <Empty>Sin worktrees.</Empty>}
      <div className="space-y-2">
        {data?.map((w) => (
          <div key={w.path} className="flex items-center gap-2 rounded-md border border-line bg-panel p-3 transition hover:border-amber/40">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-100">{w.branch ?? (w.detached ? "HEAD desacoplado" : "—")}</span>
                <span className="font-mono text-[11px] text-gray-500">{shortSha(w.sha)}</span>
                {w.isMain && <span className="rounded bg-amber/15 px-1.5 text-[10px] text-amber">principal</span>}
                {w.locked && <span className="flex items-center gap-1 rounded bg-git-modified/15 px-1.5 text-[10px] text-git-modified"><Lock size={9} />{w.lockReason || "bloqueado"}</span>}
                {w.prunable && <span className="rounded bg-git-deleted/15 px-1.5 text-[10px] text-git-deleted">obsoleto</span>}
              </div>
              <div className="truncate font-mono text-[11px] text-gray-400" title={w.path}>{w.path}</div>
            </div>
            {!w.prunable && <Btn small onClick={() => { void useRepoStore.getState().openRepo(w.path); onClose?.(); }}><ExternalLink size={11} /> Abrir</Btn>}
            {!w.isMain && (w.locked
              ? <Btn small onClick={() => doit(`u:${w.path}`, "unlock_worktree", { path: w.path })} busy={busy === `u:${w.path}`} title="Desbloquear"><Unlock size={12} /></Btn>
              : <Btn small onClick={() => lock(w)} title="Bloquear"><Lock size={12} /></Btn>)}
            {!w.isMain && <Btn small onClick={() => remove(w)} title="Eliminar"><Trash2 size={12} className="text-git-deleted" /></Btn>}
          </div>
        ))}
      </div>
      <SectionTitle>Nuevo worktree</SectionTitle>
      <Check checked={newBranch} onChange={(v) => { setNewBranch(v); setBranch(""); }}>Crear una rama nueva</Check>
      <div className="grid grid-cols-2 gap-3">
        <Field label={newBranch ? "Nombre de la rama nueva" : "Rama"}>
          {newBranch
            ? <input className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/x" />
            : <Select value={branch} onChange={setBranch} options={[{ value: "", label: "Elige una rama…" }, ...local.filter((b) => !used.has(b.name)).map((b) => ({ value: b.name, label: b.name }))]} />}
        </Field>
        {newBranch && <Field label="Partir de (opcional)"><input className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} placeholder="HEAD" /></Field>}
      </div>
      <Field label="Carpeta contenedora">
        <div className="flex gap-2">
          <input className={inputCls} value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Elige una carpeta…" />
          <Btn onClick={pick}><FolderOpen size={13} /> Examinar</Btn>
        </div>
      </Field>
      {dest && <div className="truncate font-mono text-[11px] text-gray-500">{dest}</div>}
      <Btn variant="primary" onClick={create} busy={busy === "add"} disabled={!branch.trim() || !parent}>Crear worktree</Btn>
    </Modal>
  );
}
