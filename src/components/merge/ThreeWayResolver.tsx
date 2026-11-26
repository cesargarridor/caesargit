import { cv } from "../../lib/themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, keymap, drawSelection, type DecorationSet } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { AlertTriangle, Check, FileWarning, Save, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { ConflictFile } from "../../types/git";
import { graphiteHighlight, graphiteTheme, langFor, useEditorDark } from "../inspector/cmTheme";
import { OperationBanner } from "../inspector/WipPanel";
import { DiffSkeleton } from "../layout/Visuals";

interface Props {
  path: string;
  onClose?: () => void;
}

interface Block { start: number; end: number; ours: string[]; base: string[]; theirs: string[] } // líneas 0-index, end inclusivo

/** Localiza los bloques de conflicto con marcadores en el texto actual del resultado. */
export function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const start = i;
      const ours: string[] = [];
      const base: string[] = [];
      const theirs: string[] = [];
      let part: "o" | "b" | "t" = "o";
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith("|||||||")) part = "b";
        else if (l.startsWith("=======")) part = "t";
        else if (l.startsWith(">>>>>>>")) { closed = true; break; }
        else (part === "o" ? ours : part === "b" ? base : theirs).push(l);
        i++;
      }
      if (closed) out.push({ start, end: i, ours, base, theirs });
    }
    i++;
  }
  return out;
}

type Seg =
  | { type: "text"; lines: string[] }
  | { type: "conflict"; idx: number; raw: string[]; ours: string[]; theirs: string[] };

/** Trocea el texto con marcadores en tramos comunes y bloques de conflicto. */
function parseSegments(text: string): Seg[] {
  const lines = text.split("\n");
  const blocks = parseBlocks(text);
  const segs: Seg[] = [];
  let pos = 0;
  blocks.forEach((b, idx) => {
    if (b.start > pos) segs.push({ type: "text", lines: lines.slice(pos, b.start) });
    segs.push({ type: "conflict", idx, raw: lines.slice(b.start, b.end + 1), ours: b.ours, theirs: b.theirs });
    pos = b.end + 1;
  });
  if (pos < lines.length) segs.push({ type: "text", lines: lines.slice(pos) });
  return segs;
}

type Choice = { ours: boolean; theirs: boolean };

/** Reconstruye el Output según los checkboxes; sin marcar = se conserva el bloque con marcadores. */
function render(segs: Seg[], choices: Choice[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s.type === "text") out.push(...s.lines);
    else {
      const c = choices[s.idx] ?? { ours: false, theirs: false };
      if (!c.ours && !c.theirs) out.push(...s.raw);
      else {
        if (c.ours) out.push(...s.ours);
        if (c.theirs) out.push(...s.theirs);
      }
    }
  }
  return out.join("\n");
}

const markerDeco = StateField.define<DecorationSet>({
  create: (s) => build(s),
  update: (_v, tr) => build(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});
function build(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let zone: "o" | "b" | "t" | null = null;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const txt = line.text;
    let cls: string | null = null;
    if (txt.startsWith("<<<<<<<")) { zone = "o"; cls = "cm-m-mark"; }
    else if (zone && txt.startsWith("|||||||")) { zone = "b"; cls = "cm-m-mark"; }
    else if (zone && txt.startsWith("=======")) { zone = "t"; cls = "cm-m-mark"; }
    else if (zone && txt.startsWith(">>>>>>>")) { zone = null; cls = "cm-m-mark"; }
    else if (zone === "o") cls = "cm-m-ours";
    else if (zone === "t") cls = "cm-m-theirs";
    if (cls) b.add(line.from, line.from, Decoration.line({ class: cls }));
  }
  return b.finish();
}

const mergeTheme = EditorView.theme({
  ".cm-m-mark": { backgroundColor: cv("git-conflict", 0.18), color: cv("git-conflict") },
  ".cm-m-ours": { backgroundColor: cv("git-renamed", 0.12) },
  ".cm-m-theirs": { backgroundColor: cv("git-added", 0.12) },
});

function SidePane(props: {
  title: string; tone: "ours" | "theirs"; segs: Seg[]; choices: Choice[]; onToggle: (idx: number) => void;
}) {
  const { tone, segs, choices } = props;
  const color = tone === "ours" ? "text-git-renamed" : "text-git-added";
  const border = tone === "ours" ? "border-git-renamed" : "border-git-added";
  const bg = tone === "ours" ? "bg-git-renamed/10" : "bg-git-added/10";
  return (
    <div className="flex min-h-0 flex-col bg-app">
      <div className={`px-3 py-1 text-xs font-semibold ${color} bg-panel`}>{props.title}</div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {segs.map((s, i) => {
          if (s.type === "text") {
            const L = s.lines;
            const shown = L.length > 8 ? [...L.slice(0, 3), "⋯", ...L.slice(-3)] : L;
            return <pre key={i} className="m-0 whitespace-pre px-3 text-gray-500">{shown.join("\n")}</pre>;
          }
          const lines = tone === "ours" ? s.ours : s.theirs;
          const on = choices[s.idx]?.[tone] ?? false;
          return (
            <div key={i} className={`my-1 border-l-2 ${border} ${on ? bg : ""}`}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-0.5 font-sans text-[11px] text-gray-300">
                <input type="checkbox" className="accent-amber" checked={on} onChange={() => props.onToggle(s.idx)} />
                <span>Conflicto {s.idx + 1}</span>
                <span className="text-gray-500">{lines.length} línea{lines.length === 1 ? "" : "s"}</span>
              </label>
              <pre className="m-0 whitespace-pre px-3 text-gray-200">{lines.join("\n") || " "}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ThreeWayResolver({ path: initialPath, onClose }: Props) {
  const run = useRepoStore((s) => s.run);
  const act = useRepoStore((s) => s.act);
  const confirm = useRepoStore((s) => s.confirm);
  const setModal = useRepoStore((s) => s.setModal);
  const toast = useRepoStore((s) => s.toast);
  const conflictFiles = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.status?.files.filter((f) => f.conflicted) ?? []);
  const dark = useEditorDark();
  const close = useCallback(() => (onClose ? onClose() : setModal(null)), [onClose, setModal]);

  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<ConflictFile | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const resultEl = useRef<HTMLDivElement>(null);
  const result = useRef<EditorView | null>(null);
  const outputRef = useRef("");
  const programmatic = useRef(false);

  const segs = useMemo(() => (data ? parseSegments(data.merged) : []), [data]);
  const nBlocks = segs.filter((s) => s.type === "conflict").length;

  useEffect(() => {
    let live = true;
    setData(null);
    run<ConflictFile>("get_conflict", { path })
      .then((d) => {
        if (!live) return;
        const sg = parseSegments(d.merged);
        const ch = sg.filter((s) => s.type === "conflict").map(() => ({ ours: false, theirs: false }));
        setChoices(ch);
        outputRef.current = d.merged;
        setDirty(false);
        setRemaining(parseBlocks(d.merged).length);
        setData(d);
      })
      .catch(() => live && close());
    return () => { live = false; };
  }, [path, run, close]);

  // editor Output (editable)
  useEffect(() => {
    if (!data || !resultEl.current) return;
    const el = resultEl.current;
    const rv = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: outputRef.current,
        extensions: [
          lineNumbers(), graphiteTheme(dark), graphiteHighlight, langFor(path), mergeTheme, drawSelection(),
          markerDeco, history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            outputRef.current = u.state.doc.toString();
            setRemaining(parseBlocks(outputRef.current).length);
            if (!programmatic.current) setDirty(true);
          }),
        ],
      }),
    });
    result.current = rv;
    return () => { rv.destroy(); result.current = null; };
  }, [data, path, dark, nBlocks]);

  const setOutput = (text: string) => {
    const v = result.current;
    if (!v) return;
    programmatic.current = true;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    programmatic.current = false;
    setDirty(false);
  };

  const applyChoices = async (next: Choice[]) => {
    if (dirty) {
      const ok = await confirm({ title: "Output editado", message: "Cambiar la selección regenerará el Output y perderá tus ediciones manuales.", confirmLabel: "Regenerar", danger: true });
      if (!ok) return;
    }
    setChoices(next);
    setOutput(render(segs, next));
  };
  const toggle = (idx: number, side: "ours" | "theirs") => {
    const next = choices.map((c, i) => (i === idx ? { ...c, [side]: !c[side] } : c));
    void applyChoices(next);
  };
  const setAll = (ours: boolean, theirs: boolean) => void applyChoices(choices.map(() => ({ ours, theirs })));

  const switchFile = async (p: string) => {
    if (p === path) return;
    if (dirty) {
      const ok = await confirm({ title: "Cambios sin guardar", message: "Se perderán las ediciones del Output de este archivo.", confirmLabel: "Descartar", danger: true });
      if (!ok) return;
    }
    setPath(p);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !dirty && !useRepoStore.getState().dialog) close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close, dirty]);

  const content = () => result.current?.state.doc.toString() ?? outputRef.current;
  const saveOnly = async () => {
    setSaving(true);
    const r = await act("write_file", { path, content: content() });
    setSaving(false);
    if (r !== undefined) { setDirty(false); toast("Guardado (aún sin marcar como resuelto)", "info"); }
  };
  const markResolved = async () => {
    if (parseBlocks(content()).length > 0) { toast("Quedan marcadores de conflicto sin resolver"); return; }
    setSaving(true);
    const r = await act("resolve_conflict", { path, content: content() });
    setSaving(false);
    if (r === undefined) return;
    const next = conflictFiles.map((f) => f.path).filter((p) => p !== path)[0];
    if (next) setPath(next);
    else close();
  };

  /* ---- DU / UD: eliminado en un lado ---- */
  const fc = conflictFiles.find((f) => f.path === path);
  const code = fc ? `${fc.index}${fc.worktree}` : "";
  const deletedOn: "ours" | "theirs" | null = code === "DU" ? "ours" : code === "UD" ? "theirs" : null;
  const noMarkers = !!data && nBlocks === 0;
  const resolveSide = async (side: "ours" | "theirs") => {
    const r = await act("resolve_with_side", { path, side });
    if (r === undefined) return;
    const next = conflictFiles.map((f) => f.path).filter((p) => p !== path)[0];
    if (next) setPath(next);
    else close();
  };

  const btn = "rounded border border-line px-2 py-0.5 text-xs text-gray-200 hover:border-amber hover:text-amber disabled:opacity-40";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app">
      <OperationBanner />
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 text-sm">
        <span className="font-semibold text-amber">Resolver conflicto</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-300">{path}</span>
        <span className={`text-xs ${remaining > 0 ? "text-git-conflict" : "text-git-added"}`}>
          {remaining > 0 ? `${remaining} conflicto${remaining === 1 ? "" : "s"} restante${remaining === 1 ? "" : "s"}` : "Sin conflictos"}
        </span>
        {nBlocks > 0 && (
          <>
            <button onClick={() => setAll(true, false)} className={btn}>Todo Current</button>
            <button onClick={() => setAll(false, true)} className={btn}>Todo Incoming</button>
            <button onClick={() => setAll(true, true)} className={btn}>Todo ambos</button>
          </>
        )}
        <button onClick={close} className="text-gray-400 hover:text-amber"><X size={16} /></button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel">
          <div className="border-b border-line px-3 py-1 text-[11px] font-semibold tracking-wide text-gray-400">Conflicted files ({conflictFiles.length})</div>
          {conflictFiles.length === 0 && <div className="p-3 text-xs text-git-added">Todo resuelto</div>}
          {conflictFiles.map((f) => (
            <button key={f.path} onClick={() => void switchFile(f.path)} title={f.path}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-elev ${f.path === path ? "bg-elev text-amber" : "text-gray-200"}`}>
              <AlertTriangle size={12} className="shrink-0 text-git-conflict" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="font-mono text-[10px] text-gray-500">{f.index}{f.worktree}</span>
            </button>
          ))}
        </div>
        {!data ? (
          <div className="min-w-0 flex-1"><DiffSkeleton /></div>
        ) : noMarkers ? (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-gray-300">
            <FileWarning size={36} className="text-git-conflict" />
            {deletedOn ? (
              <>
                <div>
                  Este archivo fue <b>eliminado en {deletedOn === "ours" ? "Current (tu rama)" : "Incoming"}</b> y modificado en el otro lado.
                </div>
                <div className="flex gap-2">
                  <button className="rounded bg-amber px-3 py-1 text-xs font-semibold text-onacc hover:bg-amber-hover" onClick={() => void resolveSide(deletedOn === "ours" ? "theirs" : "ours")}>
                    Mantener el archivo
                  </button>
                  <button className="rounded border border-git-deleted px-3 py-1 text-xs text-git-deleted hover:bg-git-deleted/10" onClick={() => void resolveSide(deletedOn)}>
                    Borrar el archivo
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>No hay marcadores de conflicto en este archivo ({code || "binario"}). Elige qué versión conservar.</div>
                <div className="flex gap-2">
                  <button className={btn} onClick={() => void resolveSide("ours")}>Usar Current (ours)</button>
                  <button className={btn} onClick={() => void resolveSide("theirs")}>Usar Incoming (theirs)</button>
                  <button className={btn} onClick={async () => { if ((await act("resolve_conflict", { path, content: data.merged })) !== undefined) { const nx = conflictFiles.map((f) => f.path).filter((x) => x !== path)[0]; if (nx) setPath(nx); else close(); } }}>Marcar como resuelto (contenido actual)</button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 grid-rows-2 gap-px bg-line">
            <div className="grid min-h-0 grid-cols-2 gap-px">
              <SidePane title="Current (HEAD)" tone="ours" segs={segs} choices={choices} onToggle={(i) => toggle(i, "ours")} />
              <SidePane title="Incoming" tone="theirs" segs={segs} choices={choices} onToggle={(i) => toggle(i, "theirs")} />
            </div>
            <div className="flex min-h-0 flex-col bg-app">
              <div className="flex items-center gap-2 bg-panel px-3 py-1 text-xs">
                <span className="font-semibold text-amber">Output (editable){dirty ? " *" : ""}</span>
                <span className="flex-1" />
                <button onClick={() => void saveOnly()} disabled={saving} className={`${btn} flex items-center gap-1`}><Save size={12} /> Save</button>
                <button
                  onClick={() => void markResolved()}
                  disabled={saving || remaining > 0}
                  className="flex items-center gap-1 rounded bg-amber px-3 py-0.5 font-semibold text-onacc hover:bg-amber-hover disabled:opacity-40"
                >
                  <Check size={13} /> Mark resolved
                </button>
              </div>
              <div ref={resultEl} className="min-h-0 flex-1 overflow-auto" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
