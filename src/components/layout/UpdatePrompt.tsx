import React, { useEffect } from "react";
import { ArrowDownToLine } from "lucide-react";
import { checkUpdatesEnabled, useUpdater } from "../../lib/updater";

/** Actualizaciones automáticas: a los 3 s de abrir y cada 6 h busca una versión nueva y PREGUNTA
 *  «Actualizar ahora / Más tarde». Nunca instala por su cuenta. */
const UpdatePrompt: React.FC = () => {
  const { available, installing, progress, error, check, install, dismiss } = useUpdater();

  useEffect(() => {
    const run = () => {
      if (checkUpdatesEnabled()) void check(false);
    };
    const first = window.setTimeout(run, 3000);
    const every = window.setInterval(run, 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!available && !installing) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-line bg-elev p-3 shadow-glow animate-[fadeIn_.25s_ease-out]">
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      <div className="flex items-start gap-2">
        <ArrowDownToLine size={16} className="mt-0.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-neutral-100">
            {installing ? "Instalando actualización…" : `CaesarGit ${available?.version} disponible`}
          </div>
          {!installing && available?.notes && (
            <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-neutral-400">{available.notes}</p>
          )}
          {installing && (
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-line">
              <div className="h-full bg-amber transition-all" style={{ width: `${progress ?? 5}%` }} />
            </div>
          )}
          {error && <p className="mt-1 text-xs text-git-deleted">{error}</p>}
        </div>
      </div>
      {!installing && (
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={dismiss} className="rounded px-2.5 py-1 text-xs text-neutral-400 hover:text-neutral-100">
            Más tarde
          </button>
          <button
            onClick={() => void install()}
            className="rounded bg-amber px-2.5 py-1 text-xs font-medium text-onacc hover:bg-amber-hover"
          >
            Actualizar ahora
          </button>
        </div>
      )}
    </div>
  );
};

export default UpdatePrompt;
