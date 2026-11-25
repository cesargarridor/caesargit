import { cv, laneVar } from "../../lib/themes";
import { EmptyState } from "../layout/Visuals";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import {
  EditorState,
  Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { MergeView, goToNextChunk, goToPreviousChunk, getChunks } from "@codemirror/merge";
import { syntaxHighlighting, HighlightStyle, StreamLanguage } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { java } from "@codemirror/lang-java";
import { ChevronDown, ChevronUp, Columns2, Rows2 } from "lucide-react";
import type { DiffFile, HunkAction } from "../../types/git";

/* ---------- tema Graphite & Amber + lenguajes (compartido con merge/) ---------- */

export const graphiteTheme: Extension = EditorView.theme(
  {
    "&": { backgroundColor: cv("app"), color: cv("text"), fontSize: "12px", height: "100%" },
    ".cm-scroller": {
      fontFamily: '"JetBrains Mono","Fira Code",ui-monospace,monospace',
      fontVariantLigatures: "contextual",
      lineHeight: "1.55",
    },
    ".cm-content": { caretColor: cv("accent") },
    ".cm-cursor": { borderLeftColor: cv("accent") },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { backgroundColor: cv("panel"), color: cv("gray-500"), border: "none", borderRight: `1px solid ${cv("line")}` },
    ".cm-activeLine": { backgroundColor: cv("accent", .06) },
    ".cm-activeLineGutter": { backgroundColor: cv("accent", .10) },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: cv("accent", .22) + " !important" },
    ".cm-changedLine": { backgroundColor: cv("git-added", .10) },
    ".cm-deletedChunk": { backgroundColor: cv("git-deleted", .10) },
    ".cm-changedText": { backgroundColor: cv("git-added", .28) },
    ".cm-deletedChunk .cm-deletedText": { backgroundColor: cv("git-deleted", .30) },
    ".cm-merge-a .cm-changedLine, .cm-merge-a .cm-deletedLine": { backgroundColor: cv("git-deleted", .10) },
    ".cm-merge-b .cm-changedLine, .cm-merge-b .cm-insertedLine": { backgroundColor: cv("git-added", .10) },
    ".cm-collapsedLines": { backgroundColor: cv("elev"), color: cv("gray-400") },
    ".cm-d-add": { backgroundColor: cv("git-added", .12) },
    ".cm-d-del": { backgroundColor: cv("git-deleted", .12) },
    ".cm-d-hunk": { backgroundColor: cv("elev"), color: cv("accent"), borderTop: `1px solid ${cv("line")}` },
    ".cm-d-sel": { boxShadow: `inset 2px 0 0 ${cv("accent")}` },
    ".cm-ln": { minWidth: "34px", textAlign: "right", padding: "0 4px", fontSize: "10px" },
    ".cm-pick": { cursor: "pointer", width: "14px", textAlign: "center", color: cv("gray-500") },
    ".cm-pick.on": { color: cv("accent") },
    ".cm-hunk-btns button": {
      marginLeft: "6px", padding: "0 6px", border: `1px solid ${cv("line")}`, borderRadius: "4px",
      background: cv("panel"), color: cv("text"), fontSize: "11px", cursor: "pointer",
    },
    ".cm-hunk-btns button:hover": { borderColor: cv("accent"), color: cv("accent") },
    ".cm-hunk-btns": { float: "right" },
  },
  { dark: true },
);

const hl = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: cv("accent") },
  { tag: [t.string, t.special(t.string)], color: cv("git-added") },
  { tag: [t.number, t.bool, t.null], color: laneVar(3) },
  { tag: [t.comment, t.lineComment, t.blockComment], color: cv("gray-500"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.propertyName], color: cv("git-renamed") },
  { tag: [t.typeName, t.className, t.tagName], color: cv("git-modified") },
  { tag: [t.definition(t.variableName)], color: cv("text") },
  { tag: [t.operator, t.punctuation], color: cv("gray-400") },
]);
export const graphiteHighlight: Extension = syntaxHighlighting(hl);

export function langFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return javascript({ jsx: true });
    case "ts": case "tsx": return javascript({ jsx: true, typescript: true });
    case "rs": return rust();
    case "py": return python();
    case "json": return json();
    case "html": case "htm": case "vue": return html();
    case "css": case "scss": return css();
    case "md": case "markdown": return markdown();
    case "sql": return sql();
    case "java": return java();
    default: return StreamLanguage.define({ token: (s) => { s.skipToEnd(); return null; } });
  }
}

/* ---------- tipos ---------- */

export type DiffContext = "unstaged" | "staged" | "commit";

interface Props {
  diff: DiffFile;
  context: DiffContext;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: (v: boolean) => void;
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

/* ---------- componente ---------- */

export default function DiffViewer(props: Props) {
  const { diff, context, ignoreWhitespace, onIgnoreWhitespace } = props;
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [cur, setCur] = useState(0);
  const [selCount, setSelCount] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const selHunk = useRef<number | null>(null);
  const hunkStarts = useRef<number[]>([]); // línea (1-based) de cada cabecera
  const editable = context !== "commit";

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

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = "";
    viewRef.current = null;
    mergeRef.current = null;
    selHunk.current = null;
    setSelCount(0);
    setCur(0);
    if (diff.binary || diff.hunks.length === 0) return;
    const base = [graphiteTheme, graphiteHighlight, langFor(diff.path), EditorState.readOnly.of(true), EditorView.editable.of(false)];

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
      return () => { mv.destroy(); mergeRef.current = null; };
    }

    const decos = (state: EditorState): DecorationSet => {
      const b = new RangeSetBuilder<Decoration>();
      const sel = state.field(selField);
      for (let n = 1; n <= state.doc.lines; n++) {
        const r = built.refs[n - 1];
        const h = diff.hunks[r.hunk];
        const pos = state.doc.line(n).from;
        if (r.idx < 0) {
          b.add(pos, pos, Decoration.line({ class: "cm-d-hunk" }));
          if (editable && propsRef.current.onHunkAction) {
            const btns: { label: string; action: HunkAction }[] =
              context === "unstaged"
                ? [{ label: "Stage Hunk", action: "stage" }, { label: "Discard Hunk", action: "discard" }]
                : [{ label: "Unstage Hunk", action: "unstage" }];
            b.add(state.doc.line(n).to, state.doc.line(n).to,
              Decoration.widget({ widget: new HunkBtns(r.hunk, btns, (hi, a) => propsRef.current.onHunkAction?.(hi, a)), side: 1 }));
          }
        } else {
          const k = h.lines[r.idx].kind;
          const cls = (k === "add" ? "cm-d-add" : k === "del" ? "cm-d-del" : "") + (sel.has(n) ? " cm-d-sel" : "");
          if (cls.trim()) b.add(pos, pos, Decoration.line({ class: cls }));
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
        extensions: [selField, decoField, pickGutter, numGutter, graphiteTheme, graphiteHighlight, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [diff, mode, built, context, editable]);

  const total = diff.hunks.length;

  const jump = (dir: 1 | -1) => {
    if (mode === "split") {
      const mv = mergeRef.current;
      if (!mv) return;
      (dir === 1 ? goToNextChunk : goToPreviousChunk)(mv.b);
      const chunks = getChunks(mv.b.state)?.chunks.length ?? 0;
      setCur((c) => Math.max(0, Math.min(Math.max(chunks - 1, 0), c + dir)));
      return;
    }
    const v = viewRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min(total - 1, cur + dir));
    const ln = hunkStarts.current[next];
    if (!ln) return;
    const pos = v.state.doc.line(ln).from;
    v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 4 }) });
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1 text-xs">
        <span className="truncate font-mono text-gray-300" title={diff.path}>{diff.path}</span>
        <span className="text-git-added">+{diff.additions}</span>
        <span className="text-git-deleted">-{diff.deletions}</span>
        <span className="flex-1" />
        {selCount > 0 && editable && (
          <>
            {context === "unstaged" && (
              <button className="rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover" onClick={() => doLines("stage")}>
                Stage Selected Lines ({selCount})
              </button>
            )}
            {context === "staged" && (
              <button className="rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover" onClick={() => doLines("unstage")}>
                Unstage Selected Lines ({selCount})
              </button>
            )}
          </>
        )}
        <label className="flex cursor-pointer items-center gap-1 text-gray-400">
          <input type="checkbox" className="accent-amber" checked={ignoreWhitespace} onChange={(e) => onIgnoreWhitespace(e.target.checked)} />
          Ignorar espacios (-w)
        </label>
        <button title="Hunk anterior" className="rounded p-1 text-gray-400 hover:bg-elev hover:text-amber" onClick={() => jump(-1)}><ChevronUp size={14} /></button>
        <button title="Hunk siguiente" className="rounded p-1 text-gray-400 hover:bg-elev hover:text-amber" onClick={() => jump(1)}><ChevronDown size={14} /></button>
        <span className="text-gray-500">{total > 0 ? `${Math.min(cur + 1, total)}/${total}` : "0/0"}</span>
        <div className="flex overflow-hidden rounded border border-line">
          <button className={`px-2 py-0.5 ${mode === "unified" ? "bg-elev text-amber" : "text-gray-400"}`} onClick={() => setMode("unified")} title="Unified"><Rows2 size={13} /></button>
          <button className={`px-2 py-0.5 ${mode === "split" ? "bg-elev text-amber" : "text-gray-400"}`} onClick={() => setMode("split")} title="Split"><Columns2 size={13} /></button>
        </div>
      </div>
      {diff.binary ? (
        <EmptyState art="diff" title="Archivo binario" hint="Sin vista de diff." />
      ) : total === 0 ? (
        <EmptyState art="diff" title="Sin cambios que mostrar" />
      ) : (
        <div ref={host} className="min-h-0 flex-1 overflow-auto" />
      )}
    </div>
  );
}
