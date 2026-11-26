import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GitMerge, Maximize2, Minimize2, Minus, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { DiffFile, FileChange, HunkAction } from "../../types/git";
import DiffViewer from "./DiffViewer";
import CommitBox from "./CommitBox";
import FileFinder from "./FileFinder";
import { FileHistoryModal } from "./FileHistoryModal";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { FileList, ViewToggle, orderedFiles } from "./FileTree";
import { baseName, copyText, diffArgs, extOf, inEditable, statusColor, useDiffPrefs } from "./fileUtils";

export { statusColor } from "./fileUtils";

const OP_LABEL: Record<string, string> = {
  merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert",
};

/** Banner de operación en curso (merge/rebase/cherry-pick/revert) con Continue / Abort / Skip. */
export function OperationBanner() {
  const op = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.status?.operation ?? null);
  const conflicts = useRepoStore(
    (s) => s.tabs.find((t) => t.info.id === s.activeId)?.status?.files.filter((f) => f.conflicted).length ?? 0,
  );
  const act = useRepoStore((s) => s.act);
  const confirm = useRepoStore((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  if (!op) return null;
  const label = OP_LABEL[op] ?? op;
  const go = async (cmd: "op_abort" | "op_continue" | "op_skip") => {
    if (cmd === "op_abort") {
      const ok = await confirm({
        title: `Abortar ${label}`,
        message: `Se cancelará el ${label.toLowerCase()} en curso y se descartará su progreso.`,
        confirmLabel: "Abortar",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    await act(cmd);
    setBusy(false);
  };
  const b = "rounded border border-line px-2 py-0.5 text-gray-300 disabled:opacity-50";
  return (
    <div className="flex items-center gap-2 border-b border-amber/40 bg-amber/10 px-3 py-2 text-xs">
      <GitMerge size={14} className="shrink-0 text-amber" />
      <span className="flex-1 text-amber">
        {label} en curso{conflicts > 0 ? ` · ${conflicts} conflicto${conflicts === 1 ? "" : "s"}` : ""}
      </span>
      <button disabled={busy} onClick={() => go("op_abort")} className={`${b} hover:border-git-deleted hover:text-git-deleted`}>Abort</button>
      {op !== "merge" && (
        <button disabled={busy} onClick={() => go("op_skip")} title="Omite este paso (--skip)" className={`${b} hover:border-amber hover:text-amber`}>Skip</button>
      )}
      <button disabled={busy || conflicts > 0} onClick={() => go("op_continue")} title={conflicts > 0 ? "Resuelve los conflictos primero" : ""} className="rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover disabled:opacity-40">
        Continue
      </button>
    </div>
  );
}

const keyOf = (staged: boolean, path: string) => (staged ? "s:" : "u:") + path;
const isUntracked = (f: FileChange) => f.worktree === "?" || f.index === "?";

interface RowProps {
  f: FileChange;
  staged: boolean;
  selected: boolean;
  active: boolean;
  depth: number;
  tree: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onDiscard?: () => void;
  onMenu: (e: React.MouseEvent) => void;
}

function FileRow({ f, staged, selected, active, depth, tree, onClick, onToggle, onDiscard, onMenu }: RowProps) {
  const ch = staged ? f.index : f.worktree;
  const { dir, name } = baseName(f.path);
  return (
    <div
      onClick={onClick}
      onContextMenu={onMenu}
      style={tree ? { paddingLeft: 8 + depth * 12 } : undefined}
      className={`group relative flex cursor-pointer select-none items-center gap-2 py-[3px] pr-2 text-xs hover:bg-elev ${tree ? "" : "pl-2"} ${selected ? "bg-amber/15" : ""} ${active ? "shadow-glow" : ""}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono font-bold ${statusColor(ch)}`}>{ch === " " ? "·" : ch}</span>
      <span className="min-w-0 flex-1 truncate" title={f.path}>
        {!tree && <span className="text-gray-500">{dir}</span>}
        <span className="text-gray-200">{name}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button title={staged ? "Unstage" : "Stage"} onClick={(e) => { e.stopPropagation(); onToggle(); }} className="rounded p-0.5 text-gray-400 hover:text-amber">
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        {onDiscard && (
          <button title="Discard" onClick={(e) => { e.stopPropagation(); onDiscard(); }} className="rounded p-0.5 text-gray-400 hover:text-git-deleted">
            <RotateCcw size={13} />
          </button>
        )}
        <button title="Más" onClick={onMenu} className="rounded p-0.5 text-gray-400 hover:text-amber">
          <MoreHorizontal size={13} />
        </button>
      </span>
    </div>
  );
}

function SectionHeader(props: { title: string; count: number; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-line bg-panel px-2 py-1 text-[11px] font-semibold tracking-wide text-gray-400">
      <span>{props.title} ({props.count})</span>
      <span className="flex-1" />
      {props.children}
    </div>
  );
}

const EDITORS = ["code", "cursor", "windsurf", "zed", "subl", "idea", "webstorm", "pycharm"];
const EDITOR_LABEL: Record<string, string> = {
  code: "VS Code", cursor: "Cursor", windsurf: "Windsurf", zed: "Zed", subl: "Sublime Text", idea: "IntelliJ IDEA", webstorm: "WebStorm", pycharm: "PyCharm",
};

type MenuTarget = { f: FileChange; staged: boolean };

export default function WipPanel() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const act = useRepoStore((s) => s.act);
  const run = useRepoStore((s) => s.run);
  const ask = useRepoStore((s) => s.ask);
  const confirm = useRepoStore((s) => s.confirm);
  const setModal = useRepoStore((s) => s.setModal);
  const prefs = useDiffPrefs();
  const fileView = prefs.fileView;
  const ctxMenu = useContextMenu<MenuTarget>();

  const files = tab?.status?.files ?? [];
  const repoPath = tab?.info.path ?? "";
  const conflicted = useMemo(() => files.filter((f) => f.conflicted), [files]);
  const unstaged = useMemo(() => files.filter((f) => f.unstaged && !f.conflicted), [files]);
  const staged = useMemo(() => files.filter((f) => f.staged && !f.conflicted), [files]);
  const uOrder = useMemo(() => orderedFiles(unstaged, fileView), [unstaged, fileView]);
  const sOrder = useMemo(() => orderedFiles(staged, fileView), [staged, fileView]);

  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [big, setBig] = useState(false);
  const [history, setHistory] = useState<string | null>(null);

  // limpiar selección de archivos que ya no existen en su lista
  useEffect(() => {
    setMulti((m) => {
      const next = new Set([...m].filter((k) => (k.startsWith("s:") ? staged : unstaged).some((f) => f.path === k.slice(2))));
      return next.size === m.size ? m : next;
    });
    if (!sel) return;
    const list = sel.staged ? staged : unstaged;
    if (!list.some((f) => f.path === sel.path)) { setSel(null); setDiff(null); }
  }, [sel, staged, unstaged]);

  const status = tab?.status;
  const hasTab = tab !== null;
  useEffect(() => {
    if (!sel || !hasTab) return;
    let live = true;
    run<DiffFile>("get_file_diff", { path: sel.path, staged: sel.staged, ...diffArgs(prefs) })
      .then((d) => { if (live) setDiff(d); })
      .catch(() => { if (live) setDiff(null); });
    return () => { live = false; };
    // status cambia tras cada operación: recarga el diff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, prefs.ignoreWhitespace, prefs.context, prefs.wordDiff, status, run, hasTab]);

  /* ---------- acciones ---------- */
  const doStage = (paths: string[]) => act("stage_paths", { paths });
  const doUnstage = (paths: string[]) => act("unstage_paths", { paths });
  const doDiscard = async (fs: FileChange[]) => {
    if (fs.length === 0) return;
    const ok = await confirm({
      title: "Descartar cambios",
      message: fs.length === 1 ? `Se perderán los cambios de ${fs[0].path}. No se puede deshacer.` : `Se perderán los cambios de ${fs.length} archivos. No se puede deshacer.`,
      confirmLabel: fs.length === 1 ? "Descartar" : `Descartar ${fs.length} archivos`,
      danger: true,
    });
    if (!ok) return;
    const tracked = fs.filter((f) => !isUntracked(f)).map((f) => f.path);
    const untracked = fs.filter(isUntracked).map((f) => f.path);
    if (tracked.length) await act("discard_paths", { paths: tracked });
    if (untracked.length) await act("clean_untracked", { paths: untracked });
  };
  const discardAll = async () => {
    const ok = await confirm({
      title: "Descartar todo",
      message: `Se perderán todos los cambios sin commitear (${unstaged.length} archivos). No se puede deshacer.`,
      confirmLabel: "Descartar todo",
      danger: true,
    });
    if (ok) await act("discard_all");
  };
  const cleanUntracked = async () => {
    const n = unstaged.filter(isUntracked).length;
    const ok = await confirm({
      title: "Limpiar archivos sin seguimiento",
      message: `Se borrarán del disco ${n} archivo${n === 1 ? "" : "s"} sin seguimiento (no ignorados). Se puede deshacer con Undo.`,
      confirmLabel: "Borrar",
      danger: true,
    });
    if (ok) await act("clean_untracked", {});
  };
  const stashFiles = async (paths: string[]) => {
    const r = await ask({
      title: paths.length === 1 ? "Stash file" : `Stash ${paths.length} files`,
      fields: [{ key: "message", label: "Mensaje (opcional)", optional: true }],
      confirmLabel: "Stash",
    });
    if (r) await act("stash_push", { message: r.message?.trim() || undefined, untracked: true, paths });
  };

  /* ---------- selección (Shift/Ctrl) ---------- */
  const onRowClick = (f: FileChange, isStaged: boolean, e: React.MouseEvent) => {
    const k = keyOf(isStaged, f.path);
    if (e.shiftKey && anchor.current && anchor.current.startsWith(isStaged ? "s:" : "u:")) {
      const order = (isStaged ? sOrder : uOrder).map((x) => x.path);
      const a = order.indexOf(anchor.current.slice(2));
      const b = order.indexOf(f.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setMulti(new Set(order.slice(lo, hi + 1).map((p) => keyOf(isStaged, p))));
        setSel({ path: f.path, staged: isStaged });
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setMulti((m) => { const n = new Set(m); if (n.has(k)) n.delete(k); else n.add(k); return n; });
      anchor.current = k;
      setSel({ path: f.path, staged: isStaged });
      return;
    }
    anchor.current = k;
    setMulti(new Set([k]));
    setSel({ path: f.path, staged: isStaged });
  };

  const selected = useMemo(() => {
    const keys = multi.size > 0 ? multi : sel ? new Set([keyOf(sel.staged, sel.path)]) : new Set<string>();
    return {
      u: unstaged.filter((f) => keys.has(keyOf(false, f.path))),
      s: staged.filter((f) => keys.has(keyOf(true, f.path))),
    };
  }, [multi, sel, unstaged, staged]);
  const selCount = selected.u.length + selected.s.length;

  // atajos S / U sobre el/los archivos seleccionados (fuera de inputs)
  const kb = useRef({ selected, doStage, doUnstage });
  kb.current = { selected, doStage, doUnstage };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || inEditable(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== "s" && k !== "u") return;
      const { selected: s } = kb.current;
      if (k === "s" && s.u.length) { e.preventDefault(); void kb.current.doStage(s.u.map((f) => f.path)); }
      else if (k === "u" && s.s.length) { e.preventDefault(); void kb.current.doUnstage(s.s.map((f) => f.path)); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ---------- menú contextual ---------- */
  const ignoreItems = (path: string): MenuItem[] => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    const ext = extOf(path);
    const pair = (kind: "file" | "folder" | "extension"): MenuItem[] => [
      { label: ".gitignore", onClick: () => void act("ignore_pattern", { path, kind, target: "gitignore" }) },
      { label: "Solo local (.git/info/exclude)", onClick: () => void act("ignore_pattern", { path, kind, target: "local" }) },
    ];
    const items: MenuItem[] = [{ label: "This file", children: pair("file") }];
    if (dir) items.push({ label: `This folder (${dir}/)`, children: pair("folder") });
    if (ext) items.push({ label: `This extension (*.${ext})`, children: pair("extension") });
    return items;
  };

  const menuItems = ({ f, staged: isStaged }: MenuTarget): MenuItem[] => {
    const inSel = multi.has(keyOf(isStaged, f.path));
    if (!f.conflicted && multi.size > 1 && inSel) {
      const us = selected.u;
      const ss = selected.s;
      const all = [...us, ...ss];
      const items: MenuItem[] = [];
      if (us.length) items.push({ label: `Stage ${us.length} files`, onClick: () => void doStage(us.map((x) => x.path)) });
      if (ss.length) items.push({ label: `Unstage ${ss.length} files`, onClick: () => void doUnstage(ss.map((x) => x.path)) });
      if (us.length) items.push({ label: `Discard ${us.length} files`, danger: true, onClick: () => void doDiscard(us) });
      items.push({ label: `Stash ${all.length} files`, onClick: () => void stashFiles(all.map((x) => x.path)) });
      items.push({ sep: true }, { label: "Copy paths", onClick: () => copyText(all.map((x) => x.path).join("\n")) });
      return items;
    }
    const p = f.path;
    const items: MenuItem[] = [];
    if (f.conflicted) {
      items.push(
        { label: "Resolve…", onClick: () => setModal({ kind: "conflict", path: p }) },
        { label: "Resolve using Ours (Current)", onClick: () => void act("resolve_with_side", { path: p, side: "ours" }) },
        { label: "Resolve using Theirs (Incoming)", onClick: () => void act("resolve_with_side", { path: p, side: "theirs" }) },
        { sep: true },
      );
    } else {
      items.push(
        isStaged
          ? { label: "Unstage file", hint: "U", onClick: () => void doUnstage([p]) }
          : { label: "Stage file", hint: "S", onClick: () => void doStage([p]) },
      );
      if (!isStaged) items.push({ label: isUntracked(f) ? "Delete file (clean)" : "Discard changes", danger: true, onClick: () => void doDiscard([f]) });
      items.push({ label: "Stash file", onClick: () => void stashFiles([p]) });
      items.push({ label: "Ignore", children: ignoreItems(p) }, { sep: true });
    }
    items.push(
      { label: "File history", onClick: () => setHistory(p) },
      { label: "Blame", onClick: () => setModal({ kind: "blame", path: p }) },
      { sep: true },
      { label: "Open in default program", onClick: () => void act("open_in_editor", { path: p }) },
      { label: "Open in external diff tool", disabled: isUntracked(f), onClick: () => void act("run_difftool", { path: p, staged: isStaged }) },
      { label: "Open in editor", children: EDITORS.map((ed) => ({ label: EDITOR_LABEL[ed], onClick: () => void act("open_in_editor", { path: p, editor: ed }) })) },
      { label: "Show in folder", onClick: () => void act("reveal_in_file_manager", { path: p }) },
      { sep: true },
      { label: "Copy file path", onClick: () => copyText(p) },
      { label: "Copy full path", onClick: () => copyText(`${repoPath.replace(/[\\/]$/, "")}/${p}`) },
    );
    return items;
  };

  const onHunk = useCallback(
    async (hunkIndex: number, action: HunkAction) => {
      if (!sel) return;
      if (action === "discard") {
        const ok = await confirm({ title: "Descartar hunk", message: "Se perderán los cambios de este bloque.", confirmLabel: "Descartar", danger: true });
        if (!ok) return;
      }
      await act("apply_hunk", { path: sel.path, staged: sel.staged, hunkIndex, action, ignoreWhitespace: prefs.ignoreWhitespace });
    },
    [sel, prefs.ignoreWhitespace, act, confirm],
  );
  const onLines = useCallback(
    async (hunkIndex: number, lineIndices: number[], action: "stage" | "unstage") => {
      if (!sel) return;
      await act("apply_lines", { path: sel.path, hunkIndex, lineIndices, action });
    },
    [sel, act],
  );

  if (!tab) return <div className="p-4 text-sm text-gray-500">Sin repositorio activo.</div>;

  const diffPane = sel && diff && (
    <div className={big ? "fixed inset-4 z-50 flex flex-col rounded-lg border border-line bg-app shadow-2xl animate-pop-in" : "flex h-[45%] min-h-[160px] flex-col border-t border-line"}>
      <div className="flex shrink-0 items-center justify-end gap-1 bg-panel px-2 py-0.5">
        <button title={big ? "Reducir" : "Ampliar"} onClick={() => setBig((b) => !b)} className="rounded p-1 text-gray-400 hover:text-amber">
          {big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffViewer
          diff={diff}
          context={sel.staged ? "staged" : "unstaged"}
          onClose={() => { setSel(null); setDiff(null); setBig(false); setMulti(new Set()); }}
          onHunkAction={onHunk}
          onLinesAction={onLines}
        />
      </div>
    </div>
  );

  const renderRow = (f: FileChange, isStaged: boolean, ctx: { depth: number; tree: boolean }) => (
    <FileRow
      key={keyOf(isStaged, f.path)}
      f={f} staged={isStaged} depth={ctx.depth} tree={ctx.tree}
      selected={multi.has(keyOf(isStaged, f.path))}
      active={sel?.path === f.path && sel.staged === isStaged}
      onClick={(e) => onRowClick(f, isStaged, e)}
      onToggle={() => (isStaged ? doUnstage([f.path]) : doStage([f.path]))}
      onDiscard={isStaged ? undefined : () => void doDiscard([f])}
      onMenu={(e) => ctxMenu.open(e, { f, staged: isStaged })}
    />
  );

  const untrackedCount = unstaged.filter(isUntracked).length;
  const hasBulk = multi.size > 1;
  const miniBtn = "rounded border border-line px-1.5 py-0.5 text-[10px] font-normal text-gray-300 hover:border-amber hover:text-amber";

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-gray-200">
      <OperationBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
          <span className="text-[11px] text-gray-500">{files.length} cambio{files.length === 1 ? "" : "s"}</span>
          <span className="flex-1" />
          <ViewToggle />
        </div>
        {hasBulk && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-amber/10 px-2 py-1 text-[11px]">
            <span className="mr-1 text-amber">{selCount} seleccionados</span>
            {selected.u.length > 0 && <button className={miniBtn} onClick={() => void doStage(selected.u.map((f) => f.path))}>Stage {selected.u.length}</button>}
            {selected.s.length > 0 && <button className={miniBtn} onClick={() => void doUnstage(selected.s.map((f) => f.path))}>Unstage {selected.s.length}</button>}
            {selected.u.length > 0 && <button className={`${miniBtn} hover:!border-git-deleted hover:!text-git-deleted`} onClick={() => void doDiscard(selected.u)}>Discard {selected.u.length}</button>}
            <button className={miniBtn} onClick={() => void stashFiles([...selected.u, ...selected.s].map((f) => f.path))}>Stash {selCount}</button>
            <button className={miniBtn} onClick={() => setMulti(new Set())}>Limpiar</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {files.length === 0 && <div className="p-4 text-center text-xs text-gray-500">Working tree limpio</div>}

          {conflicted.length > 0 && (
            <>
              <SectionHeader title="Conflicts" count={conflicted.length} />
              {conflicted.map((f) => (
                <div key={f.path} onClick={() => setModal({ kind: "conflict", path: f.path })} onContextMenu={(e) => ctxMenu.open(e, { f, staged: false })}
                  className="flex cursor-pointer items-center gap-2 px-2 py-[3px] text-xs hover:bg-elev">
                  <span className="flex h-3 w-3 shrink-0 animate-pulse items-center justify-center rounded-full bg-git-conflict" />
                  <AlertTriangle size={12} className="shrink-0 text-git-conflict" />
                  <span className="min-w-0 flex-1 truncate text-gray-200" title={f.path}>{f.path}</span>
                  <span className="text-[10px] text-git-conflict">{f.index}{f.worktree} Resolver</span>
                </div>
              ))}
            </>
          )}

          <SectionHeader title="Unstaged Files" count={unstaged.length}>
            {untrackedCount > 0 && <button onClick={() => void cleanUntracked()} title="git clean: borra los archivos sin seguimiento" className={`${miniBtn} hover:!border-git-deleted hover:!text-git-deleted`}>Clean</button>}
            {unstaged.length > 0 && (
              <>
                <button onClick={() => void discardAll()} className={`${miniBtn} hover:!border-git-deleted hover:!text-git-deleted`}>Discard all</button>
                <button onClick={() => void doStage(unstaged.map((f) => f.path))} className="rounded bg-git-added px-2 py-0.5 text-[10px] font-semibold text-white hover:opacity-90">Stage all changes</button>
              </>
            )}
          </SectionHeader>
          <FileList items={unstaged} view={fileView} id="u" renderFile={(f, c) => renderRow(f, false, c)}
            renderDirActions={(_d, fs) => (
              <button title="Stage carpeta" onClick={(e) => { e.stopPropagation(); void doStage(fs.map((f) => f.path)); }} className="rounded p-0.5 hover:text-amber"><Plus size={12} /></button>
            )} />

          <SectionHeader title="Staged Files" count={staged.length}>
            {staged.length > 0 && (
              <button onClick={() => void act("unstage_all")} className={miniBtn}>Unstage all</button>
            )}
          </SectionHeader>
          <FileList items={staged} view={fileView} id="s" renderFile={(f, c) => renderRow(f, true, c)}
            renderDirActions={(_d, fs) => (
              <button title="Unstage carpeta" onClick={(e) => { e.stopPropagation(); void doUnstage(fs.map((f) => f.path)); }} className="rounded p-0.5 hover:text-amber"><Minus size={12} /></button>
            )} />
        </div>

        {!big && diffPane}
      </div>
      {big && diffPane}

      <CommitBox staged={staged} unstaged={unstaged} conflictCount={conflicted.length} />

      {ctxMenu.menu && <ContextMenu x={ctxMenu.menu.x} y={ctxMenu.menu.y} items={menuItems(ctxMenu.menu.data)} onClose={ctxMenu.close} />}
      {history && <FileHistoryModal path={history} onClose={() => setHistory(null)} />}
      <FileFinder suggestions={files.map((f) => f.path)} />
    </div>
  );
}
