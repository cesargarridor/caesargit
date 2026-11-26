import type { GraphColumn, GraphColumnId } from "../types/git";
import { DEFAULT_COLUMNS } from "./usePrefs";

/** Metadatos de columnas del grafo. La persistencia por repo vive en el store (repoPrefs.columns). */
export const COLUMN_LABEL: Record<GraphColumnId, string> = {
  ref: "BRANCH / TAG", graph: "GRAPH", message: "COMMIT MESSAGE", author: "AUTHOR", date: "DATE", sha: "SHA",
};
export const COLUMN_MIN: Record<GraphColumnId, number> = { ref: 80, graph: 40, message: 160, author: 70, date: 56, sha: 56 };

/** Normaliza lo guardado: añade columnas que falten, descarta duplicadas/desconocidas; GRAPH siempre visible. */
export function normalizeColumns(cols: GraphColumn[] | undefined): GraphColumn[] {
  const seen = new Set<GraphColumnId>();
  const out: GraphColumn[] = [];
  for (const c of cols ?? []) {
    const def = DEFAULT_COLUMNS.find((d) => d.id === c.id);
    if (!def || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, visible: c.id === "graph" ? true : !!c.visible, width: Math.max(COLUMN_MIN[c.id], c.width || def.width) });
  }
  for (const d of DEFAULT_COLUMNS) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}
