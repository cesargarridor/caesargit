import { useEffect, useState } from "react";
import { GitMerge, Play, Flag } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { Btn, ErrorBox, Field, Modal, SectionTitle, Spinner, inputCls, rd, useLoad, useRepoPath } from "./ui";
import type { FlowConfig, FlowKind, FlowStatus, ToolProps } from "./types";

const KINDS: { kind: Exclude<FlowKind, "support">; label: string }[] = [
  { kind: "feature", label: "Feature" }, { kind: "release", label: "Release" }, { kind: "hotfix", label: "Hotfix" },
];

export default function GitflowModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const { data, loading, error, reload } = useLoad<FlowStatus>(() => rd("flow_status", { repoPath }), [repoPath]);
  const [cfg, setCfg] = useState<FlowConfig | null>(null);
  const [names, setNames] = useState<Record<string, string>>({ feature: "", release: "", hotfix: "" });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (data) setCfg(data.config); }, [data]);

  const doit = async (key: string, cmd: string, args: Record<string, unknown>) => {
    setBusy(key);
    const r = await useRepoStore.getState().act(cmd, args);
    setBusy(null);
    reload();
    return r;
  };
  const start = async (kind: FlowKind) => {
    const r = await doit(`s:${kind}`, "flow_start", { kind, name: names[kind].trim() });
    if (r !== undefined) setNames((n) => ({ ...n, [kind]: "" }));
  };
  const finish = async (kind: FlowKind, name: string) => {
    const tagging = kind === "release" || kind === "hotfix";
    const r = await useRepoStore.getState().ask({
      title: `Finalizar ${kind} «${name}»`, confirmLabel: "Finalizar",
      message: kind === "feature" ? `Se fusiona en ${cfg?.develop ?? "develop"}.` : `Se fusiona en ${cfg?.master ?? "main"} y ${cfg?.develop ?? "develop"}.`,
      fields: [
        { key: "keepBranch", label: "Conservar la rama", type: "checkbox", optional: true },
        { key: "squash", label: "Squash", type: "checkbox", optional: true },
        ...(kind === "feature" ? [{ key: "noFf", label: "Sin fast-forward (--no-ff)", type: "checkbox" as const, optional: true, initial: "true" }] : []),
        ...(tagging ? [
          { key: "tag", label: "Crear tag", type: "checkbox" as const, optional: true, initial: "true" },
          { key: "tagMessage", label: "Mensaje del tag", optional: true },
        ] : []),
        { key: "push", label: "Push a origin", type: "checkbox", optional: true },
      ],
    });
    if (!r) return;
    await doit(`f:${kind}:${name}`, "flow_finish", {
      kind, name, opts: {
        keepBranch: r.keepBranch === "true", squash: r.squash === "true", noFf: r.noFf === "true",
        tag: r.tag === "true", tagMessage: r.tagMessage?.trim() || null, push: r.push === "true",
      },
    });
  };
  const init = async () => {
    if (cfg) await doit("init", "flow_init", { config: cfg });
  };
  const upd = (k: keyof FlowConfig, v: string) => cfg && setCfg({ ...cfg, [k]: v });

  const cfgFields: { k: keyof FlowConfig; label: string }[] = [
    { k: "master", label: "Rama de producción" }, { k: "develop", label: "Rama de desarrollo" },
    { k: "feature", label: "Prefijo feature" }, { k: "release", label: "Prefijo release" },
    { k: "hotfix", label: "Prefijo hotfix" }, { k: "support", label: "Prefijo support" },
    { k: "versionTag", label: "Prefijo de tag de versión" },
  ];

  return (
    <Modal title="Gitflow" icon={<GitMerge size={15} />} onClose={onClose} width={640}>
      {loading && !data && <Spinner />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && cfg && !data.initialized && (
        <div className="space-y-3 animate-fade-in">
          <p className="text-gray-400">Gitflow no está inicializado en este repositorio. Define las ramas y prefijos.</p>
          <div className="grid grid-cols-2 gap-3">
            {cfgFields.map((f) => <Field key={f.k} label={f.label}><input className={inputCls} value={String(cfg[f.k])} onChange={(e) => upd(f.k, e.target.value)} /></Field>)}
          </div>
          <Btn variant="primary" onClick={init} busy={busy === "init"}><Play size={12} /> Inicializar Gitflow</Btn>
        </div>
      )}
      {data?.initialized && (
        <div className="space-y-4 animate-fade-in">
          <div className="flex gap-3 text-[11px] text-gray-400">
            <span>producción <span className="font-mono text-amber">{data.config.master}</span></span>
            <span>desarrollo <span className="font-mono text-amber">{data.config.develop}</span></span>
            {data.current && <span className="ml-auto">actual: <span className="font-mono text-gray-100">{data.current.kind}/{data.current.name}</span></span>}
          </div>
          {KINDS.map(({ kind, label }) => (
            <div key={kind} className="space-y-2">
              <SectionTitle>{label} ({data[kind].length})</SectionTitle>
              {data[kind].map((n) => (
                <div key={n} className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 transition hover:border-amber/40">
                  <span className="font-mono text-gray-400">{data.config[kind]}</span><span className="flex-1 font-semibold text-gray-100">{n}</span>
                  <Btn small onClick={() => finish(kind, n)} busy={busy === `f:${kind}:${n}`}><Flag size={11} /> Finish</Btn>
                </div>
              ))}
              <div className="flex gap-2">
                <input className={inputCls} placeholder={`Nombre del ${kind}`} value={names[kind]} onChange={(e) => setNames({ ...names, [kind]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && names[kind].trim()) void start(kind); }} />
                <Btn variant="primary" onClick={() => start(kind)} disabled={!names[kind].trim()} busy={busy === `s:${kind}`}>Start</Btn>
              </div>
            </div>
          ))}
          {data.support.length > 0 && (
            <div className="space-y-1">
              <SectionTitle>Support</SectionTitle>
              {data.support.map((n) => <div key={n} className="font-mono text-gray-300">{data.config.support}{n}</div>)}
            </div>
          )}
          <p className="text-[11px] text-gray-500">Los conflictos al finalizar dejan el merge en curso: resuélvelos desde el banner.</p>
        </div>
      )}
    </Modal>
  );
}
