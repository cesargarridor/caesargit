import { Redo2, Undo2 } from "lucide-react";
import { useRepoStore } from "../../store/useRepoStore";

/** Botones Undo/Redo con la etiqueta de la acción (pila real del backend). */
export function UndoRedoButtons() {
  const undoState = useRepoStore((s) => s.undoState);
  const hasTab = useRepoStore((s) => s.activeId !== null);
  const { undo, redo } = useRepoStore.getState();
  const btn = "flex h-[38px] w-[64px] flex-col items-center justify-center gap-0.5 rounded text-gray-200 hover:bg-elev disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <>
      <button className={btn} disabled={!hasTab || !undoState.undoLabel} onClick={() => void undo()}
        title={undoState.undoLabel ? `Deshacer: ${undoState.undoLabel} (⌘Z)` : "Nada que deshacer"}>
        <Undo2 size={17} strokeWidth={1.75} />
        <span className="max-w-full truncate px-1 text-[10px] leading-none text-gray-400">{undoState.undoLabel ?? "Undo"}</span>
      </button>
      <button className={btn} disabled={!hasTab || !undoState.redoLabel} onClick={() => void redo()}
        title={undoState.redoLabel ? `Rehacer: ${undoState.redoLabel} (⌘⇧Z)` : "Nada que rehacer"}>
        <Redo2 size={17} strokeWidth={1.75} />
        <span className="max-w-full truncate px-1 text-[10px] leading-none text-gray-400">{undoState.redoLabel ?? "Redo"}</span>
      </button>
    </>
  );
}
