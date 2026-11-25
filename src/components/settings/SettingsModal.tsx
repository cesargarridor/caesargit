import { useEffect } from "react";
import { Check, Download, Loader2, RefreshCw, X } from "lucide-react";
import { THEMES, resolveTheme } from "../../lib/themes";
import { useUpdater } from "../../lib/updater";
import { usePrefs, useSettingsUi } from "../../store/usePrefs";

function Swatch({ id }: { id: string }) {
  const t = resolveTheme(id);
  const custom = usePrefs((s) => s.accent);
  const cur = usePrefs((s) => s.themeId);
  const acc = custom && id === cur ? custom : t.accent;
  return (
    <div className="overflow-hidden rounded-md border" style={{ background: t.bg, borderColor: t.line ?? t.panel }}>
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ background: t.panel ?? t.bg }}>
        {t.lanes.slice(0, 4).map((c) => <span key={c} className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />)}
        <span className="ml-auto h-1.5 w-6 rounded-full" style={{ background: acc }} />
      </div>
      <div className="space-y-1 p-2">
        <div className="h-1.5 w-3/4 rounded" style={{ background: t.text, opacity: 0.8 }} />
        <div className="h-1.5 w-1/2 rounded" style={{ background: t.text, opacity: 0.35 }} />
        <div className="flex gap-1 pt-0.5">
          {t.git.map((c) => <span key={c} className="h-1.5 flex-1 rounded-full" style={{ background: c }} />)}
        </div>
      </div>
    </div>
  );
}

export default function SettingsModal() {
  const open = useSettingsUi((s) => s.open);
  const setOpen = useSettingsUi((s) => s.setOpen);
  const { themeId, accent, checkUpdates, set } = usePrefs();
  const up = useUpdater();

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, setOpen]);

  if (!open) return null;
  const effAccent = accent ?? resolveTheme(themeId).accent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 animate-fade-in" onMouseDown={() => setOpen(false)}>
      <div className="flex max-h-[86vh] w-[680px] max-w-[94vw] flex-col rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-100">Ajustes</h2>
          <button onClick={() => setOpen(false)} className="ml-auto text-gray-400 hover:text-amber" aria-label="Cerrar"><X size={15} /></button>
        </div>
        <div className="space-y-6 overflow-auto p-4">
          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Tema</h3>
            <div className="grid grid-cols-3 gap-3">
              {THEMES.map((t) => {
                const sel = t.id === themeId;
                return (
                  <button key={t.id} onClick={() => set({ themeId: t.id })}
                    className={`group rounded-lg border p-1.5 text-left transition hover:-translate-y-0.5 hover:border-amber/60 ${sel ? "border-amber shadow-glow" : "border-line"}`}>
                    <Swatch id={t.id} />
                    <div className="mt-1.5 flex items-center gap-1 px-0.5 text-xs text-gray-200">
                      <span className="truncate">{t.name}</span>
                      {sel && <Check size={12} className="ml-auto shrink-0 text-amber" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Color de acento</h3>
            <div className="flex items-center gap-3 text-xs text-gray-300">
              <input type="color" value={effAccent} onChange={(e) => set({ accent: e.target.value })}
                className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent" aria-label="Acento personalizado" />
              <span className="font-mono text-gray-400">{effAccent}</span>
              {accent && <button className="rounded-md border border-line px-2 py-1 hover:bg-line" onClick={() => set({ accent: null })}>Restablecer al del tema</button>}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Actualizaciones</h3>
            <div className="space-y-3 text-xs text-gray-300">
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
                  {up.installing && up.progress != null && (
                    <div className="mt-2 h-1 overflow-hidden rounded bg-line"><div className="h-full bg-amber transition-all" style={{ width: `${up.progress}%` }} /></div>
                  )}
                </div>
              )}
              {!up.available && !up.checking && !up.error && <div className="text-gray-500">Estás al día.</div>}
              {up.error && <div className="text-git-deleted">{up.error}</div>}
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="accent-amber" checked={checkUpdates} onChange={(e) => set({ checkUpdates: e.target.checked })} />
                Comprobar actualizaciones automáticamente
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
