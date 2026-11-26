import { useEffect, useMemo, useRef, useState } from "react";
import { History, Search } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";
import { FileHistoryModal } from "./FileHistoryModal";

/**
 * Búsqueda de archivo (⌘/Ctrl+⇧+H): escribe una ruta (o elige una sugerida) y pulsa Enter para su historial,
 * ⇧Enter para el blame. Se monta dentro de los paneles del inspector.
 */
export default function FileFinder({ suggestions }: { suggestions: string[] }) {
  const setModal = useRepoStore((s) => s.setModal);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [history, setHistory] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setOpen(true); setQ(""); setIdx(0);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const uniq = [...new Set(suggestions)];
    return (t ? uniq.filter((p) => p.toLowerCase().includes(t)) : uniq).slice(0, 50);
  }, [suggestions, q]);

  const choose = (path: string, blame: boolean) => {
    const p = path.trim();
    if (!p) return;
    setOpen(false);
    if (blame) setModal({ kind: "blame", path: p });
    else setHistory(p);
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim/60 pt-[15vh] animate-fade-in" onMouseDown={() => setOpen(false)}>
          <div data-file-finder className="w-[520px] max-w-[92vw] rounded-lg border border-line bg-elev shadow-2xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search size={14} className="text-amber" />
              <input
                ref={input}
                value={q}
                onChange={(e) => { setQ(e.target.value); setIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
                  else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, list.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); choose(list[idx] ?? q, e.shiftKey); }
                }}
                placeholder="Archivo para historial / blame (Enter = historial, ⇧Enter = blame)"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
              />
            </div>
            <div className="max-h-[40vh] overflow-y-auto py-1">
              {list.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">{q.trim() ? "Enter para usar la ruta escrita." : "Escribe la ruta relativa de un archivo."}</div>
              )}
              {list.map((p, i) => (
                <div key={p} onMouseEnter={() => setIdx(i)} onClick={() => choose(p, false)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-xs ${i === idx ? "bg-panel text-amber" : "text-gray-300"}`}>
                  <History size={12} /> <span className="min-w-0 flex-1 truncate">{p}</span>
                  <button className="rounded border border-line px-1.5 text-[10px] text-gray-400 hover:text-amber" onClick={(e) => { e.stopPropagation(); choose(p, true); }}>Blame</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {history && <FileHistoryModal path={history} onClose={() => setHistory(null)} />}
    </>
  );
}
