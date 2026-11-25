import { cv } from "../../lib/themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, keymap, drawSelection, type DecorationSet } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Check, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { ConflictFile } from "../../types/git";
import { graphiteHighlight, graphiteTheme, langFor } from "../inspector/DiffViewer";
import { OperationBanner } from "../inspector/WipPanel";

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
        else if (l === "=======" || l.startsWith("=======")) part = "t";
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

function makeView(parent: HTMLElement, doc: string, path: string, editable: boolean, onChange?: () => void) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(), graphiteTheme, graphiteHighlight, langFor(path), mergeTheme, drawSelection(),
        EditorState.readOnly.of(!editable), EditorView.editable.of(editable),
        ...(editable
          ? [markerDeco, history(), keymap.of([...defaultKeymap, ...historyKeymap]),
             EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(); })]
          : []),
      ],
    }),
  });
}

export default function ThreeWayResolver({ path, onClose }: Props) {
  const run = useRepoStore((s) => s.run);
  const act = useRepoStore((s) => s.act);
  const setModal = useRepoStore((s) => s.setModal);
  const toast = useRepoStore((s) => s.toast);
  const close = useCallback(() => (onClose ? onClose() : setModal(null)), [onClose, setModal]);

  const [data, setData] = useState<ConflictFile | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [saving, setSaving] = useState(false);
  const oursEl = useRef<HTMLDivElement>(null);
  const theirsEl = useRef<HTMLDivElement>(null);
  const resultEl = useRef<HTMLDivElement>(null);
  const result = useRef<EditorView | null>(null);

  useEffect(() => {
    let live = true;
    run<ConflictFile>("get_conflict", { path }).then((d) => live && setData(d)).catch(() => live && close());
    return () => { live = false; };
  }, [path, run, close]);

  useEffect(() => {
    if (!data || !oursEl.current || !theirsEl.current || !resultEl.current) return;
    const views = [
      makeView(oursEl.current, data.ours, path, false),
      makeView(theirsEl.current, data.theirs, path, false),
    ];
    const rv = makeView(resultEl.current, data.merged, path, true, () => setRemaining(parseBlocks(rv.state.doc.toString()).length));
    result.current = rv;
    setRemaining(parseBlocks(data.merged).length);
    return () => { views.forEach((v) => v.destroy()); rv.destroy(); result.current = null; };
  }, [data, path]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  /** Aplica `pick` al bloque bajo el cursor (o al primero) o a todos. */
  const accept = (pick: "ours" | "theirs" | "both", all: boolean) => {
    const v = result.current;
    if (!v) return;
    const text = v.state.doc.toString();
    const blocks = parseBlocks(text);
    if (blocks.length === 0) return;
    const curLine = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
    const targets = all ? blocks : [blocks.find((b) => curLine >= b.start && curLine <= b.end) ?? blocks[0]];
    const lines = text.split("\n");
    for (const b of [...targets].sort((a, c) => c.start - a.start)) {
      const rep = pick === "ours" ? b.ours : pick === "theirs" ? b.theirs : [...b.ours, ...b.theirs];
      lines.splice(b.start, b.end - b.start + 1, ...rep);
    }
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: lines.join("\n") } });
  };

  const resolve = async () => {
    const v = result.current;
    if (!v) return;
    if (parseBlocks(v.state.doc.toString()).length > 0) {
      toast("Quedan marcadores de conflicto sin resolver");
      return;
    }
    setSaving(true);
    const r = await act("resolve_conflict", { path, content: v.state.doc.toString() });
    setSaving(false);
    if (r !== undefined) close();
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
        <button onClick={() => accept("ours", true)} className={btn} disabled={remaining === 0}>Todo Current</button>
        <button onClick={() => accept("theirs", true)} className={btn} disabled={remaining === 0}>Todo Incoming</button>
        <button onClick={close} className="text-gray-400 hover:text-amber"><X size={16} /></button>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-px bg-line">
        <div className="grid min-h-0 grid-cols-2 gap-px">
          <div className="flex min-h-0 flex-col bg-app">
            <div className="flex items-center justify-between bg-panel px-3 py-1 text-xs">
              <span className="font-semibold text-git-renamed">Current (HEAD)</span>
              <button className={btn} onClick={() => accept("ours", false)} disabled={remaining === 0}>Accept Current</button>
            </div>
            <div ref={oursEl} className="min-h-0 flex-1 overflow-auto" />
          </div>
          <div className="flex min-h-0 flex-col bg-app">
            <div className="flex items-center justify-between bg-panel px-3 py-1 text-xs">
              <span className="font-semibold text-git-added">Incoming</span>
              <span className="flex gap-1">
                <button className={btn} onClick={() => accept("theirs", false)} disabled={remaining === 0}>Accept Incoming</button>
                <button className={btn} onClick={() => accept("both", false)} disabled={remaining === 0}>Accept Both</button>
              </span>
            </div>
            <div ref={theirsEl} className="min-h-0 flex-1 overflow-auto" />
          </div>
        </div>
        <div className="flex min-h-0 flex-col bg-app">
          <div className="flex items-center justify-between bg-panel px-3 py-1 text-xs">
            <span className="font-semibold text-amber">Result (editable)</span>
            <button
              onClick={() => void resolve()}
              disabled={saving || remaining > 0}
              className="flex items-center gap-1 rounded bg-amber px-3 py-0.5 font-semibold text-onacc hover:bg-amber-hover disabled:opacity-40"
            >
              <Check size={13} /> Mark as Resolved
            </button>
          </div>
          <div ref={resultEl} className="min-h-0 flex-1 overflow-auto" />
        </div>
      </div>
    </div>
  );
}
