import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRepoStore, type RepoTab } from "../../store/useRepoStore";
import type { GraphRow, ResetMode } from "../../types/git";
import { gitActions } from "../layout/ActionToolbar";
import { ContextMenu, type CtxItem } from "../layout/Sidebar";
import { laneColor } from "./GraphCell";
import { pillRefName, type PillModel } from "./BranchPill";

const st = () => useRepoStore.getState();
export const LANE_COUNT = 10;

const fullMessage = (r: GraphRow) => (r.commit.body ? `${r.commit.subject}\n\n${r.commit.body}` : r.commit.subject);
const copy = (text: string, what: string) => { void navigator.clipboard.writeText(text); st().toast(`${what} copiado`, "info"); };

export interface CommitMenuState { x: number; y: number; items: CtxItem[] }

/** Construye el menú contextual completo de un commit (o de una selección múltiple). */
export async function buildCommitMenu(opts: {
  tab: RepoTab;
  rows: GraphRow[];
  row: GraphRow;
  selected: string[];
  openReset: (sha: string, short: string) => void;
}): Promise<CtxItem[]> {
  const { tab, rows, row, selected, openReset } = opts;
  const c = row.commit;
  const sha = c.sha;
  const short = c.shortSha;
  const head = tab.status?.headSha ?? null;
  const branch = tab.status?.branch ?? null;
  const branchTxt = branch ?? "HEAD";
  const idxOf = (s: string) => rows.findIndex((r) => r.commit.sha === s);

  // varios commits seleccionados y el clicado forma parte
  if (selected.length > 1 && selected.includes(sha)) {
    // más antiguo primero (índice mayor = más antiguo)
    const shas = [...selected].sort((a, b) => idxOf(b) - idxOf(a));
    const n = shas.length;
    const items: CtxItem[] = [
      { label: `Cherry pick ${n} commits`, onClick: () => void st().act("cherry_pick", { shas }) },
      { label: `Revert ${n} commits`, onClick: () => void st().act("revert_commit", { shas }) },
      { label: `Revert ${n} commits (sin commit)`, onClick: () => void st().act("revert_commit", { shas, noCommit: true }) },
      { sep: true },
      {
        label: `Squash ${n} commits…`, onClick: async () => {
          const oldest = rows.find((r) => r.commit.sha === shas[0])?.commit.subject ?? "";
          const a = await st().ask({
            title: `Squash de ${n} commits`,
            message: "Los commits deben ser consecutivos y sin merges. Deja vacío para usar el mensaje combinado por defecto.",
            fields: [{ key: "m", label: "Mensaje", type: "textarea", initial: oldest, optional: true }],
            confirmLabel: "Squash",
          });
          if (a) await st().act("squash_commits", { shas, message: a.m?.trim() ?? "" });
        },
      },
    ];
    if (n === 2) {
      items.push({ label: "Compare commits", onClick: () => st().setModal({ kind: "compare", a: shas[0], b: shas[1] }) });
    }
    items.push({ sep: true });
    items.push({ label: "Copy SHAs", onClick: () => copy(shas.join("\n"), "SHAs") });
    return items;
  }

  let canRebase = false;
  try {
    canRebase = c.parents.length > 0 && (await invoke<boolean>("is_ancestor_of_head", { repoPath: tab.info.path, sha }));
  } catch { /* sin rebase */ }
  const isHead = sha === head;

  const tag = (annotated: boolean) => async () => {
    const a = await st().ask({
      title: `${annotated ? "Tag anotado" : "Nuevo tag"} en ${short}`,
      fields: [
        { key: "n", label: "Nombre" },
        ...(annotated ? [{ key: "m", label: "Mensaje" }] : []),
      ],
      confirmLabel: "Crear",
    });
    if (a?.n?.trim() && (!annotated || a.m?.trim()))
      await st().act("create_tag", { name: a.n.trim(), target: sha, message: annotated ? a.m.trim() : null });
  };

  const items: CtxItem[] = [
    { label: "Create branch here…", onClick: () => void gitActions.createBranch(sha) },
    { label: "Checkout this commit", disabled: isHead, onClick: () => void gitActions.checkout(sha) },
    { label: "Create tag here…", onClick: () => void tag(false)() },
    { label: "Create annotated tag here…", onClick: () => void tag(true)() },
    { sep: true },
    { label: "Cherry pick commit", disabled: isHead, onClick: () => void st().act("cherry_pick", { shas: [sha] }) },
    { label: "Revert commit", onClick: () => void st().act("revert_commit", { shas: [sha] }) },
    { label: "Revert commit (sin commit)", onClick: () => void st().act("revert_commit", { shas: [sha], noCommit: true }) },
    { label: `Reset ${branchTxt} to this commit ▸`, onClick: () => openReset(sha, short) },
    { sep: true },
    {
      label: "Edit commit message…", onClick: async () => {
        const a = await st().ask({
          title: `Editar mensaje de ${short}`,
          message: isHead ? undefined : "Reescribe la historia desde este commit (rebase automático).",
          fields: [{ key: "m", label: "Mensaje", type: "textarea", initial: fullMessage(row) }],
          confirmLabel: "Guardar",
        });
        if (a?.m?.trim()) await st().act("edit_commit_message", { sha, message: a.m.trim() });
      },
    },
    ...(canRebase ? [
      { label: `Interactive rebase ${branchTxt} onto this commit…`, onClick: () => st().setModal({ kind: "rebase", baseSha: c.parents[0] }) } as CtxItem,
      {
        label: `Rebase ${branchTxt} onto this commit`, disabled: isHead, onClick: async () => {
          const ok = await st().confirm({ title: "Rebase", message: `Rebase de ${branchTxt} sobre ${short}. Reescribe la historia.`, confirmLabel: "Rebase" });
          if (ok) await st().act("rebase_onto", { name: sha });
        },
      } as CtxItem,
      { sep: true } as CtxItem,
      {
        label: "Fixup into parent (con cambios en stage)", onClick: async () => {
          const ok = await st().confirm({ title: `Fixup en ${short}`, message: "Los cambios en stage se fusionan en este commit (commit --fixup + autosquash).", confirmLabel: "Fixup" });
          if (ok) await st().act("fixup_commit", { sha });
        },
      } as CtxItem,
      { label: "Move commit up", disabled: isHead, onClick: () => void st().act("move_commit", { sha, direction: "up" }) } as CtxItem,
      { label: "Move commit down", disabled: c.parents.length === 0, onClick: () => void st().act("move_commit", { sha, direction: "down" }) } as CtxItem,
      {
        label: "Drop commit", danger: true, onClick: async () => {
          const ok = await st().confirm({ title: `Eliminar ${short}`, message: `Se quitará «${c.subject}» de la historia (rebase). Se puede deshacer con Undo.`, confirmLabel: "Drop", danger: true });
          if (ok) await st().act("drop_commit", { sha });
        },
      } as CtxItem,
    ] : []),
    { sep: true },
    ...(selected.length === 1 && selected[0] !== sha && !row.isWip
      ? [{ label: "Compare with selected commit", onClick: () => st().setModal({ kind: "compare", a: selected[0], b: sha }) } as CtxItem]
      : []),
    ...(head && !isHead ? [{ label: "Compare with HEAD", onClick: () => st().setModal({ kind: "compare", a: sha, b: head }) } as CtxItem] : []),
    { label: "Copy commit sha", onClick: () => copy(sha, "SHA") },
    { label: "Copy commit message", onClick: () => copy(fullMessage(row), "Mensaje") },
    { label: "Create patch from commit…", onClick: () => st().setModal({ kind: "patch", sha }) },
  ];

  // Hide / Solo de las refs del commit
  const refNames = [...new Set(c.refs.filter((r) => (r.kind as string) !== "stash").map((r) => r.name))].slice(0, 3);
  if (refNames.length) {
    const hidden = tab.repoPrefs.hiddenRefs;
    items.push({ sep: true });
    for (const n of refNames) {
      items.push({ label: `${hidden.includes(n) ? "Show" : "Hide"} ${n}`, onClick: () => st().toggleHidden(n) });
      items.push({ label: `${tab.repoPrefs.soloRef === n ? "Unsolo" : "Solo"} ${n}`, onClick: () => st().toggleSolo(n) });
    }
  }
  return items;
}

/** Menú contextual de una pill (rama / tag / stash). */
export function buildPillMenu(tab: RepoTab, pill: PillModel, row: GraphRow, openColor: (name: string) => void): CtxItem[] {
  const cur = tab.status?.branch ?? null;
  const name = pillRefName(pill);
  const items: CtxItem[] = [];
  const hidden = tab.repoPrefs.hiddenRefs.includes(name);
  const solo = tab.repoPrefs.soloRef === name;
  if (pill.tag) {
    items.push({ label: "Checkout", onClick: () => void gitActions.checkout(pill.label) });
    items.push({ label: "Create branch here…", onClick: () => void gitActions.createBranch(row.commit.sha) });
    items.push({ label: "Push tag", onClick: () => void st().act("push_tag", { remote: "origin", name: pill.label }) });
    items.push({ label: "Delete tag", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Borrar tag", message: pill.label, confirmLabel: "Borrar", danger: true })) await st().act("delete_tag", { name: pill.label });
    } });
  } else if (pill.stash) {
    const idx = Number(/\{(\d+)\}/.exec(pill.label)?.[1] ?? "0");
    items.push({ label: "Apply stash", onClick: () => void st().act("stash_apply", { index: idx }) });
    items.push({ label: "Pop stash", onClick: () => void st().act("stash_pop", { index: idx }) });
    items.push({ label: "Delete stash", danger: true, onClick: async () => {
      if (await st().confirm({ title: "Borrar stash", message: pill.label, confirmLabel: "Borrar", danger: true })) await st().act("stash_drop", { index: idx });
    } });
  } else {
    if (pill.local) {
      items.push({ label: "Checkout", disabled: pill.head, onClick: () => void gitActions.checkout(pill.label) });
    } else {
      items.push({ label: "Checkout (tracking)", onClick: () => void st().act("checkout_remote_branch", { remoteBranch: pill.remotes[0] }) });
    }
    if (cur && name !== cur) {
      items.push({ label: `Merge ${name} into ${cur}`, onClick: () => void st().act("merge_branch", { name }) });
      items.push({ label: `Rebase ${cur} onto ${name}`, onClick: () => void st().act("rebase_onto", { name }) });
      items.push({ label: `Fast-forward ${cur} to ${name}`, onClick: () => void st().act("fast_forward_branch", { name: cur, target: name }) });
    }
    items.push({ label: "Create branch here…", onClick: () => void gitActions.createBranch(row.commit.sha) });
    if (pill.local && !pill.head) {
      items.push({ label: "Delete branch", danger: true, onClick: async () => {
        if (await st().confirm({ title: "Borrar rama", message: pill.label, confirmLabel: "Borrar", danger: true })) await st().act("delete_branches", { names: [pill.label], force: true });
      } });
    }
    if (!pill.local && pill.remotes[0]) {
      const full = pill.remotes[0];
      const i = full.indexOf("/");
      items.push({ label: "Delete remote branch", danger: true, onClick: async () => {
        if (await st().confirm({ title: "Borrar rama remota", message: full, confirmLabel: "Borrar", danger: true }))
          await st().act("delete_remote_branch", { remote: full.slice(0, i), branch: full.slice(i + 1) });
      } });
    }
    items.push({ sep: true });
    items.push({ label: "Change branch color…", onClick: () => openColor(name) });
    items.push({ label: tab.repoPrefs.pinnedRefs.includes(name) ? "Unpin from left" : "Pin to left", onClick: () => st().togglePin(name) });
  }
  items.push({ sep: true });
  items.push({ label: hidden ? "Show" : "Hide", onClick: () => st().toggleHidden(name) });
  items.push({ label: solo ? "Unsolo" : "Solo", onClick: () => st().toggleSolo(name) });
  items.push({ label: "Copy name", onClick: () => copy(pill.label, "Nombre") });
  return items;
}

export function CommitContextMenu({ menu, onClose }: { menu: CommitMenuState; onClose: () => void }) {
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={onClose} />;
}

const RESET_INFO: { mode: ResetMode; title: string; desc: string }[] = [
  { mode: "soft", title: "Soft", desc: "Mueve la rama a este commit. Conserva los cambios en stage y en el working tree." },
  { mode: "mixed", title: "Mixed", desc: "Mueve la rama y limpia el stage. Los cambios quedan en el working tree sin stage." },
  { mode: "hard", title: "Hard", desc: "Mueve la rama y DESCARTA todos los cambios sin commit del working tree. Peligroso." },
];

export function ResetDialog({ sha, short, branch, onClose }: { sha: string; short: string; branch: string; onClose: () => void }) {
  const [mode, setMode] = useState<ResetMode>("mixed");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const go = async () => {
    setBusy(true);
    await st().act("reset_to", { sha, mode });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 animate-fade-in" onMouseDown={onClose}>
      <div className="w-[420px] rounded-lg border border-line bg-elev p-4 shadow-pop animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-sm font-semibold text-gray-100">Reset {branch} to {short}</h3>
        <p className="mb-3 text-xs text-gray-400">Elige cómo mover la rama actual a este commit.</p>
        <div className="space-y-1.5">
          {RESET_INFO.map((r) => (
            <label key={r.mode} className={`flex cursor-pointer gap-2 rounded-md border p-2 text-xs ${mode === r.mode ? (r.mode === "hard" ? "border-git-deleted bg-git-deleted/10" : "border-amber bg-amber/10") : "border-line hover:bg-panel"}`}>
              <input type="radio" name="reset-mode" className="mt-0.5" checked={mode === r.mode} onChange={() => setMode(r.mode)} />
              <span>
                <span className={`block font-semibold ${r.mode === "hard" ? "text-git-deleted" : "text-gray-100"}`}>{r.title}</span>
                <span className="text-gray-400">{r.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button className="rounded-md border border-line px-3 py-1.5 text-gray-300 hover:bg-panel" onClick={onClose}>Cancelar</button>
          <button
            disabled={busy} onClick={() => void go()}
            className={`rounded-md px-3 py-1.5 font-semibold disabled:opacity-50 ${mode === "hard" ? "bg-git-deleted text-white hover:opacity-90" : "bg-amber text-onacc hover:bg-amber-hover"}`}
          >
            Reset {mode}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Selector de color de carril para una rama. */
export function ColorPicker({ x, y, name, current, onClose }: { x: number; y: number; name: string; current: number | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [onClose]);
  return (
    <div ref={ref} className="fixed z-[70] rounded-md border border-line bg-elev p-2 shadow-pop animate-pop-in" style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 110) }}>
      <div className="mb-1.5 truncate text-[10px] uppercase tracking-wide text-gray-500">Color de {name}</div>
      <div className="grid grid-cols-5 gap-1.5">
        {Array.from({ length: LANE_COUNT }, (_, i) => (
          <button
            key={i} title={`Carril ${i + 1}`}
            className={`h-5 w-5 rounded-full ring-offset-1 ring-offset-elev hover:scale-110 ${current === i ? "ring-2 ring-gray-100" : ""}`}
            style={{ background: laneColor(i) }}
            onClick={() => { st().setBranchColor(name, i); onClose(); }}
          />
        ))}
      </div>
      <button className="mt-2 w-full rounded border border-line py-0.5 text-[11px] text-gray-300 hover:bg-panel" onClick={() => { st().setBranchColor(name, null); onClose(); }}>
        Restablecer
      </button>
    </div>
  );
}
