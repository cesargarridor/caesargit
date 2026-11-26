import { useEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
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
import { cv, laneVar } from "../../lib/themes";

/** ¿El tema real (claro/oscuro) aplicado ahora mismo es oscuro? */
export function isDarkNow(): boolean {
  const root = document.documentElement;
  const cs = root.style.colorScheme || getComputedStyle(root).colorScheme;
  return !cs.includes("light");
}

/** Hook: devuelve el flag dark y se actualiza al cambiar el tema (data-theme / color-scheme). */
export function useEditorDark(): boolean {
  const [dark, setDark] = useState(isDarkNow);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDarkNow()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** Tema CodeMirror basado en las variables CSS del tema; `dark` sigue al tema real. */
export function graphiteTheme(dark: boolean): Extension {
  return EditorView.theme(
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
      ".cm-activeLine": { backgroundColor: cv("accent", 0.06) },
      ".cm-activeLineGutter": { backgroundColor: cv("accent", 0.1) },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: cv("accent", 0.22) + " !important" },
      ".cm-changedLine": { backgroundColor: cv("git-added", 0.1) },
      ".cm-deletedChunk": { backgroundColor: cv("git-deleted", 0.1) },
      ".cm-changedText": { backgroundColor: cv("git-added", 0.28) },
      ".cm-deletedChunk .cm-deletedText": { backgroundColor: cv("git-deleted", 0.3) },
      ".cm-merge-a .cm-changedLine, .cm-merge-a .cm-deletedLine": { backgroundColor: cv("git-deleted", 0.1) },
      ".cm-merge-b .cm-changedLine, .cm-merge-b .cm-insertedLine": { backgroundColor: cv("git-added", 0.1) },
      ".cm-collapsedLines": { backgroundColor: cv("elev"), color: cv("gray-400") },
      ".cm-d-add": { backgroundColor: cv("git-added", 0.12) },
      ".cm-d-del": { backgroundColor: cv("git-deleted", 0.12) },
      ".cm-w-add": { backgroundColor: cv("git-added", 0.38), borderRadius: "2px" },
      ".cm-w-del": { backgroundColor: cv("git-deleted", 0.38), borderRadius: "2px" },
      ".cm-d-hunk": { backgroundColor: cv("elev"), color: cv("accent"), borderTop: `1px solid ${cv("line")}` },
      ".cm-d-sel": { boxShadow: `inset 2px 0 0 ${cv("accent")}` },
      ".cm-d-cur": { outline: `1px solid ${cv("accent", 0.5)}`, outlineOffset: "-1px" },
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
    { dark },
  );
}

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
    case "html": case "htm": case "vue": case "svg": return html();
    case "css": case "scss": return css();
    case "md": case "markdown": return markdown();
    case "sql": return sql();
    case "java": return java();
    default: return StreamLanguage.define({ token: (s) => { s.skipToEnd(); return null; } });
  }
}
