import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, GitCommit, Tag, Zap } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import type { CommitNode } from "../../types/git";
import { gitActions } from "./ActionToolbar";

interface Item { id: string; group: string; label: string; hint?: string; icon: React.ReactNode; run: () => void }

export function CommandPalette() {
  const openP = useRepoStore((s) => s.paletteOpen);
  const setOpen = useRepoStore((s) => s.setPaletteOpen);
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<CommitNode[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openP) { setQ(""); setSel(0); setFound([]); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [openP]);

  // búsqueda de commits en backend (mensaje/hash/autor), con debounce
  useEffect(() => {
    if (!openP || !tab || q.trim().length < 2) { setFound([]); return; }
    let cancelled = false;
    const h = setTimeout(() => {
      invoke<CommitNode[]>("search_commits", { repoPath: tab.info.path, query: q.trim() })
        .then((r) => { if (!cancelled) setFound(r.slice(0, 30)); })
        .catch(() => { if (!cancelled) setFound([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, openP, tab?.info.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<Item[]>(() => {
    const s = useRepoStore.getState();
    const out: Item[] = [];
    const act = (id: string, label: string, run: () => void, hint?: string) =>
      out.push({ id, group: "Acciones", label, hint, icon: <Zap size={13} />, run });
    act("open", "Abrir repositorio…", () => void s.pickAndOpen(), "⌘⇧O");
    act("newtab", "Nueva pestaña", () => s.setNewTabOpen(true), "⌘T");
    act("clone", "Clonar repositorio…", () => s.setModal({ kind: "clone" }));
    act("init", "Inicializar repositorio…", () => s.setModal({ kind: "init" }));
    act("prefs", "Preferencias", () => s.setModal({ kind: "preferences" }), "⌘,");
    act("shortcuts", "Atajos de teclado", () => s.setModal({ kind: "shortcuts" }), "⌘/");
    act("activity", "Registro de actividad", () => s.setModal({ kind: "activity" }));
    if (tab) {
      act("fetch", "Fetch", () => void gitActions.fetch(false, false));
      act("fetchall", "Fetch All", () => void gitActions.fetch(true, false));
      act("prune", "Fetch & Prune", () => void gitActions.fetch(true, true));
      act("pull", "Pull (solo fast-forward)", () => void gitActions.pull("ff"));
      act("pullr", "Pull (rebase)", () => void gitActions.pull("rebase"));
      act("pullm", "Pull (merge)", () => void gitActions.pull("merge"));
      act("push", "Push", () => void gitActions.push(false));
      act("pushf", "Force push (with lease)", () => void gitActions.push(true));
      act("branch", "Nueva rama desde HEAD…", () => void gitActions.createBranch());
      act("stash", "Stash", () => void gitActions.stash());
      act("pop", "Pop stash", () => void gitActions.popStash());
      act("undo", s.undoState.undoLabel ? `Deshacer: ${s.undoState.undoLabel}` : "Deshacer", () => void gitActions.undo(), "⌘Z");
      act("redo", s.undoState.redoLabel ? `Rehacer: ${s.undoState.redoLabel}` : "Rehacer", () => void gitActions.redo(), "⌘⇧Z");
      act("remotes", "Remotos…", () => s.setModal({ kind: "remotes" }));
      act("reflog", "Reflog…", () => s.setModal({ kind: "reflog" }));
      act("patch", "Parches (crear / aplicar)…", () => s.setModal({ kind: "patch" }));
      act("submodules", "Submódulos…", () => s.setModal({ kind: "submodules" }));
      act("worktrees", "Worktrees…", () => s.setModal({ kind: "worktrees" }));
      act("lfs", "Git LFS…", () => s.setModal({ kind: "lfs" }));
      act("gitflow", "Gitflow…", () => s.setModal({ kind: "gitflow" }));
      act("hooks", "Git hooks…", () => s.setModal({ kind: "hooks" }));
      act("bisect", "Bisect…", () => s.setModal({ kind: "bisect" }));
      act("repoSettings", "Ajustes del repositorio…", () => s.setModal({ kind: "repoSettings" }));
      act("refresh", "Refrescar", () => void s.refresh());
      act("close", "Cerrar pestaña", () => void s.closeTab(tab.info.id), "⌘W");
      for (const b of tab.branches.filter((x) => !x.isRemote))
        out.push({ id: "b:" + b.name, group: "Ramas", label: b.name, hint: b.isHead ? "HEAD" : "checkout",
          icon: <GitBranch size={13} />, run: () => void gitActions.checkout(b.name) });
      for (const b of tab.branches.filter((x) => x.isRemote && !x.name.endsWith("/HEAD")))
        out.push({ id: "r:" + b.name, group: "Ramas", label: b.name, hint: "checkout tracking",
          icon: <GitBranch size={13} className="text-gray-500" />, run: () => void s.act("checkout_remote_branch", { remoteBranch: b.name }) });
      for (const t of tab.tags)
        out.push({ id: "t:" + t.name, group: "Tags", label: t.name, hint: "checkout",
          icon: <Tag size={13} />, run: () => void gitActions.checkout(t.name) });
      for (const c of found)
        out.push({ id: "c:" + c.sha, group: "Commits", label: c.subject, hint: `${c.shortSha} · ${c.authorName}`,
          icon: <GitCommit size={13} />, run: () => s.setSelection({ kind: "commit", sha: c.sha }) });
    } else {
      // sin pestaña solo recientes
      for (const p of s.recents)
        out.push({ id: "rec:" + p, group: "Recientes", label: p, icon: <GitBranch size={13} />, run: () => void s.openRepo(p) });
    }
    const n = q.trim().toLowerCase();
    if (!n) return out.filter((i) => i.group === "Acciones" || i.group === "Recientes" || i.group === "Ramas").slice(0, 40);
    return out.filter((i) => i.group === "Commits" || i.label.toLowerCase().includes(n) || (i.hint ?? "").toLowerCase().includes(n)).slice(0, 60);
  }, [tab, q, found]);

  useEffect(() => { setSel(0); }, [q]);

  if (!openP) return null;
  const choose = (i?: Item) => { if (!i) return; setOpen(false); i.run(); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim/50 animate-fade-in pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div className="w-[620px] overflow-hidden rounded-lg border border-line bg-elev shadow-glow" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar commits (mensaje, hash, autor), ramas, tags o acciones…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-gray-500"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(items.length - 1, x + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(items[sel]); }
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-500">Sin resultados</div>}
          {items.map((it, i) => (
            <div key={it.id} ref={(el) => { if (el && i === sel) el.scrollIntoView({ block: "nearest" }); }}>
              {(i === 0 || items[i - 1].group !== it.group) && (
                <div className="px-4 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-gray-500">{it.group}</div>
              )}
              <button
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-xs ${i === sel ? "bg-amber/15 text-gray-50" : "text-gray-300"}`}
                onMouseEnter={() => setSel(i)} onClick={() => choose(it)}
              >
                <span className="text-amber">{it.icon}</span>
                <span className="truncate">{it.label}</span>
                {it.hint && <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-500">{it.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
