import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronRight, FileClock, Plus, X } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { COMMIT_SHORTCUT_EVENT } from "../../hooks/useGitEvents";
import type { FileChange } from "../../types/git";

interface Props { staged: FileChange[]; unstaged: FileChange[]; conflictCount: number }
interface Template { summary: string; description: string }

const COAUTHOR_RE = /^[^<>]+<[^<>\s]+@[^<>\s]+>$/;

/** Caja de commit estilo GitKraken: Summary/Description, Amend, plantilla, co-autores, sign-off, no-verify, firma. */
export default function CommitBox({ staged, unstaged, conflictCount }: Props) {
  const act = useRepoStore((s) => s.act);
  const ask = useRepoStore((s) => s.ask);
  const toast = useRepoStore((s) => s.toast);
  const repoPath = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId)?.info.path ?? null);

  const [summary, setSummary] = useState("");
  const [desc, setDesc] = useState("");
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [sign, setSign] = useState(false);
  const [coAuthors, setCoAuthors] = useState<string[]>([]);
  const [coInput, setCoInput] = useState("");
  const [opts, setOpts] = useState(false);
  const [template, setTemplate] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sumRef = useRef<HTMLInputElement>(null);

  // plantilla de commit (commit.template) al cambiar de repo; precarga si la caja está vacía
  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    setTemplate(null);
    useRepoStore.getState().run<Template | null>("get_commit_template")
      .then((t) => {
        if (!live || !t) return;
        setTemplate(t);
        setSummary((s) => (s ? s : t.summary));
        setDesc((d) => (d ? d : t.description));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [repoPath]);

  const reset = () => {
    setSummary(template?.summary ?? ""); setDesc(template?.description ?? "");
    setAmend(false); setCoAuthors([]); setCoInput("");
  };

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
      setSummary(template?.summary ?? ""); setDesc(template?.description ?? "");
    }
  };

  const addCo = () => {
    const v = coInput.trim();
    if (!v) return;
    if (!COAUTHOR_RE.test(v)) { toast("Formato: Nombre <correo@dominio>"); return; }
    if (!coAuthors.includes(v)) setCoAuthors([...coAuthors, v]);
    setCoInput("");
  };

  const commitArgs = () => ({
    summary: summary.trim(), description: desc.trim(), amend,
    ...(signoff ? { signoff: true } : {}),
    ...(noVerify ? { noVerify: true } : {}),
    ...(coAuthors.length ? { coAuthors } : {}),
    ...(sign ? { gpgSign: true } : {}),
  });

  const hasMsg = summary.trim().length > 0;
  const canCommit = hasMsg && (staged.length > 0 || amend) && !busy && conflictCount === 0;
  const canStageAll = hasMsg && unstaged.length > 0 && !busy && conflictCount === 0;

  const doCommit = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const sha = await act<string>("commit", commitArgs());
    busyRef.current = false; setBusy(false);
    if (sha !== undefined) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, desc, amend, signoff, noVerify, sign, coAuthors, act, template]);

  const doStageAllAndCommit = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const paths = unstaged.map((f) => f.path);
    let ok = true;
    if (paths.length > 0) ok = (await act("stage_paths", { paths })) !== undefined;
    const sha = ok ? await act<string>("commit", commitArgs()) : undefined;
    busyRef.current = false; setBusy(false);
    if (sha !== undefined) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unstaged, summary, desc, amend, signoff, noVerify, sign, coAuthors, act, template]);

  const doStash = async () => {
    const r = await ask({
      title: "Stash", message: "Guarda los cambios sin commitear (incluye archivos sin seguimiento).",
      fields: [{ key: "message", label: "Mensaje (opcional)", placeholder: summary.trim() || "WIP", optional: true, initial: summary.trim() }],
      confirmLabel: "Stash",
    });
    if (!r) return;
    await act("stash_push", { message: r.message?.trim() || undefined, untracked: true });
  };

  const handlers = useRef({ doCommit, doStageAllAndCommit, canCommit, canStageAll, staged: staged.length });
  handlers.current = { doCommit, doStageAllAndCommit, canCommit, canStageAll, staged: staged.length };

  // ⌘Enter / ⌘⇧Enter (captura: se resuelven aquí antes que el atajo global) + evento caesargit:commit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const h = handlers.current;
      if (e.shiftKey) { if (h.canStageAll || (h.canCommit && h.staged > 0)) void h.doStageAllAndCommit(); }
      else if (h.canCommit) void h.doCommit();
    };
    const onEvt = () => {
      const h = handlers.current;
      if (h.canCommit) void h.doCommit();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(COMMIT_SHORTCUT_EVENT, onEvt);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener(COMMIT_SHORTCUT_EVENT, onEvt); };
  }, []);

  // ⌘⇧M: foco en el mensaje
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); sumRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sumLen = summary.length;
  const sumColor = sumLen > 72 ? "text-git-deleted" : sumLen > 50 ? "text-amber" : "text-gray-500";
  const n = staged.length;

  return (
    <div className="shrink-0 space-y-2 border-t border-line bg-panel p-2">
      <div className="relative">
        <input
          ref={sumRef}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary"
          className="w-full rounded border border-line bg-app px-2 py-1.5 pr-14 text-xs text-gray-100 outline-none focus:border-amber"
        />
        <span className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] ${sumColor}`}>{sumLen}/72</span>
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
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" className="accent-amber" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} />
          <FileClock size={12} /> Amend
        </label>
        {template && (
          <button onClick={() => { setSummary(template.summary); setDesc(template.description); }} className="text-[11px] text-gray-400 hover:text-amber" title="Insertar la plantilla commit.template">
            Plantilla
          </button>
        )}
        <span className="flex-1" />
        <button onClick={() => setOpts((o) => !o)} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-amber">
          {opts ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Opciones
          {(signoff || noVerify || sign || coAuthors.length > 0) && <span className="h-1.5 w-1.5 rounded-full bg-amber" />}
        </button>
      </div>
      {opts && (
        <div className="space-y-1.5 rounded border border-line bg-app p-2 text-xs text-gray-300">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" className="accent-amber" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} /> Sign-off</label>
            <label className="flex cursor-pointer items-center gap-1.5" title="--no-verify: omite los hooks pre-commit y commit-msg"><input type="checkbox" className="accent-amber" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} /> No-verify</label>
            <label className="flex cursor-pointer items-center gap-1.5" title="Firma GPG/SSH (-S)"><input type="checkbox" className="accent-amber" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Firmar</label>
          </div>
          <div className="flex gap-1">
            <input value={coInput} onChange={(e) => setCoInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCo(); } }}
              placeholder="Co-authored-by: Nombre <correo>" className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-amber" />
            <button onClick={addCo} className="rounded border border-line px-1.5 text-gray-300 hover:border-amber hover:text-amber"><Plus size={12} /></button>
          </div>
          {coAuthors.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {coAuthors.map((c) => (
                <span key={c} className="flex items-center gap-1 rounded border border-line bg-panel px-1.5 py-0.5 text-[10px]">
                  {c}
                  <button onClick={() => setCoAuthors(coAuthors.filter((x) => x !== c))} className="text-gray-500 hover:text-git-deleted"><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        disabled={!canCommit}
        onClick={() => void doCommit()}
        className="w-full rounded bg-git-added py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        title="⌘/Ctrl+Enter"
      >
        {amend ? "Amend commit" : `Commit changes to ${n} file${n === 1 ? "" : "s"}`}
      </button>
      <div className="flex gap-2">
        <button
          disabled={!canStageAll}
          onClick={() => void doStageAllAndCommit()}
          className="flex-1 rounded border border-line py-1 text-xs text-gray-200 hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
          title="⌘/Ctrl+Shift+Enter"
        >
          Stage all and commit
        </button>
        <button
          disabled={busy || (staged.length + unstaged.length + conflictCount === 0)}
          onClick={() => void doStash()}
          className="flex items-center gap-1 rounded border border-line px-3 py-1 text-xs text-gray-200 hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Archive size={12} /> Stash
        </button>
      </div>
    </div>
  );
}
