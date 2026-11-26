import { useRef, useState } from "react";
import { Copy, FileDiff, FileUp, Save } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Check, ErrorBox, Modal, SectionTitle, errMsg, rd, shortSha, useRepoPath } from "./ui";
import type { ToolProps } from "./types";

export default function PatchModal({ onClose, sha }: ToolProps & { sha?: string }) {
  const repoPath = useRepoPath();
  const [tab, setTab] = useState<"create" | "apply">("create");
  const [wip, setWip] = useState(!sha);
  const [patch, setPatch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(false);
  const [checked, setChecked] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const st = useRepoStore.getState;

  const create = async () => {
    setBusy(true); setError(null);
    try {
      setPatch(await rd<string>("create_patch", wip || !sha ? { repoPath, wip: true } : { repoPath, shas: [sha] }));
    } catch (e) { setError(errMsg(e)); setPatch(null); }
    setBusy(false);
  };
  const saveFile = async () => {
    if (!patch) return;
    const path = await save({
      title: "Guardar parche", defaultPath: wip || !sha ? "cambios.patch" : `${shortSha(sha)}.patch`,
      filters: [{ name: "Parche", extensions: ["patch", "diff"] }],
    });
    if (!path) return;
    try { await rd("save_patch", { path, content: patch }); st().toast("Parche guardado", "info"); }
    catch (e) { setError(errMsg(e)); }
  };
  const copy = async () => {
    if (!patch) return;
    await navigator.clipboard.writeText(patch);
    st().toast("Parche copiado", "info");
  };
  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text()); setChecked(null); setError(null);
  };
  const doCheck = async () => {
    setBusy(true); setError(null);
    try { await rd("apply_patch", { repoPath, patch: text, check: true, index }); setChecked(true); }
    catch (e) { setChecked(false); setError(errMsg(e)); }
    setBusy(false);
  };
  const apply = async () => {
    setBusy(true); setError(null);
    const ok = await st().act("apply_patch", { patch: text, check: false, index });
    setBusy(false);
    if (ok !== undefined) { st().toast("Parche aplicado", "info"); onClose?.(); }
  };

  return (
    <Modal title="Parches" icon={<FileDiff size={15} />} onClose={onClose} width={640}>
      <div className="flex gap-1 rounded-md border border-line p-0.5">
        {(["create", "apply"] as const).map((k) => (
          <button key={k} onClick={() => { setTab(k); setError(null); }}
            className={`flex-1 rounded px-3 py-1 transition ${tab === k ? "bg-amber text-onacc font-semibold" : "text-gray-300 hover:bg-line"}`}>
            {k === "create" ? "Crear parche" : "Aplicar parche"}
          </button>
        ))}
      </div>
      {tab === "create" ? (
        <div className="space-y-3 animate-fade-in">
          <SectionTitle>Origen</SectionTitle>
          <div className="space-y-1.5">
            {sha && <label className="flex items-center gap-2"><input type="radio" className="accent-amber" checked={!wip} onChange={() => { setWip(false); setPatch(null); }} />Commit <span className="font-mono text-amber">{shortSha(sha)}</span> (format-patch)</label>}
            <label className="flex items-center gap-2"><input type="radio" className="accent-amber" checked={wip || !sha} onChange={() => { setWip(true); setPatch(null); }} />Cambios sin commitear (WIP vs HEAD)</label>
          </div>
          <Btn variant="primary" onClick={create} busy={busy}>Generar parche</Btn>
          {patch !== null && (
            <div className="space-y-2 animate-fade-in">
              <textarea readOnly value={patch.length > 200_000 ? patch.slice(0, 200_000) + "\n… (vista truncada)" : patch}
                className="h-56 w-full resize-none rounded-md border border-line bg-app p-2 font-mono text-[11px] text-gray-200 outline-none" />
              <div className="flex gap-2">
                <Btn variant="primary" onClick={saveFile}><Save size={12} /> Guardar como…</Btn>
                <Btn onClick={copy}><Copy size={12} /> Copiar</Btn>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3 animate-fade-in">
          <input ref={fileRef} type="file" accept=".patch,.diff,.txt" className="hidden" onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }} />
          <Btn onClick={() => fileRef.current?.click()}><FileUp size={12} /> Elegir archivo…</Btn>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setChecked(null); }} placeholder="…o pega aquí el contenido del parche"
            className="h-52 w-full resize-none rounded-md border border-line bg-app p-2 font-mono text-[11px] text-gray-200 outline-none focus:border-amber/70" />
          <Check checked={index} onChange={(v) => { setIndex(v); setChecked(null); }}>Aplicar también al índice (--index)</Check>
          <div className="flex items-center gap-2">
            <Btn onClick={doCheck} busy={busy} disabled={!text.trim()}>Comprobar</Btn>
            <Btn variant="primary" onClick={apply} busy={busy} disabled={!text.trim()}>Aplicar</Btn>
            {checked === true && <span className="text-git-added animate-fade-in">El parche se aplica limpiamente.</span>}
          </div>
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Modal>
  );
}
