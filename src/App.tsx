import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AlertTriangle, FolderOpen, GitBranch, X } from "lucide-react";
import { useRepoStore, type DialogField, type DialogState } from "./store/useRepoStore";
import { useGitEvents } from "./hooks/useGitEvents";
import { RepoTabBar } from "./components/layout/RepoTabBar";
import { ActionToolbar } from "./components/layout/ActionToolbar";
import { Sidebar } from "./components/layout/Sidebar";
import { CommandPalette } from "./components/layout/CommandPalette";
import { CommitGraph } from "./components/graph/CommitGraph";
import WipPanel from "./components/inspector/WipPanel";
import CommitDetail from "./components/inspector/CommitDetail";
import BlameModal from "./components/inspector/BlameModal";
import SettingsModal from "./components/settings/SettingsModal";
import UpdatePrompt from "./components/layout/UpdatePrompt";
import { EmptyState } from "./components/layout/Visuals";
import logo from "./assets/logo.png";
import ThreeWayResolver from "./components/merge/ThreeWayResolver";
import InteractiveRebaseModal from "./components/merge/InteractiveRebaseModal";

const handleV = "w-px bg-line transition-colors hover:bg-amber data-[resize-handle-state=drag]:bg-amber";


function DialogHost() {
  const dialog = useRepoStore((s) => s.dialog);
  if (!dialog) return null;
  return <DialogBody key={dialog.title + dialog.fields.length} dialog={dialog} />;
}

function DialogBody({ dialog }: { dialog: DialogState }) {
  const close = useRepoStore((s) => s.closeDialog);
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(dialog.fields.map((f) => [f.key, f.initial ?? (f.type === "select" ? f.options?.[0]?.value ?? "" : "")])));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  const valid = dialog.fields.every((f) => f.optional || f.type === "checkbox" || f.type === "select" || vals[f.key].trim() !== "");
  const submit = () => { if (valid) close(vals); };
  const input = "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-sm outline-none focus:border-amber";
  const renderField = (f: DialogField, i: number) => (
    <label key={f.key} className="mb-3 block text-xs text-gray-400">
      {f.label}
      {f.type === "select" ? (
        <select className={`${input} mt-1`} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : f.type === "textarea" ? (
        <textarea className={`${input} mt-1 h-24`} value={vals[f.key]} placeholder={f.placeholder}
          onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
      ) : f.type === "checkbox" ? (
        <input type="checkbox" className="ml-2" checked={vals[f.key] === "true"}
          onChange={(e) => setVals({ ...vals, [f.key]: String(e.target.checked) })} />
      ) : (
        <input ref={i === 0 ? first : undefined} className={`${input} mt-1`} value={vals[f.key]} placeholder={f.placeholder}
          onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      )}
    </label>
  );
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/60 animate-fade-in"
      onKeyDown={(e) => { if (e.key === "Escape") close(null); }}>
      <div className="w-[420px] rounded-lg border border-line bg-elev p-5 shadow-2xl animate-pop-in">
        <h2 className="mb-1 text-sm font-semibold text-gray-100">{dialog.title}</h2>
        {dialog.message && <p className="mb-4 text-xs leading-relaxed text-gray-400">{dialog.message}</p>}
        {dialog.fields.map(renderField)}
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded-md px-3 py-1.5 text-xs text-gray-300 hover:bg-line" onClick={() => close(null)}>Cancelar</button>
          <button autoFocus={dialog.fields.length === 0} disabled={!valid} onClick={submit}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold text-onacc disabled:opacity-40 ${dialog.danger ? "bg-git-deleted" : "bg-amber hover:bg-amber-hover"}`}>
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useRepoStore((s) => s.toasts);
  const dismiss = useRepoStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[380px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-elev px-3 py-2 text-xs shadow-pop animate-slide-in ${t.kind === "error" ? "border-git-deleted/60" : "border-line"}`}>
          <span className={`flex-1 whitespace-pre-wrap break-words ${t.kind === "error" ? "text-red-300" : "text-gray-200"}`}>{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-gray-500 hover:text-gray-200"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

const OP_LABEL: Record<string, string> = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" };

function OperationBanner() {
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const run = useRepoStore((s) => s.act);
  const setModal = useRepoStore((s) => s.setModal);
  const op = tab?.status?.operation;
  if (!tab || !op) return null;
  const conflicts = tab.status?.files.filter((f) => f.conflicted) ?? [];
  return (
    <div className="flex items-center gap-3 border-b border-git-conflict/40 bg-git-conflict/10 px-4 py-2 text-xs">
      <AlertTriangle size={14} className="text-git-conflict" />
      <span className="font-semibold text-gray-100">{OP_LABEL[op] ?? op} en curso</span>
      {conflicts.length > 0 && (
        <span className="flex items-center gap-1 text-gray-300">
          <span className="animate-pulse-badge rounded-full bg-git-conflict px-1.5 py-px font-mono text-[10px] text-white">{conflicts.length}</span>
          conflictos:
          {conflicts.slice(0, 4).map((f) => (
            <button key={f.path} className="rounded bg-elev px-1.5 py-0.5 font-mono text-[11px] hover:text-amber"
              onClick={() => setModal({ kind: "conflict", path: f.path })}>{f.path}</button>
          ))}
          {conflicts.length > 4 && <span>+{conflicts.length - 4}</span>}
        </span>
      )}
      <div className="ml-auto flex gap-2">
        <button className="rounded-md border border-line px-3 py-1 hover:bg-elev" onClick={() => void run("op_abort")}>Abort</button>
        <button className="rounded-md bg-amber px-3 py-1 font-semibold text-onacc hover:bg-amber-hover disabled:opacity-40"
          disabled={conflicts.length > 0} title={conflicts.length ? "Resuelve los conflictos primero" : undefined}
          onClick={() => void run("op_continue")}>Continue</button>
      </div>
    </div>
  );
}

function Welcome() {
  const recents = useRepoStore((s) => s.recents);
  const { pickAndOpen, openRepo } = useRepoStore.getState();
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-7 overflow-auto bg-app px-6">
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(60% 50% at 50% 30%, rgb(var(--c-accent) / .13), transparent 70%)" }} />
      <div className="relative flex flex-col items-center gap-3 animate-pop-in">
        <img src={logo} width={88} height={88} alt="" className="animate-float rounded-2xl" style={{ imageRendering: "pixelated" }} draggable={false} />
        <div className="text-4xl font-bold tracking-tight text-gray-50">Caesar<span className="text-amber">Git</span></div>
        <div className="text-sm text-gray-400">Un cliente Git rápido, claro y con buen gusto.</div>
      </div>
      <button className="relative flex items-center gap-2 rounded-lg bg-amber px-5 py-2.5 text-sm font-semibold text-onacc shadow-glow transition hover:-translate-y-0.5 hover:bg-amber-hover"
        onClick={() => void pickAndOpen()}><FolderOpen size={16} /> Abrir repositorio <kbd className="font-mono text-[10px] opacity-70">⌘O</kbd></button>
      <div className="relative w-[520px] max-w-full">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Recientes</div>
        {recents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-gray-500">Aún no has abierto ningún repositorio.</div>
        ) : (
          <div className="space-y-1.5">
            {recents.slice(0, 6).map((p) => (
              <button key={p} className="group flex w-full items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-left transition hover:-translate-y-px hover:border-amber/50 hover:bg-elev"
                onClick={() => void openRepo(p)}>
                <GitBranch size={15} className="shrink-0 text-gray-500 group-hover:text-amber" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-100">{base(p)}</span>
                  <span className="block truncate font-mono text-[11px] text-gray-500">{p}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Inspector() {
  const selection = useRepoStore((s) => s.selection);
  if (selection?.kind === "wip") return <WipPanel />;
  if (selection?.kind === "commit" || selection?.kind === "file") return <CommitDetail />;
  return <div className="h-full bg-panel"><EmptyState art="select" title="Selecciona un commit" hint="Elige un commit del grafo o el nodo WIP para ver sus cambios." /></div>;
}

export default function App() {
  useGitEvents();
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const modal = useRepoStore((s) => s.modal);
  const setModal = useRepoStore((s) => s.setModal);

  return (
    <div className="flex h-full flex-col bg-app text-gray-200">
      <RepoTabBar />
      <ActionToolbar />
      <OperationBanner />
      <div className="min-h-0 flex-1">
        {!tab ? <Welcome /> : (
          <PanelGroup direction="horizontal" autoSaveId="caesargit-main">
            <Panel defaultSize={18} minSize={12} maxSize={35} className="bg-panel"><Sidebar /></Panel>
            <PanelResizeHandle className={handleV} />
            <Panel defaultSize={52} minSize={30} className="relative">
              <CommitGraph />
            </Panel>
            <PanelResizeHandle className={handleV} />
            <Panel defaultSize={30} minSize={20} maxSize={55} className="bg-panel"><Inspector /></Panel>
          </PanelGroup>
        )}
      </div>
      {modal?.kind === "blame" && <BlameModal path={modal.path} rev={modal.rev} onClose={() => setModal(null)} />}
      {modal?.kind === "conflict" && <ThreeWayResolver path={modal.path} onClose={() => setModal(null)} />}
      {modal?.kind === "rebase" && <InteractiveRebaseModal baseSha={modal.baseSha} onClose={() => setModal(null)} />}
      <CommandPalette />
      <SettingsModal />
      <UpdatePrompt />
      <DialogHost />
      <Toasts />
    </div>
  );
}
