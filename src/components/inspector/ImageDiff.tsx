import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "../../store/useRepoStore";
import { DiffSkeleton } from "../layout/Visuals";

export interface ImageRevs { oldRev: string | null; newRev: string | null; oldPath?: string; newPath: string }
interface Blob { base64: string; mime: string; size: number }
type Mode = "side" | "swipe" | "onion";

function useBlob(rev: string | null, path: string) {
  const run = useRepoStore((s) => s.run);
  const [v, setV] = useState<{ blob: Blob | null; loading: boolean }>({ blob: null, loading: rev !== null });
  useEffect(() => {
    if (rev === null) { setV({ blob: null, loading: false }); return; }
    let live = true;
    setV({ blob: null, loading: true });
    run<Blob>("get_file_blob_base64", { rev, path })
      .then((b) => live && setV({ blob: b, loading: false }))
      .catch(() => live && setV({ blob: null, loading: false }));
    return () => { live = false; };
  }, [rev, path, run]);
  return v;
}

const src = (b: Blob) => `data:${b.mime};base64,${b.base64}`;
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

/** Diff de imágenes: lado a lado, deslizador (swipe) y transparencia (onion skin). */
export default function ImageDiff({ revs }: { revs: ImageRevs }) {
  const o = useBlob(revs.oldRev, revs.oldPath ?? revs.newPath);
  const n = useBlob(revs.newRev, revs.newPath);
  const [mode, setMode] = useState<Mode>("side");
  const [pos, setPos] = useState(50);
  const [alpha, setAlpha] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ o?: string; n?: string }>({});

  if (o.loading || n.loading) return <DiffSkeleton />;
  if (!o.blob && !n.blob) return <div className="p-4 text-xs text-gray-500">No se pudo cargar la imagen (¿binario demasiado grande?).</div>;

  const img = (b: Blob | null, side: "o" | "n", cls = "") =>
    b ? (
      <img src={src(b)} alt="" className={`max-h-full max-w-full object-contain ${cls}`}
        onLoad={(e) => setDims((d) => ({ ...d, [side]: `${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}` }))} />
    ) : (
      <div className="flex h-full items-center justify-center text-xs text-gray-500">{side === "o" ? "Archivo nuevo" : "Archivo eliminado"}</div>
    );
  const label = (t: string, b: Blob | null, d?: string) => (
    <div className="text-center text-[10px] text-gray-400">{t}{b ? ` · ${kb(b.size)}${d ? ` · ${d}` : ""}` : ""}</div>
  );
  const checker = { backgroundImage: "repeating-conic-gradient(rgb(var(--c-elev)) 0% 25%, rgb(var(--c-panel)) 0% 50%)", backgroundSize: "16px 16px" };
  const both = o.blob && n.blob;
  const modeBtn = (m: Mode, l: string) => (
    <button key={m} disabled={m !== "side" && !both} onClick={() => setMode(m)}
      className={`px-2 py-0.5 text-xs disabled:opacity-40 ${mode === m ? "bg-elev text-amber" : "text-gray-400"}`}>{l}</button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-2 py-1">
        <div className="flex overflow-hidden rounded border border-line">
          {modeBtn("side", "Side-by-side")}{modeBtn("swipe", "Swipe")}{modeBtn("onion", "Onion skin")}
        </div>
        {mode === "swipe" && both && <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(+e.target.value)} className="accent-amber" />}
        {mode === "onion" && both && <input type="range" min={0} max={100} value={alpha} onChange={(e) => setAlpha(+e.target.value)} className="accent-amber" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3" style={checker}>
        {mode === "side" || !both ? (
          <div className="grid h-full grid-cols-2 gap-3">
            <div className="flex min-h-0 flex-col gap-1">
              {label("Antes", o.blob, dims.o)}
              <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-git-deleted/40">{img(o.blob, "o")}</div>
            </div>
            <div className="flex min-h-0 flex-col gap-1">
              {label("Después", n.blob, dims.n)}
              <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-git-added/40">{img(n.blob, "n")}</div>
            </div>
          </div>
        ) : mode === "swipe" ? (
          <div ref={box} className="relative mx-auto flex h-full w-full items-center justify-center">
            <div className="relative inline-block max-h-full max-w-full">
              {img(n.blob, "n")}
              <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
                <img src={src(o.blob!)} alt="" className="h-full w-full object-contain" />
              </div>
              <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber" style={{ left: `${pos}%` }} />
            </div>
          </div>
        ) : (
          <div className="relative mx-auto flex h-full w-full items-center justify-center">
            <div className="relative inline-block max-h-full max-w-full">
              {img(o.blob, "o")}
              <img src={src(n.blob!)} alt="" className="absolute inset-0 h-full w-full object-contain" style={{ opacity: alpha / 100 }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
