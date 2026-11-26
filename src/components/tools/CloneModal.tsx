import { useEffect, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Check, ErrorBox, Field, Modal, errMsg, inputCls } from "./ui";
import type { GitProgress, ToolProps } from "./types";

const nameFromUrl = (u: string) => {
  const m = u.trim().replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/:\\]/).pop();
  return m ?? "";
};

export default function CloneModal({ onClose }: ToolProps) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [shallow, setShallow] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<GitProgress | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen<GitProgress>("git-progress", (e) => { if (e.payload.op === "clone") setProgress(e.payload); })
      .then((u) => { if (dead) u(); else un = u; });
    return () => { dead = true; un?.(); };
  }, []);

  const pick = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: "Carpeta de destino" });
    if (typeof p === "string") setParent(p);
  };
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const dest = parent && name ? `${parent.replace(/[/\\]+$/, "")}${sep}${name}` : "";
  const valid = url.trim() !== "" && dest !== "";

  const go = async () => {
    setBusy(true); setError(null); setProgress(null);
    try {
      const path = await invoke<string>("clone_repo", {
        url: url.trim(), dest, depth: shallow ? 1 : null, recursive, branch: branch.trim() || null,
      });
      await useRepoStore.getState().openRepo(path);
      useRepoStore.getState().toast("Repositorio clonado", "info");
      onClose?.();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Clonar repositorio" icon={<Download size={15} />} onClose={busy ? undefined : onClose} width={540}
      footer={<>
        <Btn onClick={onClose} disabled={busy}>Cancelar</Btn>
        <Btn variant="primary" onClick={go} busy={busy} disabled={!valid}>Clonar</Btn>
      </>}>
      <Field label="URL del repositorio">
        <input autoFocus className={inputCls} placeholder="https://github.com/usuario/repo.git" value={url} disabled={busy}
          onChange={(e) => { setUrl(e.target.value); if (!nameTouched) setName(nameFromUrl(e.target.value)); }} />
      </Field>
      <Field label="Carpeta de destino">
        <div className="flex gap-2">
          <input className={inputCls} value={parent} disabled={busy} placeholder="Elige una carpeta…" onChange={(e) => setParent(e.target.value)} />
          <Btn onClick={pick} disabled={busy}><FolderOpen size={13} /> Examinar</Btn>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nombre de la carpeta">
          <input className={inputCls} value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
        </Field>
        <Field label="Rama (opcional)">
          <input className={inputCls} value={branch} disabled={busy} placeholder="por defecto del remoto" onChange={(e) => setBranch(e.target.value)} />
        </Field>
      </div>
      {dest && <div className="truncate font-mono text-[11px] text-gray-500">{dest}</div>}
      <div className="flex gap-6">
        <Check checked={shallow} onChange={setShallow} disabled={busy}>Shallow (depth 1)</Check>
        <Check checked={recursive} onChange={setRecursive} disabled={busy}>Con submódulos (recursive)</Check>
      </div>
      {busy && (
        <div className="space-y-1 animate-fade-in">
          <div className="h-1.5 overflow-hidden rounded bg-line">
            <div className="h-full bg-amber transition-all duration-300" style={{ width: `${Math.min(100, progress?.percent ?? 0)}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-gray-500">
            <span className="truncate">{progress?.message ?? "Iniciando…"}</span>
            <span className="font-mono">{Math.round(progress?.percent ?? 0)}%</span>
          </div>
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Modal>
  );
}
