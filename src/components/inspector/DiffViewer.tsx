import { EmptyState, DiffSkeleton } from "../layout/Visuals";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap, lineNumbers, type DecorationSet,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks } from "@codemirror/merge";
import { ChevronDown, ChevronUp, Columns2, Eye, Pencil, Rows2, Save, Text, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { DiffFile, HunkAction } from "../../types/git";
import { graphiteHighlight, graphiteTheme, langFor, useEditorDark } from "./cmTheme";
import { useDiffPrefs, isImage, type ContextSize, type DiffMode } from "./fileUtils";
import ImageDiff from "./ImageDiff";

// compatibilidad con importadores antiguos
export { graphiteHighlight, graphiteTheme, langFor } from "./cmTheme";

export type DiffContext = "unstaged" | "staged" | "commit";

interface Props {
  diff: DiffFile;
  context: DiffContext;
  /** sha del commit (contexto commit/compare) para «View file» e imágenes */
  rev?: string;
  /** revisiones explícitas (comparaciones); null = lado inexistente */
  revs?: { old: string | null; new: string | null };
  onClose?: () => void;
  onHunkAction?: (hunkIndex: number, action: HunkAction) => void;
  onLinesAction?: (hunkIndex: number, lineIndices: number[], action: "stage" | "unstage") => void;
}

interface LineRef { hunk: number; idx: number } // idx -1 = cabecera

const toggleSel = StateEffect.define<number>();
const clearSel = StateEffect.define<null>();
const selField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(v, tr) {
    let out = v;
    for (const e of tr.effects) {
      if (e.is(toggleSel)) {
        out = new Set(out);
        if (out.has(e.value)) out.delete(e.value);
        else out.add(e.value);
      } else if (e.is(clearSel)) out = new Set();
    }
    return out;
  },
});

class PickMarker extends GutterMarker {
  constructor(readonly on: boolean) { super(); }
  eq(o: PickMarker) { return o.on === this.on; }
  toDOM() {
    const d = document.createElement("span");
    d.className = "cm-pick" + (this.on ? " on" : "");
    d.textContent = this.on ? "■" : "□";
    return d;
  }
}
class TextMarker extends GutterMarker {
  constructor(readonly text: string) { super(); }
  eq(o: TextMarker) { return o.text === this.text; }
  toDOM() {
    const d = document.createElement("span");
    d.className = "cm-ln";
    d.textContent = this.text;
    return d;
  }
}
class HunkBtns extends WidgetType {
  constructor(
    readonly hunk: number,
    readonly buttons: { label: string; action: HunkAction }[],
    readonly cb: (h: number, a: HunkAction) => void,
  ) { super(); }
  eq(o: HunkBtns) { return o.hunk === this.hunk && o.buttons.map((b) => b.label).join() === this.buttons.map((b) => b.label).join(); }
  toDOM() {
    const w = document.createElement("span");
    w.className = "cm-hunk-btns";
    for (const b of this.buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.onmousedown = (e) => { e.preventDefault(); this.cb(this.hunk, b.action); };
      w.appendChild(btn);
    }
    return w;
  }
  ignoreEvent() { return true; }
}

/* ---------- vista de archivo completo / editor ---------- */

function CodeView({ path, text, editable, onSave, onDirty, getDoc }: {
  path: string; text: string; editable: boolean; onSave?: (content: string) => void; onDirty?: (d: boolean) => void;
  getDoc?: React.MutableRefObject<(() => string) | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useEditorDark();
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const dirtyRef = useRef(onDirty);
  dirtyRef.current = onDirty;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(), graphiteTheme(dark), graphiteHighlight, langFor(path),
          ...(editable
            ? [
                history(),
                keymap.of([
                  { key: "Mod-s", preventDefault: true, run: (v) => { saveRef.current?.(v.state.doc.toString()); return true; } },
                  ...defaultKeymap, ...historyKeymap,
                ]),
                EditorView.updateListener.of((u) => { if (u.docChanged) dirtyRef.current?.(true); }),
              ]
            : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        ],
      }),
    });
    if (getDoc) getDoc.current = () => view.state.doc.toString();
    if (editable) view.focus();
    return () => { if (getDoc) getDoc.current = null; view.destroy(); };
  }, [text, path, editable, dark]);
  return <div ref={host} className="min-h-0 flex-1 overflow-auto" />;
}

const CONTEXTS: { v: ContextSize; l: string }[] = [
  { v: 3, l: "3 líneas" }, { v: 10, l: "10 líneas" }, { v: 25, l: "25 líneas" }, { v: "full", l: "Archivo completo" },
];

/* ---------- componente ---------- */

export default function DiffViewer(props: Props) {
  const { diff, context, rev, revs, onClose } = props;
  const prefs = useDiffPrefs();
  const { mode, ignoreWhitespace, wordDiff, context: ctxSize } = prefs;
  const run = useRepoStore((s) => s.run);
  const dark = useEditorDark();
  const [cur, setCur] = useState(0);
  const [selCount, setSelCount] = useState(0);
  const [body, setBody] = useState<"diff" | "file" | "edit">("diff");
  const [fileText, setFileText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [svgText, setSvgText] = useState(false);
  const docGetter = useRef<(() => string) | null>(null);
  const [total, setTotal] = useState(diff.hunks.length);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const selHunk = useRef<number | null>(null);
  const hunkStarts = useRef<number[]>([]);
  const editable = context !== "commit" && !revs;

  const built = useMemo(() => {
    const lines: string[] = [];
    const refs: LineRef[] = [];
    const nums: string[] = [];
    const starts: number[] = [];
    diff.hunks.forEach((h, hi) => {
      starts.push(lines.length + 1);
      lines.push(h.header);
      refs.push({ hunk: hi, idx: -1 });
      nums.push("");
      h.lines.forEach((l, li) => {
        lines.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.content);
        refs.push({ hunk: hi, idx: li });
        nums.push(`${l.oldNo ?? ""}${l.oldNo != null && l.newNo != null ? "·" : ""}${l.newNo ?? ""}`);
      });
    });
    const orig: string[] = [];
    const mod: string[] = [];
    diff.hunks.forEach((h, hi) => {
      if (hi > 0) { orig.push("⋯"); mod.push("⋯"); }
      for (const l of h.lines) {
        if (l.kind !== "add") orig.push(l.content);
        if (l.kind !== "del") mod.push(l.content);
      }
    });
    return { text: lines.join("\n"), refs, nums, starts, orig: orig.join("\n"), mod: mod.join("\n") };
  }, [diff]);
  hunkStarts.current = built.starts;

  // reset al cambiar de archivo
  useEffect(() => { setBody("diff"); setFileText(null); setDirty(false); setSvgText(false); }, [diff.path, rev]);

  const showImage = isImage(diff.path) && !(svgText && diff.path.toLowerCase().endsWith(".svg"));

  useEffect(() => {
    const el = host.current;
    if (!el || body !== "diff" || showImage) return;
    el.innerHTML = "";
    viewRef.current = null;
    mergeRef.current = null;
    selHunk.current = null;
    setSelCount(0);
    setCur(0);
    setTotal(diff.hunks.length);
    if (diff.binary || diff.hunks.length === 0) return;
    const base = [graphiteTheme(dark), graphiteHighlight, langFor(diff.path), EditorState.readOnly.of(true), EditorView.editable.of(false)];

    if (mode === "split") {
      const mv = new MergeView({
        parent: el,
        a: { doc: built.orig, extensions: [...base, lineNumbers()] },
        b: { doc: built.mod, extensions: [...base, lineNumbers()] },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
      mergeRef.current = mv;
      setTotal(getChunks(mv.b.state)?.chunks.length ?? 0);
      return () => { mv.destroy(); mergeRef.current = null; };
    }

    if (mode === "inline") {
      const v = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: built.mod,
          extensions: [
            ...base, lineNumbers(),
            unifiedMergeView({ original: built.orig, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 4 } }),
          ],
        }),
      });
      viewRef.current = v;
      setTotal(getChunks(v.state)?.chunks.length ?? 0);
      return () => { v.destroy(); viewRef.current = null; };
    }

    const decos = (state: EditorState): DecorationSet => {
      const b = new RangeSetBuilder<Decoration>();
      const sel = state.field(selField);
      for (let n = 1; n <= state.doc.lines; n++) {
        const r = built.refs[n - 1];
        const h = diff.hunks[r.hunk];
        const ln = state.doc.line(n);
        const pos = ln.from;
        if (r.idx < 0) {
          b.add(pos, pos, Decoration.line({ class: "cm-d-hunk" }));
          if (editable && propsRef.current.onHunkAction) {
            const btns: { label: string; action: HunkAction }[] =
              context === "unstaged"
                ? [{ label: "Stage Hunk", action: "stage" }, { label: "Discard Hunk", action: "discard" }]
                : [{ label: "Unstage Hunk", action: "unstage" }];
            b.add(ln.to, ln.to, Decoration.widget({ widget: new HunkBtns(r.hunk, btns, (hi, a) => propsRef.current.onHunkAction?.(hi, a)), side: 1 }));
          }
        } else {
          const dl = h.lines[r.idx];
          const k = dl.kind;
          const cls = (k === "add" ? "cm-d-add" : k === "del" ? "cm-d-del" : "") + (sel.has(n) ? " cm-d-sel" : "");
          if (cls.trim()) b.add(pos, pos, Decoration.line({ class: cls }));
          if (wordDiff && dl.words && k !== "ctx") {
            let off = pos + 1;
            const wcls = k === "add" ? "cm-w-add" : "cm-w-del";
            for (const w of dl.words) {
              const to = Math.min(off + w.text.length, ln.to);
              if (w.changed && to > off) b.add(off, to, Decoration.mark({ class: wcls }));
              off += w.text.length;
              if (off >= ln.to) break;
            }
          }
        }
      }
      return b.finish();
    };
    const decoField = StateField.define<DecorationSet>({
      create: (s) => decos(s),
      update: (_v, tr) => decos(tr.state),
      provide: (f) => EditorView.decorations.from(f),
    });
    const numGutter = gutter({
      class: "cm-numgutter",
      lineMarker(view, line) {
        return new TextMarker(built.nums[view.state.doc.lineAt(line.from).number - 1] ?? "");
      },
    });
    const pickGutter = gutter({
      class: "cm-pickgutter",
      lineMarker(view, line) {
        const n = view.state.doc.lineAt(line.from).number;
        const r = built.refs[n - 1];
        if (!editable || r.idx < 0) return null;
        if (diff.hunks[r.hunk].lines[r.idx].kind === "ctx") return null;
        return new PickMarker(view.state.field(selField).has(n));
      },
      lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(toggleSel) || e.is(clearSel))),
      domEventHandlers: {
        mousedown(view, line) {
          const n = view.state.doc.lineAt(line.from).number;
          const r = built.refs[n - 1];
          if (r.idx < 0 || diff.hunks[r.hunk].lines[r.idx].kind === "ctx") return false;
          if (selHunk.current !== null && selHunk.current !== r.hunk) view.dispatch({ effects: clearSel.of(null) });
          selHunk.current = r.hunk;
          view.dispatch({ effects: toggleSel.of(n) });
          const size = view.state.field(selField).size;
          if (size === 0) selHunk.current = null;
          setSelCount(size);
          return true;
        },
      },
    });
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: built.text,
        extensions: [selField, decoField, pickGutter, numGutter, ...base],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [diff, mode, built, context, editable, wordDiff, dark, body, showImage]);

  const jump = (dir: 1 | -1) => {
    if (mode === "split" || mode === "inline") {
      const v = mode === "split" ? mergeRef.current?.b : viewRef.current;
      if (!v) return;
      (dir === 1 ? goToNextChunk : goToPreviousChunk)(v);
      setCur((c) => Math.max(0, Math.min(Math.max(total - 1, 0), c + dir)));
      return;
    }
    const v = viewRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min(total - 1, cur + dir));
    const ln = hunkStarts.current[next];
    if (!ln) return;
    v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(ln).from, { y: "start", yMargin: 4 }) });
    setCur(next);
  };

  const doLines = (action: "stage" | "unstage") => {
    const v = viewRef.current;
    if (!v || selHunk.current === null) return;
    const hi = selHunk.current;
    const idx = [...v.state.field(selField)].map((n) => built.refs[n - 1].idx).filter((i) => i >= 0).sort((a, b) => a - b);
    v.dispatch({ effects: clearSel.of(null) });
    selHunk.current = null;
    setSelCount(0);
    props.onLinesAction?.(hi, idx, action);
  };

  /* ---- ver archivo / editar ---- */
  const viewRev = context === "unstaged" ? "WORKTREE" : context === "staged" ? "INDEX" : revs?.new ?? rev ?? "HEAD";
  const loadFile = useCallback(async (kind: "file" | "edit") => {
    setFileText(null);
    setBody(kind);
    setDirty(false);
    try {
      const t = kind === "edit"
        ? await run<string>("read_file", { path: diff.path })
        : await run<string>("show_file", { rev: viewRev, path: diff.path });
      setFileText(t);
    } catch {
      setBody("diff");
    }
  }, [run, diff.path, viewRev]);

  const save = useCallback(async (content: string) => {
    try {
      await run("write_file", { path: diff.path, content });
      setDirty(false);
      useRepoStore.getState().toast("Guardado", "info");
    } catch { /* toast ya mostrado */ }
  }, [run, diff.path]);

  const closeBody = async () => {
    if (body === "edit" && dirty) {
      const ok = await useRepoStore.getState().confirm({ title: "Cambios sin guardar", message: "Se perderán las ediciones del archivo.", confirmLabel: "Descartar ediciones", danger: true });
      if (!ok) return;
    }
    setBody("diff");
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (useRepoStore.getState().dialog) return;
      if (body !== "diff") { e.stopPropagation(); void closeBody(); }
      else if (onClose) { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const imageRevs = useMemo(() => {
    const added = diff.status.startsWith("A") || diff.status.startsWith("?");
    const removed = diff.status.startsWith("D");
    let o: string | null; let n: string | null;
    if (revs) { o = revs.old; n = revs.new; }
    else if (context === "unstaged") { o = "INDEX"; n = "WORKTREE"; }
    else if (context === "staged") { o = "HEAD"; n = "INDEX"; }
    else { o = rev ? `${rev}^` : null; n = rev ?? null; }
    return { oldRev: added ? null : o, newRev: removed ? null : n, oldPath: diff.oldPath ?? diff.path, newPath: diff.path };
  }, [diff, revs, context, rev]);

  const tbtn = "flex items-center gap-1 rounded px-1.5 py-0.5 text-gray-400 hover:bg-elev hover:text-amber disabled:opacity-40";
  const canEdit = editable && !diff.status.startsWith("D") && !isImage(diff.path);
  const canView = !diff.status.startsWith("D") && !isImage(diff.path) || (diff.path.toLowerCase().endsWith(".svg"));

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1 text-xs">
        <span className="min-w-0 max-w-[40%] truncate font-mono text-gray-300" title={diff.path}>{diff.path}</span>
        <span className="text-git-added">+{diff.additions}</span>
        <span className="text-git-deleted">-{diff.deletions}</span>
        <span className="flex-1" />
        {selCount > 0 && editable && body === "diff" && mode === "hunk" && (
          <button className="rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover" onClick={() => doLines(context === "staged" ? "unstage" : "stage")}>
            {context === "staged" ? "Unstage" : "Stage"} Selected Lines ({selCount})
          </button>
        )}
        {body === "edit" && (
          <button disabled={!dirty} onClick={() => void save(docGetter.current?.() ?? "")}
            className="flex items-center gap-1 rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover disabled:opacity-40" title="⌘S">
            <Save size={12} /> Guardar{dirty ? " *" : ""}
          </button>
        )}
        {body === "diff" && !showImage && (
          <>
            <label className="flex cursor-pointer items-center gap-1 text-gray-400">
              <input type="checkbox" className="accent-amber" checked={ignoreWhitespace} onChange={(e) => prefs.set({ ignoreWhitespace: e.target.checked })} />
              Whitespace
            </label>
            <label className="flex cursor-pointer items-center gap-1 text-gray-400" title="Resalta las palabras cambiadas (vista Hunk)">
              <input type="checkbox" className="accent-amber" checked={wordDiff} onChange={(e) => prefs.set({ wordDiff: e.target.checked })} />
              Word diff
            </label>
            <select value={String(ctxSize)} onChange={(e) => prefs.set({ context: (e.target.value === "full" ? "full" : Number(e.target.value)) as ContextSize })}
              className="rounded border border-line bg-app px-1 py-0.5 text-gray-300" title="Líneas de contexto">
              {CONTEXTS.map((c) => <option key={c.v} value={String(c.v)}>{c.l}</option>)}
            </select>
            <button title="Cambio anterior" className={tbtn} onClick={() => jump(-1)}><ChevronUp size={14} /></button>
            <button title="Cambio siguiente" className={tbtn} onClick={() => jump(1)}><ChevronDown size={14} /></button>
            <span className="text-gray-500">{total > 0 ? `${Math.min(cur + 1, total)}/${total}` : "0/0"}</span>
            <div className="flex overflow-hidden rounded border border-line">
              {([["hunk", "Hunk", Text], ["inline", "Inline", Rows2], ["split", "Split", Columns2]] as [DiffMode, string, typeof Text][]).map(([m, l, Icon]) => (
                <button key={m} onClick={() => prefs.set({ mode: m })} title={l}
                  className={`flex items-center gap-1 px-2 py-0.5 ${mode === m ? "bg-elev text-amber" : "text-gray-400"}`}><Icon size={12} />{l}</button>
              ))}
            </div>
          </>
        )}
        {diff.path.toLowerCase().endsWith(".svg") && body === "diff" && (
          <button className={tbtn} onClick={() => setSvgText((v) => !v)}>{svgText ? "Imagen" : "Texto"}</button>
        )}
        {body === "diff" && canView && <button className={tbtn} onClick={() => void loadFile("file")}><Eye size={12} /> View file</button>}
        {body === "diff" && canEdit && <button className={tbtn} onClick={() => void loadFile("edit")}><Pencil size={12} /> Edit</button>}
        {body !== "diff" && <button className={tbtn} onClick={() => void closeBody()}>Volver al diff</button>}
        {onClose && <button title="Cerrar (Esc)" className={tbtn} onClick={onClose}><X size={13} /></button>}
      </div>
      {body !== "diff" ? (
        fileText === null ? <DiffSkeleton /> : (
          <div data-edit-host className="flex min-h-0 flex-1 flex-col">
            <CodeView path={diff.path} text={fileText} editable={body === "edit"} onSave={(c) => void save(c)}
              onDirty={(d) => setDirty(d)} getDoc={docGetter} />
          </div>
        )
      ) : showImage ? (
        <div className="min-h-0 flex-1"><ImageDiff revs={imageRevs} /></div>
      ) : diff.binary ? (
        <EmptyState art="diff" title="Archivo binario" hint="Sin vista de diff para este tipo de archivo." />
      ) : diff.hunks.length === 0 ? (
        <EmptyState art="diff" title="Sin cambios que mostrar" />
      ) : (
        <div ref={host} className="min-h-0 flex-1 overflow-auto" />
      )}
    </div>
  );
}
