import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, EyeOff, FileClock, GitMerge, History, Maximize2, Minimize2, MoreHorizontal, Minus, Plus,
  RotateCcw, Search, X,
} from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { DiffFile, FileChange, HunkAction } from "../../types/git";
import DiffViewer from "./DiffViewer";
import { FileHistoryModal } from "./CommitDetail";

const OP_LABEL: Record<string, string> = {
  merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert",
};

export function statusColor(c: string): string {
  switch (c) {
    case "A": case "?": return "text-git-added";
    case "D": return "text-git-deleted";
    case "R": case "C": return "text-git-renamed";
    case "U": return "text-git-conflict";
    default: return "text-git-modified";
  }
}

function baseName(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/** Banner de operación en curso (merge/rebase/cherry-pick/revert) con Abort / Continue. */
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
  const go = async (cmd: "op_abort" | "op_continue") => {
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
  return (
    <div className="flex items-center gap-2 border-b border-amber/40 bg-amber/10 px-3 py-2 text-xs">
      <GitMerge size={14} className="shrink-0 text-amber" />
      <span className="flex-1 text-amber">
        {label} en curso{conflicts > 0 ? ` · ${conflicts} conflicto${conflicts === 1 ? "" : "s"}` : ""}
      </span>
      <button disabled={busy} onClick={() => go("op_abort")} className="rounded border border-line px-2 py-0.5 text-gray-300 hover:border-git-deleted hover:text-git-deleted disabled:opacity-50">
        Abort
      </button>
      <button disabled={busy || conflicts > 0} onClick={() => go("op_continue")} title={conflicts > 0 ? "Resuelve los conflictos primero" : ""} className="rounded bg-amber px-2 py-0.5 font-medium text-onacc hover:bg-amber-hover disabled:opacity-40">
        Continue
      </button>
    </div>
  );
}

interface RowProps {
  f: FileChange;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDiscard?: () => void;
  onMenu: (a: "history" | "blame" | "ignore") => void;
}

function FileRow({ f, staged, selected, onSelect, onToggle, onDiscard, onMenu }: RowProps) {
  const [menu, setMenu] = useState(false);
  const ch = staged ? f.index : f.worktree;
  const { dir, name } = baseName(f.path);
  return (
    <div
      onClick={onSelect}
      className={`group relative flex cursor-pointer items-center gap-2 px-2 py-[3px] text-xs hover:bg-elev ${selected ? "bg-elev shadow-glow" : ""}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono font-bold ${statusColor(ch)}`}>{ch === " " ? "·" : ch}</span>
      <span className="min-w-0 flex-1 truncate" title={f.path}>
        <span className="text-gray-500">{dir}</span>
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
        <button title="Más" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }} className="rounded p-0.5 text-gray-400 hover:text-amber">
          <MoreHorizontal size={13} />
        </button>
      </span>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
          <div className="absolute right-2 top-full z-40 w-40 rounded border border-line bg-elev py-1 shadow-xl animate-pop-in" onClick={(e) => e.stopPropagation()}>
            {([["history", "File History", History], ["blame", "Blame", Search], ["ignore", "Ignore", EyeOff]] as const).map(([k, l, Icon]) => (
              <button key={k} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-gray-200 hover:bg-panel hover:text-amber" onClick={() => { setMenu(false); onMenu(k); }}>
                <Icon size={12} /> {l}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionHeader(props: { title: string; count: number; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-line bg-panel px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
      <span>{props.title}</span>
      <span className="rounded bg-elev px-1.5 text-gray-300">{props.count}</span>
      <span className="flex-1" />
      {props.children}
    </div>
  );
}

export default function WipPanel() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const act = useRepoStore((s) => s.act);
  const confirm = useRepoStore((s) => s.confirm);
  const setModal = useRepoStore((s) => s.setModal);

  const files = tab?.status?.files ?? [];
  const conflicted = useMemo(() => files.filter((f) => f.conflicted), [files]);
  const unstaged = useMemo(() => files.filter((f) => f.unstaged && !f.conflicted), [files]);
  const staged = useMemo(() => files.filter((f) => f.staged && !f.conflicted), [files]);

  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffFile | null>(null);
  const [ws, setWs] = useState(false);
  const [big, setBig] = useState(false);
  const [history, setHistory] = useState<string | null>(null);

  const [summary, setSummary] = useState("");
  const [desc, setDesc] = useState("");
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);

  // limpiar selección si el archivo ya no está en esa lista
  useEffect(() => {
    if (!sel) return;
    const list = sel.staged ? staged : unstaged;
    if (!list.some((f) => f.path === sel.path)) { setSel(null); setDiff(null); }
  }, [sel, staged, unstaged]);

  const status = tab?.status;
  const hasTab = tab !== null;
  const run = useRepoStore((s) => s.run);
  useEffect(() => {
    if (!sel || !hasTab) return;
    let live = true;
    run<DiffFile>("get_file_diff", { path: sel.path, staged: sel.staged, ignoreWhitespace: ws })
      .then((d) => { if (live) setDiff(d); })
      .catch(() => { if (live) setDiff(null); });
    return () => { live = false; };
    // status cambia tras cada operación: recarga el diff
  }, [sel, ws, status, run, hasTab]);

  const doStage = (paths: string[]) => act("stage_paths", { paths });
  const doUnstage = (paths: string[]) => act("unstage_paths", { paths });
  const doDiscard = async (f: FileChange) => {
    const ok = await confirm({
      title: "Descartar cambios",
      message: `Se perderán los cambios de ${f.path}. No se puede deshacer.`,
      confirmLabel: "Descartar",
      danger: true,
    });
    if (ok) await act("discard_paths", { paths: [f.path] });
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
  const menu = (f: FileChange) => async (a: "history" | "blame" | "ignore") => {
    if (a === "history") setHistory(f.path);
    else if (a === "blame") setModal({ kind: "blame", path: f.path });
    else await act("ignore_path", { path: f.path });
  };

  const onHunk = useCallback(
    async (hunkIndex: number, action: HunkAction) => {
      if (!sel) return;
      if (action === "discard") {
        const ok = await confirm({ title: "Descartar hunk", message: "Se perderán los cambios de este bloque.", confirmLabel: "Descartar", danger: true });
        if (!ok) return;
      }
      await act("apply_hunk", { path: sel.path, staged: sel.staged, hunkIndex, action, ignoreWhitespace: ws });
    },
    [sel, ws, act, confirm],
  );
  const onLines = useCallback(
    async (hunkIndex: number, lineIndices: number[], action: "stage" | "unstage") => {
      if (!sel) return;
      await act("apply_lines", { path: sel.path, hunkIndex, lineIndices, action });
    },
    [sel, act],
  );

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on) {
      const msg = await act<string>("last_commit_message");
      if (msg !== undefined) {
        const clean = msg.replace(/\s+$/, "");
        const nl = clean.indexOf("\n");
        setSummary(nl < 0 ? clean : clean.slice(0, nl));
        setDesc(nl < 0 ? "" : clean.slice(nl + 1).replace(/^\n+/, ""));
      }
    } else {
      setSummary("");
      setDesc("");
    }
  };

  const canCommit = summary.trim().length > 0 && (staged.length > 0 || amend) && !committing && conflicted.length === 0;
  const doCommit = async () => {
    if (!canCommit) return;
    setCommitting(true);
    const sha = await act<string>("commit", { summary: summary.trim(), description: desc.trim(), amend });
    setCommitting(false);
    if (sha !== undefined) { setSummary(""); setDesc(""); setAmend(false); }
  };
  const doCommitRef = useRef(doCommit);
  doCommitRef.current = doCommit;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void doCommitRef.current();
    }
  };

  if (!tab) return <div className="p-4 text-sm text-gray-500">Sin repositorio activo.</div>;

  const sumLen = summary.length;
  const sumColor = sumLen > 72 ? "text-git-deleted" : sumLen > 50 ? "text-amber" : "text-gray-500";

  const diffPane = sel && diff && (
    <div className={big ? "fixed inset-4 z-50 flex flex-col rounded-lg border border-line bg-app shadow-2xl animate-pop-in" : "flex h-[45%] min-h-[160px] flex-col border-t border-line"}>
      <div className="flex shrink-0 items-center justify-end gap-1 bg-panel px-2 py-0.5">
        <button title={big ? "Reducir" : "Ampliar"} onClick={() => setBig((b) => !b)} className="rounded p-1 text-gray-400 hover:text-amber">
          {big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button title="Cerrar diff" onClick={() => { setSel(null); setDiff(null); setBig(false); }} className="rounded p-1 text-gray-400 hover:text-amber"><X size={13} /></button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffViewer
          diff={diff}
          context={sel.staged ? "staged" : "unstaged"}
          ignoreWhitespace={ws}
          onIgnoreWhitespace={setWs}
          onHunkAction={onHunk}
          onLinesAction={onLines}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-gray-200">
      <OperationBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {files.length === 0 && <div className="p-4 text-center text-xs text-gray-500">Working tree limpio</div>}

          {conflicted.length > 0 && (
            <>
              <SectionHeader title="Conflicts" count={conflicted.length} />
              {conflicted.map((f) => (
                <div key={f.path} onClick={() => setModal({ kind: "conflict", path: f.path })} className="flex cursor-pointer items-center gap-2 px-2 py-[3px] text-xs hover:bg-elev">
                  <span className="flex h-3 w-3 shrink-0 animate-pulse items-center justify-center rounded-full bg-git-conflict" />
                  <AlertTriangle size={12} className="shrink-0 text-git-conflict" />
                  <span className="min-w-0 flex-1 truncate text-gray-200" title={f.path}>{f.path}</span>
                  <span className="text-[10px] text-git-conflict">Resolver</span>
                </div>
              ))}
            </>
          )}

          <SectionHeader title="Unstaged" count={unstaged.length}>
            {unstaged.length > 0 && (
              <>
                <button onClick={() => doStage(unstaged.map((f) => f.path))} className="rounded border border-line px-1.5 text-[10px] normal-case text-gray-300 hover:border-amber hover:text-amber">Stage All</button>
                <button onClick={discardAll} className="rounded border border-line px-1.5 text-[10px] normal-case text-gray-300 hover:border-git-deleted hover:text-git-deleted">Discard All</button>
              </>
            )}
          </SectionHeader>
          {unstaged.map((f) => (
            <FileRow key={"u" + f.path} f={f} staged={false} selected={sel?.path === f.path && !sel.staged}
              onSelect={() => setSel({ path: f.path, staged: false })}
              onToggle={() => doStage([f.path])} onDiscard={() => doDiscard(f)} onMenu={menu(f)} />
          ))}

          <SectionHeader title="Staged" count={staged.length}>
            {staged.length > 0 && (
              <button onClick={() => act("unstage_all")} className="rounded border border-line px-1.5 text-[10px] normal-case text-gray-300 hover:border-amber hover:text-amber">Unstage All</button>
            )}
          </SectionHeader>
          {staged.map((f) => (
            <FileRow key={"s" + f.path} f={f} staged selected={sel?.path === f.path && sel.staged}
              onSelect={() => setSel({ path: f.path, staged: true })}
              onToggle={() => doUnstage([f.path])} onMenu={menu(f)} />
          ))}
        </div>

        {!big && diffPane}
      </div>
      {big && diffPane}

      <div className="shrink-0 space-y-2 border-t border-line bg-panel p-2" onKeyDownCapture={onKey}>
        <div className="relative">
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Summary"
            className="w-full rounded border border-line bg-app px-2 py-1.5 pr-14 text-xs text-gray-100 outline-none focus:border-amber"
          />
          <span className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] ${sumColor}`}>{sumLen}/50</span>
        </div>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description"
          rows={3}
          className="w-full resize-none rounded border border-line bg-app px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-amber"
        />
        {desc.split("\n").some((l) => l.length > 72) && (
          <div className="text-[10px] text-amber">Hay líneas de más de 72 caracteres en la descripción.</div>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" className="accent-amber" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} />
          <FileClock size={12} /> Amend last commit
        </label>
        <button
          disabled={!canCommit}
          onClick={() => void doCommit()}
          className="w-full rounded bg-amber py-1.5 text-xs font-semibold text-onacc hover:bg-amber-hover disabled:cursor-not-allowed disabled:opacity-40"
          title="Cmd/Ctrl+Enter"
        >
          {amend ? "Amend Commit" : "Commit Changes"} ({staged.length} file{staged.length === 1 ? "" : "s"})
        </button>
      </div>

      {history && <FileHistoryModal path={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
