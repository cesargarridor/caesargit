import { useState } from "react";
import { FolderOpen, FolderPlus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, ErrorBox, Field, Modal, Select, errMsg, inputCls, rd, useLoad } from "./ui";
import type { InitTemplates, ToolProps } from "./types";

export default function InitModal({ onClose }: ToolProps) {
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("main");
  const [ignore, setIgnore] = useState("");
  const [license, setLicense] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tpl = useLoad<InitTemplates>(() => rd("init_templates"), []);

  const pick = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: "Carpeta del nuevo repositorio" });
    if (typeof p === "string") setPath(p);
  };
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const out = await rd<string>("init_repo", {
        path: path.trim(), defaultBranch: branch.trim() || null,
        gitignoreTemplate: ignore || null, license: license || null,
      });
      await useRepoStore.getState().openRepo(out);
      onClose?.();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  const opts = (xs: string[] | undefined, none: string) => [{ value: "", label: none }, ...(xs ?? []).map((x) => ({ value: x, label: x }))];

  return (
    <Modal title="Inicializar repositorio" icon={<FolderPlus size={15} />} onClose={busy ? undefined : onClose} width={500}
      footer={<><Btn onClick={onClose} disabled={busy}>Cancelar</Btn><Btn variant="primary" onClick={go} busy={busy} disabled={!path.trim()}>Inicializar</Btn></>}>
      <Field label="Carpeta">
        <div className="flex gap-2">
          <input autoFocus className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="Elige o escribe una carpeta" />
          <Btn onClick={pick}><FolderOpen size={13} /> Examinar</Btn>
        </div>
      </Field>
      <Field label="Rama inicial"><input className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Plantilla .gitignore"><Select value={ignore} onChange={setIgnore} options={opts(tpl.data?.gitignore, "Ninguna")} /></Field>
        <Field label="Licencia"><Select value={license} onChange={setLicense} options={opts(tpl.data?.licenses, "Ninguna")} /></Field>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </Modal>
  );
}
