import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AlertTriangle, X } from "lucide-react";
import { useRepoStore, type DialogField, type DialogState } from "./store/useRepoStore";
import { usePrefs } from "./store/usePrefs";
import { useGitEvents } from "./hooks/useGitEvents";
import { RepoTabBar } from "./components/layout/RepoTabBar";
import { ActionToolbar } from "./components/layout/ActionToolbar";
import { Sidebar } from "./components/layout/Sidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { NewTabView } from "./components/layout/NewTabView";
import { CommandPalette } from "./components/layout/CommandPalette";
import { CommitGraph } from "./components/graph/CommitGraph";
import WipPanel from "./components/inspector/WipPanel";
import CommitDetail from "./components/inspector/CommitDetail";
import BlameModal from "./components/inspector/BlameModal";
import UpdatePrompt from "./components/layout/UpdatePrompt";
import { EmptyState } from "./components/layout/Visuals";
import ThreeWayResolver from "./components/merge/ThreeWayResolver";
import InteractiveRebaseModal from "./components/merge/InteractiveRebaseModal";
import BisectBanner, { BISECT_CHANGED_EVENT } from "./components/tools/BisectBanner";

// Modales pesados: carga diferida
const CloneModal = lazy(() => import("./components/tools/CloneModal"));
const InitModal = lazy(() => import("./components/tools/InitModal"));
const RemotesModal = lazy(() => import("./components/tools/RemotesModal"));
const ReflogModal = lazy(() => import("./components/tools/ReflogModal"));
const PatchModal = lazy(() => import("./components/tools/PatchModal"));
const CompareView = lazy(() => import("./components/tools/CompareView"));
const SubmodulesModal = lazy(() => import("./components/tools/SubmodulesModal"));
const WorktreesModal = lazy(() => import("./components/tools/WorktreesModal"));
const LfsModal = lazy(() => import("./components/tools/LfsModal"));
const GitflowModal = lazy(() => import("./components/tools/GitflowModal"));
const HooksModal = lazy(() => import("./components/tools/HooksModal"));
const ActivityLogModal = lazy(() => import("./components/tools/ActivityLogModal"));
const ShortcutsModal = lazy(() => import("./components/tools/ShortcutsModal"));
const PreferencesModal = lazy(() => import("./components/settings/PreferencesModal"));
const RepoSettingsModal = lazy(() => import("./components/tools/RepoSettingsModal"));

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

/** Modal {kind:"bisect"}: pide los commits bad/good, arranca el bisect y deja el banner activo. */
function BisectStarter({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = useRepoStore.getState();
      const head = st.activeTab()?.status?.headSha ?? "HEAD";
      const r = await st.ask({
        title: "Iniciar bisect", message: "Indica un commit malo y uno bueno (SHA, rama o tag). Git irá proponiendo commits intermedios.",
        fields: [{ key: "bad", label: "Commit malo", initial: head === "HEAD" ? "HEAD" : head.slice(0, 12) }, { key: "good", label: "Commit bueno" }],
        confirmLabel: "Empezar",
      });
      if (r && alive) {
        const res = await st.act("bisect_start", { bad: r.bad.trim(), good: r.good.trim() });
        if (res !== undefined) window.dispatchEvent(new CustomEvent(BISECT_CHANGED_EVENT));
      }
      if (alive) onClose();
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function Inspector() {
  const selection = useRepoStore((s) => s.selection);
  if (selection?.kind === "wip") return <WipPanel />;
  if (selection?.kind === "commit" || selection?.kind === "file") return <CommitDetail />;
  return <div className="h-full bg-panel"><EmptyState art="select" title="Selecciona un commit" hint="Elige un commit del grafo o el nodo WIP para ver sus cambios." /></div>;
}

function Modals() {
  const modal = useRepoStore((s) => s.modal);
  const setModal = useRepoStore((s) => s.setModal);
  const close = () => setModal(null);
  if (!modal) return null;
  return (
    <Suspense fallback={null}>
      {modal.kind === "blame" && <BlameModal path={modal.path} rev={modal.rev} onClose={close} />}
      {modal.kind === "conflict" && <ThreeWayResolver path={modal.path} onClose={close} />}
      {modal.kind === "rebase" && <InteractiveRebaseModal baseSha={modal.baseSha} onClose={close} />}
      {modal.kind === "clone" && <CloneModal onClose={close} />}
      {modal.kind === "init" && <InitModal onClose={close} />}
      {modal.kind === "remotes" && <RemotesModal onClose={close} />}
      {modal.kind === "reflog" && <ReflogModal onClose={close} />}
      {modal.kind === "patch" && <PatchModal sha={modal.sha} onClose={close} />}
      {modal.kind === "compare" && <CompareView a={modal.a} b={modal.b} onClose={close} />}
      {modal.kind === "submodules" && <SubmodulesModal onClose={close} />}
      {modal.kind === "worktrees" && <WorktreesModal onClose={close} />}
      {modal.kind === "lfs" && <LfsModal onClose={close} />}
      {modal.kind === "gitflow" && <GitflowModal onClose={close} />}
      {modal.kind === "hooks" && <HooksModal onClose={close} />}
      {modal.kind === "activity" && <ActivityLogModal onClose={close} />}
      {modal.kind === "shortcuts" && <ShortcutsModal onClose={close} />}
      {modal.kind === "preferences" && <PreferencesModal onClose={close} />}
      {modal.kind === "repoSettings" && <RepoSettingsModal onClose={close} />}
      {modal.kind === "bisect" && <BisectStarter onClose={close} />}
    </Suspense>
  );
}

export default function App() {
  useGitEvents();
  const tab = useRepoStore((s) => s.tabs.find((t) => t.info.id === s.activeId) ?? null);
  const newTabOpen = useRepoStore((s) => s.newTabOpen);
  const zoom = usePrefs((s) => s.zoom);
  const globalLeft = usePrefs((s) => s.showLeftPanel);
  const globalRight = usePrefs((s) => s.showRightPanel);
  const showLeft = tab?.repoPrefs.showLeftPanel ?? globalLeft;
  const showRight = tab?.repoPrefs.showRightPanel ?? globalRight;

  // zoom de la interfaz (80-300 %) con el zoom nativo del webview: mantiene bien las coordenadas de menús y popovers
  useEffect(() => {
    void getCurrentWebview().setZoom(zoom / 100).catch(() => undefined);
  }, [zoom]);

  const showMain = !!tab && !newTabOpen;
  return (
    <div className="flex h-full flex-col bg-app text-gray-200">
      <RepoTabBar />
      {showMain && <ActionToolbar />}
      {showMain && <OperationBanner />}
      {showMain && <BisectBanner />}
      <div className="min-h-0 flex-1">
        {!showMain ? <NewTabView /> : (
          <PanelGroup direction="horizontal" autoSaveId="caesargit-main-v2" key={`${showLeft}-${showRight}`}>
            {showLeft && (
              <>
                <Panel id="left" order={1} defaultSize={15} minSize={10} maxSize={35} className="bg-panel">
                  <div data-pane="sidebar" tabIndex={-1} className="h-full outline-none"><Sidebar /></div>
                </Panel>
                <PanelResizeHandle className={handleV} />
              </>
            )}
            <Panel id="center" order={2} defaultSize={57} minSize={30} className="relative">
              <CommitGraph />
            </Panel>
            {showRight && (
              <>
                <PanelResizeHandle className={handleV} />
                <Panel id="right" order={3} defaultSize={28} minSize={18} maxSize={55} className="bg-panel">
                  <div data-pane="inspector" tabIndex={-1} className="h-full outline-none"><Inspector /></div>
                </Panel>
              </>
            )}
          </PanelGroup>
        )}
      </div>
      <StatusBar />
      <Modals />
      <CommandPalette />
      <UpdatePrompt />
      <DialogHost />
      <Toasts />
    </div>
  );
}
