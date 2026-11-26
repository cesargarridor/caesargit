import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, Empty, ErrorBox, Field, Modal, SectionTitle, Select, Spinner, inputCls, rd, useLoad, useRepoPath } from "./ui";
import type { ConfigEntry, RemoteInfo, ToolProps } from "./types";

type FieldDef =
  | { key: string; label: string; kind: "text"; placeholder?: string; hint?: string }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; hint?: string };

const inherit = { value: "", label: "Heredar (global)" };
const bool = [inherit, { value: "true", label: "Sí" }, { value: "false", label: "No" }];

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Identidad en este repositorio",
    fields: [
      { key: "user.name", label: "Nombre", kind: "text", placeholder: "Tu nombre" },
      { key: "user.email", label: "Correo", kind: "text", placeholder: "tu@correo.com" },
    ],
  },
  {
    title: "Firma de commits",
    fields: [
      { key: "commit.gpgsign", label: "Firmar commits", kind: "select", options: bool },
      { key: "tag.gpgsign", label: "Firmar tags", kind: "select", options: bool },
      { key: "gpg.format", label: "Formato de firma", kind: "select", options: [inherit, { value: "openpgp", label: "GPG (openpgp)" }, { value: "ssh", label: "SSH" }, { value: "x509", label: "x509" }] },
      { key: "user.signingkey", label: "Clave de firma", kind: "text", placeholder: "ID de clave GPG o ruta a clave pública SSH" },
    ],
  },
  {
    title: "Comportamiento",
    fields: [
      { key: "pull.rebase", label: "pull.rebase", kind: "select", options: [inherit, { value: "true", label: "Rebase" }, { value: "false", label: "Merge" }, { value: "merges", label: "Rebase conservando merges" }] },
      { key: "core.autocrlf", label: "core.autocrlf", kind: "select", options: [inherit, { value: "true", label: "true (CRLF al extraer)" }, { value: "input", label: "input (LF al confirmar)" }, { value: "false", label: "false" }] },
      { key: "commit.template", label: "Plantilla de commit", kind: "text", placeholder: "Ruta del archivo de plantilla", hint: "Precarga el resumen y la descripción en la caja de commit." },
    ],
  },
];

export default function RepoSettingsModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const cfg = useLoad<ConfigEntry[]>(() => rd("get_repo_config", { repoPath }), [repoPath]);
  const remotes = useLoad<RemoteInfo[]>(() => rd("list_remotes", { repoPath }), [repoPath]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const byKey = useMemo(() => new Map((cfg.data ?? []).map((e) => [e.key, e])), [cfg.data]);
  useEffect(() => {
    if (cfg.data) setVals(Object.fromEntries(cfg.data.map((e) => [e.key, e.local ?? ""])));
  }, [cfg.data]);

  const changed = (cfg.data ?? []).filter((e) => (vals[e.key] ?? "") !== (e.local ?? ""));
  const save = async () => {
    setBusy(true);
    const st = useRepoStore.getState();
    for (const e of changed) {
      const v = (vals[e.key] ?? "").trim();
      if ((await st.act("set_repo_config", { key: e.key, value: v === "" ? null : v })) === undefined) break;
    }
    setBusy(false);
    cfg.reload();
    st.toast("Configuración del repositorio guardada", "info");
  };

  return (
    <Modal title="Ajustes del repositorio" icon={<Settings2 size={15} />} onClose={onClose} width={640}
      footer={<><Btn onClick={onClose}>Cerrar</Btn><Btn variant="primary" onClick={save} busy={busy} disabled={changed.length === 0}>Guardar{changed.length > 0 && ` (${changed.length})`}</Btn></>}>
      {cfg.loading && !cfg.data && <Spinner />}
      {cfg.error && <ErrorBox>{cfg.error}</ErrorBox>}
      {cfg.data && GROUPS.map((g) => (
        <section key={g.title} className="space-y-3 animate-fade-in">
          <SectionTitle>{g.title}</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            {g.fields.map((f) => {
              const eff = byKey.get(f.key)?.effective;
              const hint = f.hint ?? (eff && !(vals[f.key] ?? "") ? `Valor efectivo: ${eff}` : undefined);
              return (
                <Field key={f.key} label={f.label} hint={hint}>
                  {f.kind === "text"
                    ? <input className={inputCls} value={vals[f.key] ?? ""} placeholder={eff ?? f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                    : <Select value={vals[f.key] ?? ""} options={f.options} onChange={(v) => setVals({ ...vals, [f.key]: v })} />}
                </Field>
              );
            })}
          </div>
        </section>
      ))}
      <section className="space-y-2">
        <SectionTitle>Remotos</SectionTitle>
        {remotes.data?.length === 0 && <Empty>Sin remotos.</Empty>}
        {remotes.data?.map((r) => (
          <div key={r.name} className="flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-1.5">
            <span className="w-20 shrink-0 font-semibold text-gray-100">{r.name}</span>
            <span className="truncate font-mono text-[11px] text-gray-400" title={r.fetchUrl}>{r.fetchUrl}</span>
          </div>
        ))}
      </section>
    </Modal>
  );
}
