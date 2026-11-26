import { useEffect, useRef, useState } from "react";
import { GitBranch, GitMerge, MoveRight, UploadCloud } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { MergeMode } from "../../types/git";

const st = () => useRepoStore.getState();

export interface DragSource { name: string; kind: "local" | "remote"; remote?: string }
type DropTarget =
  | { kind: "local"; name: string }
  | { kind: "remote"; remote: string; branch: string; full: string }
  | { kind: "commit"; sha: string; short: string };

interface Active { src: DragSource; x: number; y: number; started: boolean; sx: number; sy: number }
interface PopState { x: number; y: number; src: DragSource; target: DropTarget }

let startHandler: ((src: DragSource, x: number, y: number) => void) | null = null;

/** Inicia un arrastre de rama (llamar desde onPointerDown de la pill). */
export function beginRefDrag(e: { clientX: number; clientY: number; button: number }, src: DragSource) {
  if (e.button !== 0) return;
  startHandler?.(src, e.clientX, e.clientY);
}

/** Atributos de zona de soltado para pills y filas. */
export const dropAttrs = {
  pill: (name: string, kind: "local" | "remote", remote?: string) => ({
    "data-drop-name": name, "data-drop-kind": kind, ...(remote ? { "data-drop-remote": remote } : {}),
  }),
};

function resolveTarget(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const pill = el.closest<HTMLElement>("[data-drop-name]");
  if (pill) {
    const name = pill.dataset.dropName ?? "";
    const kind = pill.dataset.dropKind;
    if (kind === "remote") {
      const full = name;
      const i = full.indexOf("/");
      return { kind: "remote", remote: i > 0 ? full.slice(0, i) : "origin", branch: i > 0 ? full.slice(i + 1) : full, full };
    }
    return { kind: "local", name };
  }
  const row = el.closest<HTMLElement>("[data-drop-sha]");
  if (row) {
    const branch = row.dataset.dropBranch;
    if (branch) return { kind: "local", name: branch };
    const sha = row.dataset.dropSha ?? "";
    return { kind: "commit", sha, short: sha.slice(0, 7) };
  }
  return null;
}

async function checkoutIfNeeded(name: string): Promise<boolean> {
  if (st().activeTab()?.status?.branch === name) return true;
  return (await st().act("checkout", { target: name, create: false })) !== undefined || st().activeTab()?.status?.branch === name;
}

const targetLabel = (t: DropTarget) => (t.kind === "local" ? t.name : t.kind === "remote" ? t.full : t.short);

export function DragDropLayer() {
  const [active, setActive] = useState<Active | null>(null);
  const [pop, setPop] = useState<PopState | null>(null);
  const activeRef = useRef<Active | null>(null);
  const hotRef = useRef<HTMLElement | null>(null);

  const clearHot = () => {
    hotRef.current?.removeAttribute("data-drop-hot");
    hotRef.current = null;
  };

  useEffect(() => {
    startHandler = (src, x, y) => {
      activeRef.current = { src, x, y, started: false, sx: x, sy: y };
    };
    const move = (e: PointerEvent) => {
      const a = activeRef.current;
      if (!a) return;
      a.x = e.clientX;
      a.y = e.clientY;
      if (!a.started && Math.hypot(a.x - a.sx, a.y - a.sy) > 5) a.started = true;
      if (a.started) {
        setActive({ ...a });
        const el = document.elementFromPoint(a.x, a.y)?.closest<HTMLElement>("[data-drop-name],[data-drop-sha]") ?? null;
        if (el !== hotRef.current) {
          clearHot();
          if (el && el.dataset.dropName !== a.src.name) { el.setAttribute("data-drop-hot", ""); hotRef.current = el; }
        }
      }
    };
    const up = (e: PointerEvent) => {
      const a = activeRef.current;
      activeRef.current = null;
      clearHot();
      setActive(null);
      if (!a || !a.started) return;
      const target = resolveTarget(e.clientX, e.clientY);
      if (!target) return;
      if ((target.kind === "local" && target.name === a.src.name) || (target.kind === "remote" && target.full === a.src.name)) return;
      // suprime el clic que sigue al soltar
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      setPop({ x: e.clientX, y: e.clientY, src: a.src, target });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { activeRef.current = null; clearHot(); setActive(null); setPop(null); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      startHandler = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, []);

  return (
    <>
      {active?.started && (
        <div
          className="pointer-events-none fixed z-[60] flex items-center gap-1 rounded-full border border-amber bg-elev px-2 py-0.5 text-[11px] text-gray-100 shadow-pop"
          style={{ left: active.x + 12, top: active.y + 8 }}
        >
          <GitBranch size={11} />{active.src.name}
        </div>
      )}
      {pop && <DropPopover pop={pop} onClose={() => setPop(null)} />}
    </>
  );
}

function DropPopover({ pop, onClose }: { pop: PopState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: pop.x, y: pop.y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(pop.x, window.innerWidth - r.width - 8), y: Math.min(pop.y, window.innerHeight - r.height - 8) });
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { src, target } = pop;
  const A = src.name;
  const B = targetLabel(target);
  const run = (fn: () => Promise<unknown>) => () => { onClose(); void fn(); };

  const merge = (mode: MergeMode) => async () => {
    if (target.kind !== "local") return;
    if (!(await checkoutIfNeeded(target.name))) return;
    await st().act("merge_branch", { name: A, mode });
  };
  const rebase = async () => {
    const onto = target.kind === "local" ? target.name : target.kind === "remote" ? target.full : target.sha;
    if (src.kind === "local") { if (!(await checkoutIfNeeded(A))) return; }
    else if (!(await st().confirm({ title: `Rebase de ${A}`, message: `Se aplicará rebase de la rama actual sobre ${onto}.`, confirmLabel: "Rebase" }))) return;
    await st().act("rebase_onto", { name: onto });
  };
  const ff = async () => {
    const to = target.kind === "local" ? target.name : target.kind === "remote" ? target.full : target.sha;
    await st().act("fast_forward_branch", { name: A, target: to });
  };
  const push = (force: boolean) => async () => {
    if (target.kind !== "remote") return;
    if (force) {
      const ok = await st().confirm({
        title: "Force push", message: `Se ejecutará push --force-with-lease de ${A} a ${target.full}. Puede reescribir el historial remoto.`,
        confirmLabel: "Force push", danger: true,
      });
      if (!ok) return;
    }
    await st().act("push_branch", { remote: target.remote, local: A, remoteBranch: target.branch, force });
  };

  type Opt = { icon: React.ReactNode; label: string; onClick: () => Promise<unknown>; danger?: boolean; disabled?: boolean };
  const opts: Opt[] = [];
  if (target.kind === "remote") {
    if (src.kind === "local") {
      opts.push({ icon: <UploadCloud size={12} />, label: `Push ${A} to ${B}`, onClick: push(false) });
      opts.push({ icon: <UploadCloud size={12} />, label: "Force push (with lease)", onClick: push(true), danger: true });
    }
    opts.push({ icon: <MoveRight size={12} />, label: `Rebase ${A} onto ${B}`, onClick: rebase });
  } else {
    if (target.kind === "local") {
      opts.push({ icon: <GitMerge size={12} />, label: `Merge ${A} into ${B}`, onClick: merge("default") });
      opts.push({ icon: <GitMerge size={12} />, label: `Merge ${A} into ${B} (no fast-forward)`, onClick: merge("no-ff") });
      opts.push({ icon: <GitMerge size={12} />, label: `Merge ${A} into ${B} (fast-forward only)`, onClick: merge("ff-only") });
      opts.push({ icon: <GitMerge size={12} />, label: `Squash ${A} into ${B}`, onClick: merge("squash") });
    }
    opts.push({ icon: <MoveRight size={12} />, label: `Rebase ${A} onto ${B}`, onClick: rebase });
    opts.push({ icon: <MoveRight size={12} />, label: `Fast-forward ${A} to ${B}`, onClick: ff, disabled: src.kind !== "local" });
  }

  return (
    <div
      ref={ref} style={{ left: pos.x, top: pos.y }}
      className="fixed z-[70] min-w-[250px] rounded-md border border-line bg-elev py-1 text-xs shadow-2xl animate-pop-in"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-wide text-gray-500">{A} → {B}</div>
      <div className="mb-1 h-px bg-line" />
      {opts.map((o, i) => (
        <button
          key={i} disabled={o.disabled}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber/15 disabled:opacity-40 disabled:hover:bg-transparent ${o.danger ? "text-git-deleted" : "text-gray-200"}`}
          onClick={run(o.onClick)}
        >
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
