import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, List, ListTree } from "lucide-react";
import { useDiffPrefs, type FileView } from "./fileUtils";

interface DirNode<T> { kind: "dir"; name: string; path: string; children: Node<T>[]; files: T[] }
interface LeafNode<T> { kind: "file"; item: T; name: string }
type Node<T> = DirNode<T> | LeafNode<T>;

function build<T extends { path: string }>(items: T[]): Node<T>[] {
  const root: DirNode<T> = { kind: "dir", name: "", path: "", children: [], files: [] };
  for (const it of items) {
    const parts = it.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let d = cur.children.find((c): c is DirNode<T> => c.kind === "dir" && c.path === p);
      if (!d) { d = { kind: "dir", name: parts[i], path: p, children: [], files: [] }; cur.children.push(d); }
      d.files.push(it);
      cur = d;
    }
    cur.children.push({ kind: "file", item: it, name: parts[parts.length - 1] });
  }
  const sort = (n: DirNode<T>) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    n.children.forEach((c) => c.kind === "dir" && sort(c));
  };
  sort(root);
  // compacta cadenas de directorios con un único hijo directorio: a/b/c
  const compact = (n: Node<T>): Node<T> => {
    if (n.kind === "file") return n;
    let d: DirNode<T> = n;
    d.children = d.children.map(compact);
    while (d.children.length === 1) {
      const only = d.children[0];
      if (only.kind !== "dir") break;
      d = { ...only, name: `${d.name}/${only.name}` };
    }
    return d;
  };
  return root.children.map(compact);
}

/** Orden de visualización de los archivos (útil para selección con Shift). */
export function orderedFiles<T extends { path: string }>(items: T[], view: FileView): T[] {
  if (view === "path") return items;
  const out: T[] = [];
  const walk = (ns: Node<T>[]) => ns.forEach((n) => (n.kind === "file" ? out.push(n.item) : walk(n.children)));
  walk(build(items));
  return out;
}

export function ViewToggle({ className = "" }: { className?: string }) {
  const fileView = useDiffPrefs((s) => s.fileView);
  const set = useDiffPrefs((s) => s.set);
  const b = (v: FileView, Icon: typeof List, label: string) => (
    <button onClick={() => set({ fileView: v })} title={label}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] normal-case ${fileView === v ? "bg-elev text-amber" : "text-gray-400 hover:text-gray-200"}`}>
      <Icon size={11} /> {label}
    </button>
  );
  return (
    <div className={`flex overflow-hidden rounded border border-line ${className}`}>
      {b("path", List, "Path")}
      {b("tree", ListTree, "Tree")}
    </div>
  );
}

interface Props<T extends { path: string }> {
  items: T[];
  view: FileView;
  /** fila de archivo; `label` = nombre mostrable (ruta completa en Path, nombre en Tree) */
  renderFile: (item: T, ctx: { depth: number; tree: boolean }) => React.ReactNode;
  /** acciones opcionales en la fila de carpeta (p. ej. stage carpeta) */
  renderDirActions?: (dirPath: string, files: T[]) => React.ReactNode;
  /** claves de plegado independientes entre listas */
  id?: string;
}

export function FileList<T extends { path: string }>({ items, view, renderFile, renderDirActions, id = "" }: Props<T>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = useMemo(() => (view === "tree" ? build(items) : []), [items, view]);
  if (view === "path") return <>{items.map((it) => renderFile(it, { depth: 0, tree: false }))}</>;
  const toggle = (k: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const rec = (ns: Node<T>[], depth: number): React.ReactNode =>
    ns.map((n) => {
      if (n.kind === "file") return renderFile(n.item, { depth, tree: true });
      const key = id + ":" + n.path;
      const closed = collapsed.has(key);
      return (
        <div key={key}>
          <div onClick={() => toggle(key)} style={{ paddingLeft: 8 + depth * 12 }}
            className="group flex cursor-pointer items-center gap-1 py-[3px] pr-2 text-xs text-gray-400 hover:bg-elev">
            {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <Folder size={12} className="text-amber" />
            <span className="min-w-0 flex-1 truncate" title={n.path}>{n.name}</span>
            <span className="hidden group-hover:flex">{renderDirActions?.(n.path, n.files)}</span>
            <span className="text-[10px] text-gray-500">{n.files.length}</span>
          </div>
          {!closed && rec(n.children, depth + 1)}
        </div>
      );
    });
  return <>{rec(nodes, 0)}</>;
}
