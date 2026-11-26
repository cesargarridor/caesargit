import { useState, type ReactNode } from "react";
import { Check, Download, Keyboard, Loader2, Palette, PenTool, RefreshCw, Settings, ShieldCheck, Wrench } from "lucide-react";
import { THEMES, resolveTheme } from "../../lib/themes";
import { useUpdater } from "../../lib/updater";
import { ZOOM_MAX, ZOOM_MIN, clampZoom, usePrefs } from "../../store/usePrefs";
import { useRepoStore } from "../../store/useRepoStore";
import { useToolPrefs, type ToolPrefs } from "../../store/useToolPrefs";
import type { PullMode } from "../../types/git";
import { Swatch } from "./SettingsModal";
import { Btn, Check as Chk, Modal, Select, inputCls } from "../tools/ui";
import { SHORTCUT_GROUPS } from "../tools/shortcuts";
import { KeyCaps } from "../tools/ShortcutsModal";

type Section = "general" | "ui" | "tools" | "signing" | "updates" | "shortcuts";
const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <Settings size={14} /> },
  { id: "ui", label: "UI Customization", icon: <Palette size={14} /> },
  { id: "tools", label: "External Tools", icon: <Wrench size={14} /> },
  { id: "signing", label: "Commit Signing", icon: <ShieldCheck size={14} /> },
  { id: "updates", label: "Actualizaciones", icon: <Download size={14} /> },
  { id: "shortcuts", label: "Atajos", icon: <Keyboard size={14} /> },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line/50 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-gray-500">{hint}</div>}
      </div>
      <div className="w-56 shrink-0">{children}</div>
    </div>
  );
}
const H = ({ children }: { children: ReactNode }) => <h3 className="mb-1 text-sm font-semibold text-gray-100">{children}</h3>;

async function applyToRepo(entries: [string, string | null][]) {
  const st = useRepoStore.getState();
  if (!st.activeId) { st.toast("Abre un repositorio para aplicar estos ajustes"); return; }
  for (const [key, value] of entries) {
    if ((await st.act("set_repo_config", { key, value })) === undefined) return;
  }
  st.toast("Aplicado al repositorio activo", "info");
}

export default function PreferencesModal({ onClose }: { onClose?: () => void }) {
  const [sec, setSec] = useState<Section>("general");
  const p = useToolPrefs();
  const set = (v: Partial<ToolPrefs>) => p.set(v);
  const { themeId, accent, checkUpdates, zoom, defaultPull, autoFetchMinutes, set: setPrefs } = usePrefs();
  const up = useUpdater();
  const effAccent = accent ?? resolveTheme(themeId).accent;
  const hasRepo = useRepoStore((s) => s.activeId !== null);

  return (
    <Modal title="Preferencias" icon={<Settings size={15} />} onClose={onClose} width={920}
      footer={<><Btn small onClick={() => { p.reset(); setPrefs({ zoom: 100, defaultPull: "ff", autoFetchMinutes: 0 }); }}>Restablecer valores</Btn><Btn variant="primary" onClick={onClose}>Cerrar</Btn></>}>
      <div className="-m-4 flex h-[62vh]">
        <nav className="w-52 shrink-0 space-y-0.5 border-r border-line bg-panel p-2">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setSec(n.id)}
              className={`flex w-full items-center gap-2 rounded-md border-l-2 px-3 py-2 text-left text-xs transition ${sec === n.id ? "border-amber bg-amber/10 text-gray-100" : "border-transparent text-gray-400 hover:bg-line/60 hover:text-gray-200"}`}>
              {n.icon}{n.label}
            </button>
          ))}
        </nav>
        <div key={sec} className="min-w-0 flex-1 overflow-auto p-5 animate-fade-in">
          {sec === "general" && (
            <>
              <H>General</H>
              <Row label="Zoom de la interfaz" hint={`${zoom} %`}>
                <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={10} value={zoom} onChange={(e) => setPrefs({ zoom: clampZoom(Number(e.target.value)) })} className="w-full accent-amber" />
              </Row>
              <Row label="Auto-fetch" hint="Fetch periódico de los repositorios abiertos">
                <Select value={String(autoFetchMinutes)} onChange={(v) => setPrefs({ autoFetchMinutes: Number(v) })}
                  options={[0, 1, 2, 5, 10, 15, 30, 60].map((m) => ({ value: String(m), label: m === 0 ? "Desactivado" : `Cada ${m} min` }))} />
              </Row>
              <Row label="Pull por defecto">
                <Select value={defaultPull} onChange={(v) => setPrefs({ defaultPull: v as PullMode })}
                  options={[{ value: "ff", label: "Fast-forward si es posible" }, { value: "rebase", label: "Rebase" }, { value: "merge", label: "Merge" }]} />
              </Row>
              <Row label="Formato de fecha">
                <Select value={p.dateFormat} onChange={(v) => set({ dateFormat: v as ToolPrefs["dateFormat"] })}
                  options={[{ value: "relative", label: "Relativa (hace 2 h)" }, { value: "short", label: "Local corta" }, { value: "iso", label: "ISO 8601" }]} />
              </Row>
              <Row label="Rama por defecto" hint="Para repositorios nuevos (init.defaultBranch)">
                <input className={inputCls} value={p.defaultBranch} onChange={(e) => set({ defaultBranch: e.target.value })} />
              </Row>
              <Row label="Fuente de la interfaz" hint="Vacío = Inter / sistema">
                <input className={inputCls} value={p.uiFont} placeholder="Inter" onChange={(e) => set({ uiFont: e.target.value })} />
              </Row>
            </>
          )}

          {sec === "ui" && (
            <div className="space-y-6">
              <div>
                <H>Tema</H>
                <div className="mt-2 grid grid-cols-3 gap-3">
                  {THEMES.map((t) => {
                    const sel = t.id === themeId;
                    return (
                      <button key={t.id} onClick={() => setPrefs({ themeId: t.id })}
                        className={`rounded-lg border p-1.5 text-left transition hover:-translate-y-0.5 hover:border-amber/60 ${sel ? "border-amber shadow-glow" : "border-line"}`}>
                        <Swatch id={t.id} />
                        <div className="mt-1.5 flex items-center gap-1 px-0.5 text-xs text-gray-200">
                          <span className="truncate">{t.name}</span>{sel && <Check size={12} className="ml-auto shrink-0 text-amber" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <H>Color de acento</H>
                <div className="mt-2 flex items-center gap-3 text-xs text-gray-300">
                  <input type="color" value={effAccent} onChange={(e) => setPrefs({ accent: e.target.value })} className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent" aria-label="Acento personalizado" />
                  <span className="font-mono text-gray-400">{effAccent}</span>
                  {accent && <Btn small onClick={() => setPrefs({ accent: null })}>Restablecer al del tema</Btn>}
                </div>
              </div>
              <div>
                <H>Densidad y columnas</H>
                <Row label="Densidad">
                  <Select value={p.density} onChange={(v) => set({ density: v as ToolPrefs["density"] })}
                    options={[{ value: "compact", label: "Compacta" }, { value: "normal", label: "Normal" }, { value: "comfortable", label: "Cómoda" }]} />
                </Row>
                <div className="space-y-2 py-3">
                  <div className="text-xs text-gray-200">Columnas del grafo</div>
                  <Chk checked={p.showAuthor} onChange={(v) => set({ showAuthor: v })}>Autor</Chk>
                  <Chk checked={p.showDate} onChange={(v) => set({ showDate: v })}>Fecha</Chk>
                  <Chk checked={p.showSha} onChange={(v) => set({ showSha: v })}>SHA</Chk>
                </div>
              </div>
            </div>
          )}

          {sec === "tools" && (
            <>
              <H>Herramientas externas</H>
              <Row label="Editor de código" hint="Para «Abrir en editor»">
                <Select value={p.editor} onChange={(v) => set({ editor: v })}
                  options={[{ value: "", label: "Editor de texto del sistema" }, ...["code", "cursor", "windsurf", "zed", "subl", "idea", "webstorm", "pycharm"].map((e) => ({ value: e, label: e }))]} />
              </Row>
              <Row label="Terminal" hint="Vacío = terminal del sistema">
                <input className={inputCls} value={p.terminal} placeholder="Terminal del sistema" onChange={(e) => set({ terminal: e.target.value })} />
              </Row>
              <Row label="Herramienta de diff" hint="diff.tool de git (ej. vscode, meld)">
                <input className={inputCls} value={p.diffTool} onChange={(e) => set({ diffTool: e.target.value })} />
              </Row>
              <Row label="Herramienta de merge" hint="merge.tool de git">
                <input className={inputCls} value={p.mergeTool} onChange={(e) => set({ mergeTool: e.target.value })} />
              </Row>
              <Row label="Ruta del ejecutable de git" hint="Vacío = git del PATH">
                <input className={inputCls} value={p.gitPath} placeholder="git" onChange={(e) => set({ gitPath: e.target.value })} />
              </Row>
              <div className="pt-3">
                <Btn disabled={!hasRepo} title={hasRepo ? undefined : "Abre un repositorio"}
                  onClick={() => void applyToRepo([["diff.tool", p.diffTool.trim() || null], ["merge.tool", p.mergeTool.trim() || null]])}>
                  <PenTool size={12} /> Aplicar diff/merge al repositorio activo
                </Btn>
              </div>
            </>
          )}

          {sec === "signing" && (
            <>
              <H>Firma de commits (valores por defecto)</H>
              <Row label="Firmar commits"><Chk checked={p.signCommits} onChange={(v) => set({ signCommits: v })}>commit.gpgsign</Chk></Row>
              <Row label="Firmar tags"><Chk checked={p.signTags} onChange={(v) => set({ signTags: v })}>tag.gpgsign</Chk></Row>
              <Row label="Formato">
                <Select value={p.gpgFormat} onChange={(v) => set({ gpgFormat: v as ToolPrefs["gpgFormat"] })}
                  options={[{ value: "openpgp", label: "GPG (openpgp)" }, { value: "ssh", label: "SSH" }, { value: "x509", label: "x509" }]} />
              </Row>
              <Row label="Clave de firma" hint="ID GPG o ruta de clave pública SSH">
                <input className={inputCls} value={p.signingKey} onChange={(e) => set({ signingKey: e.target.value })} />
              </Row>
              <div className="pt-3">
                <Btn disabled={!hasRepo} title={hasRepo ? undefined : "Abre un repositorio"}
                  onClick={() => void applyToRepo([
                    ["commit.gpgsign", String(p.signCommits)], ["tag.gpgsign", String(p.signTags)], ["gpg.format", p.gpgFormat],
                    ["user.signingkey", p.signingKey.trim() || null],
                  ])}>
                  <ShieldCheck size={12} /> Aplicar al repositorio activo
                </Btn>
              </div>
            </>
          )}

          {sec === "updates" && (
            <div className="space-y-3 text-xs text-gray-300">
              <H>Actualizaciones</H>
              <div className="flex items-center gap-3">
                <span>Versión actual <span className="font-mono text-gray-100">{up.current || "—"}</span></span>
                <button disabled={up.checking || up.installing} onClick={() => void up.check(true)}
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 hover:bg-line disabled:opacity-40">
                  {up.checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Buscar actualizaciones
                </button>
              </div>
              {up.available && (
                <div className="rounded-md border border-amber/40 bg-amber/10 p-3 animate-fade-in">
                  <div className="font-semibold text-gray-100">Nueva versión {up.available.version}</div>
                  {up.available.notes && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-sans text-gray-400">{up.available.notes}</pre>}
                  <div className="mt-2 flex items-center gap-2">
                    <button disabled={up.installing} onClick={() => void up.install()}
                      className="flex items-center gap-1.5 rounded-md bg-amber px-3 py-1 font-semibold text-onacc hover:bg-amber-hover disabled:opacity-60">
                      {up.installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                      {up.installing ? `Instalando${up.progress != null ? ` ${up.progress}%` : "…"}` : "Instalar y reiniciar"}
                    </button>
                    {!up.installing && <button className="rounded-md px-3 py-1 hover:bg-line" onClick={up.dismiss}>Más tarde</button>}
                  </div>
                  {up.installing && up.progress != null && <div className="mt-2 h-1 overflow-hidden rounded bg-line"><div className="h-full bg-amber transition-all" style={{ width: `${up.progress}%` }} /></div>}
                </div>
              )}
              {!up.available && !up.checking && !up.error && <div className="text-gray-500">Estás al día.</div>}
              {up.error && <div className="text-git-deleted">{up.error}</div>}
              <Chk checked={checkUpdates} onChange={(v) => setPrefs({ checkUpdates: v })}>Comprobar actualizaciones automáticamente</Chk>
            </div>
          )}

          {sec === "shortcuts" && (
            <div className="space-y-5">
              <H>Atajos de teclado</H>
              {SHORTCUT_GROUPS.map((g) => (
                <section key={g.title}>
                  <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">{g.title}</h4>
                  <div className="space-y-1">
                    {g.items.map((i) => (
                      <div key={i.keys + i.label} className="flex items-center justify-between rounded px-1 py-0.5 hover:bg-line/40">
                        <span>{i.label}</span><KeyCaps keys={i.keys} />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
