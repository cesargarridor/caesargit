import { useState } from "react";
import { HardDrive, Lock, Plus, Unlock, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Empty, ErrorBox, Modal, SectionTitle, Spinner, inputCls, rd, useLoad, useRepoPath } from "./ui";
import type { LfsLock, LfsStatus, ToolProps } from "./types";

export default function LfsModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const st = useLoad<LfsStatus>(() => rd("lfs_status", { repoPath }), [repoPath]);
  const installed = st.data?.installed ?? false;
  const locks = useLoad<LfsLock[]>(() => (installed ? rd("lfs_locks", { repoPath }) : Promise.resolve([])), [repoPath, installed]);
  const [pattern, setPattern] = useState("");
  const [lockPath, setLockPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);

  const reloadAll = () => { st.reload(); locks.reload(); };
  const doit = async (key: string, cmd: string, args: Record<string, unknown> = {}, showOut = false) => {
    setBusy(key);
    const r = await useRepoStore.getState().act<string | null>(cmd, args);
    setBusy(null);
    if (showOut && typeof r === "string") setOut(r.trim() || "Hecho.");
    reloadAll();
    return r;
  };
  const untrack = async (p: string) => {
    if (await useRepoStore.getState().confirm({ title: `Dejar de seguir «${p}» con LFS`, confirmLabel: "Untrack", danger: true })) await doit(`ut:${p}`, "lfs_untrack", { pattern: p });
  };
  const unlock = async (l: LfsLock) => {
    const r = await useRepoStore.getState().ask({
      title: `Desbloquear ${l.path}`, confirmLabel: "Desbloquear", danger: true,
      fields: [{ key: "force", label: "Forzar (aunque lo haya bloqueado otro)", type: "checkbox", optional: true }],
    });
    if (r) await doit(`ul:${l.id}`, "lfs_unlock", { path: l.path, force: r.force === "true" });
  };

  return (
    <Modal title="Git LFS" icon={<HardDrive size={15} />} onClose={onClose} width={680}>
      {st.loading && !st.data && <Spinner />}
      {st.error && <ErrorBox>{st.error}</ErrorBox>}
      {st.data && !st.data.installed && (
        <div className="rounded-md border border-git-modified/40 bg-git-modified/10 p-4 animate-fade-in">
          <div className="font-semibold text-gray-100">Git LFS no está instalado</div>
          <p className="mt-1 text-gray-400">Instálalo desde git-lfs.com (macOS: <span className="font-mono">brew install git-lfs</span>; Windows: instalador oficial o <span className="font-mono">winget install GitHub.GitLFS</span>; Linux: gestor de paquetes) y vuelve a abrir esta ventana.</p>
          <div className="mt-3"><Btn onClick={st.reload}>Volver a comprobar</Btn></div>
        </div>
      )}
      {st.data?.installed && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">{st.data.version}</span>
            <div className="ml-auto flex gap-2">
              <Btn small onClick={() => doit("install", "lfs_install", {}, true)} busy={busy === "install"}>Install</Btn>
              <Btn small onClick={() => doit("pull", "lfs_pull", {}, true)} busy={busy === "pull"}>Pull</Btn>
              <Btn small onClick={() => doit("fetch", "lfs_fetch", {}, true)} busy={busy === "fetch"}>Fetch</Btn>
              <Btn small onClick={() => doit("prune", "lfs_prune", {}, true)} busy={busy === "prune"}>Prune</Btn>
            </div>
          </div>
          {out && <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-app p-2 font-mono text-[11px] text-gray-300 animate-fade-in">{out}</pre>}

          <SectionTitle>Patrones seguidos</SectionTitle>
          {st.data.patterns.length === 0 && <Empty>Ningún patrón.</Empty>}
          <div className="flex flex-wrap gap-1.5">
            {st.data.patterns.map((p) => (
              <span key={p.pattern} className="group flex items-center gap-1 rounded-full border border-line bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[11px] transition hover:border-amber/50" title={p.source}>
                {p.pattern}
                <button onClick={() => untrack(p.pattern)} className="rounded-full p-0.5 text-gray-500 hover:text-git-deleted"><X size={11} /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input className={inputCls} value={pattern} placeholder="*.psd" onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && pattern.trim()) void doit("track", "lfs_track", { pattern: pattern.trim() }).then(() => setPattern("")); }} />
            <Btn variant="primary" disabled={!pattern.trim()} busy={busy === "track"} onClick={() => doit("track", "lfs_track", { pattern: pattern.trim() }).then(() => setPattern(""))}><Plus size={13} /> Track</Btn>
          </div>

          <SectionTitle>Archivos LFS ({st.data.files.length})</SectionTitle>
          <div className="max-h-40 overflow-auto rounded-md border border-line">
            {st.data.files.length === 0 && <Empty>Sin archivos LFS.</Empty>}
            {st.data.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 border-b border-line/60 px-3 py-1 last:border-0">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="font-mono text-[10px] text-gray-500">{f.oid.slice(0, 10)}</span>
                <span className={`rounded px-1.5 text-[10px] ${f.downloaded ? "bg-git-added/15 text-git-added" : "bg-line text-gray-400"}`}>{f.downloaded ? "descargado" : "puntero"}</span>
              </div>
            ))}
          </div>

          <SectionTitle>Bloqueos</SectionTitle>
          {locks.data?.length === 0 && <Empty>Sin bloqueos.</Empty>}
          {locks.data?.map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5">
              <Lock size={12} className="text-git-modified" />
              <span className="min-w-0 flex-1 truncate">{l.path}</span>
              <span className="text-[11px] text-gray-500">{l.owner}</span>
              <Btn small onClick={() => unlock(l)} busy={busy === `ul:${l.id}`}><Unlock size={11} /> Unlock</Btn>
            </div>
          ))}
          <div className="flex gap-2">
            <input className={inputCls} value={lockPath} placeholder="ruta/del/archivo" onChange={(e) => setLockPath(e.target.value)} />
            <Btn disabled={!lockPath.trim()} busy={busy === "lock"} onClick={() => doit("lock", "lfs_lock", { path: lockPath.trim() }).then(() => setLockPath(""))}><Lock size={12} /> Lock</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}
