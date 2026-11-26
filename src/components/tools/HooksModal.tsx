import { useEffect, useRef, useState } from "react";
import { Anchor, Save, Trash2 } from "lucide-react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useRepoStore } from "../../store/useRepoStore";
import { graphiteHighlight, graphiteTheme, langFor, useEditorDark } from "../inspector/cmTheme";
import { Btn, Empty, ErrorBox, Modal, Select, Spinner, errMsg, rd, useLoad, useRepoPath } from "./ui";
import type { HookInfo, HookTemplate, ToolProps } from "./types";

function Editor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useEditorDark();
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          graphiteTheme(dark), graphiteHighlight, langFor("hook.sh"), lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current(u.state.doc.toString()); }),
        ],
      }),
    });
    return () => view.destroy();
    // el documento se reemplaza remontando el componente (key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className="h-full overflow-hidden rounded-md border border-line" />;
}

export default function HooksModal({ onClose }: ToolProps) {
  const repoPath = useRepoPath();
  const list = useLoad<HookInfo[]>(() => rd("list_hooks", { repoPath }), [repoPath]);
  const tpls = useLoad<HookTemplate[]>(() => rd("hook_templates", {}), []);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [orig, setOrig] = useState("");
  const [ver, setVer] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [tpl, setTpl] = useState("");
  const [loadingHook, setLoadingHook] = useState(false);

  const info = list.data?.find((h) => h.name === sel) ?? null;
  const dirty = content !== orig;

  const choose = async (h: HookInfo) => {
    if (dirty && !(await useRepoStore.getState().confirm({ title: "Descartar cambios sin guardar", message: `Hay cambios sin guardar en ${sel}.`, confirmLabel: "Descartar", danger: true }))) return;
    setSel(h.name); setErr(null); setLoadingHook(true);
    try {
      const c = h.exists || h.isSample ? await rd<string>("read_hook", { repoPath, name: h.name }) : "#!/bin/sh\n\n";
      setContent(c); setOrig(c); setVer((v) => v + 1);
    } catch (e) { setErr(errMsg(e)); }
    setLoadingHook(false);
  };
  const saveHook = async () => {
    if (!sel) return;
    if ((await useRepoStore.getState().act("write_hook", { name: sel, content })) !== undefined) { setOrig(content); list.reload(); }
  };
  const toggle = async (h: HookInfo) => {
    await useRepoStore.getState().act("toggle_hook", { name: h.name, enabled: !h.active });
    list.reload();
  };
  const del = async () => {
    if (!sel) return;
    if (!(await useRepoStore.getState().confirm({ title: `Borrar hook «${sel}»`, message: "El archivo se elimina de .git/hooks. No se puede deshacer.", confirmLabel: "Borrar", danger: true }))) return;
    if ((await useRepoStore.getState().act("delete_hook", { name: sel })) !== undefined) { setSel(null); setContent(""); setOrig(""); list.reload(); }
  };
  const applyTpl = (name: string) => {
    setTpl("");
    const t = tpls.data?.find((x) => x.name === name);
    if (t) { setContent(t.content); setVer((v) => v + 1); }
  };
  const forName = tpls.data?.filter((t) => t.name === sel) ?? [];

  return (
    <Modal title="Git hooks" icon={<Anchor size={15} />} onClose={onClose} width={980}>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox>{list.error}</ErrorBox>}
      {list.data && (
        <div className="flex h-[60vh] gap-3">
          <div className="w-60 shrink-0 overflow-auto rounded-md border border-line">
            {list.data.map((h) => (
              <div key={h.name} onClick={() => void choose(h)}
                className={`flex cursor-pointer items-center gap-2 border-l-2 px-3 py-1.5 transition hover:bg-line/50 ${sel === h.name ? "border-amber bg-amber/10" : "border-transparent"}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${h.active ? "bg-git-added" : h.exists ? "bg-git-modified" : "bg-line"}`} />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                {h.isSample && !h.exists && <span className="text-[9px] text-gray-500">sample</span>}
                {h.exists && (
                  <input type="checkbox" className="accent-amber" checked={h.active} title={h.active ? "Desactivar" : "Activar"}
                    onClick={(e) => e.stopPropagation()} onChange={() => void toggle(h)} />
                )}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {!sel && <Empty>Elige un hook para verlo o crearlo.</Empty>}
            {sel && (
              <>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-100">{sel}</span>
                  {info && <span className="text-[11px] text-gray-500">{info.active ? "activo" : info.disabled ? "desactivado" : info.isSample ? "ejemplo" : "sin crear"}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {tpls.data && tpls.data.length > 0 && (
                      <div className="w-44"><Select value={tpl} onChange={applyTpl} options={[{ value: "", label: "Plantilla…" }, ...tpls.data.map((t) => ({ value: t.name, label: t.title }))]} /></div>
                    )}
                    <Btn small variant="primary" onClick={saveHook} disabled={!dirty && !!info?.exists}><Save size={11} /> Guardar</Btn>
                    {info?.exists && <Btn small onClick={del}><Trash2 size={12} className="text-git-deleted" /></Btn>}
                  </div>
                </div>
                {err && <ErrorBox>{err}</ErrorBox>}
                <div className="min-h-0 flex-1">{loadingHook ? <Spinner /> : <Editor key={`${sel}:${ver}`} value={content} onChange={setContent} />}</div>
                {tpl === "" && forName[0] && <div className="text-[11px] text-gray-500">{forName[0].description}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
