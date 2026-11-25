import type { ReactNode } from "react";

/** Piezas visuales compartidas: avatar por hash, skeletons con shimmer, estados vacíos con ilustración SVG. */

export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, email, size = 20 }: { name: string; email?: string; size?: number }) {
  const h = hue(email || name);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-1 ring-white/10"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: `linear-gradient(135deg, hsl(${h} 55% 46%), hsl(${(h + 40) % 360} 50% 32%))` }}
      title={email ? `${name} <${email}>` : name}
    >
      {initials(name)}
    </span>
  );
}

export function GraphSkeleton() {
  return (
    <div className="h-full overflow-hidden bg-app py-1">
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3" style={{ height: 30 }}>
          <div className="skeleton h-3 w-3 shrink-0 !rounded-full" />
          <div className="skeleton h-3" style={{ width: `${30 + ((i * 37) % 45)}%` }} />
          <div className="skeleton ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function DiffSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 9 }, (_, i) => <div key={i} className="skeleton h-3" style={{ width: `${40 + ((i * 53) % 55)}%` }} />)}
    </div>
  );
}

type Art = "commits" | "select" | "diff" | "repo";

export function EmptyArt({ art }: { art: Art }) {
  const stroke = "rgb(var(--c-line))";
  const acc = "rgb(var(--c-accent))";
  const mute = "rgb(var(--c-gray-500))";
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" fill="none" className="animate-float" aria-hidden>
      <circle cx="60" cy="48" r="40" style={{ fill: "rgb(var(--c-accent) / .06)" }} />
      {art === "commits" && (
        <>
          <path d="M40 18V78M40 40C40 54 80 44 80 60" style={{ stroke }} strokeWidth="3" strokeLinecap="round" />
          <circle cx="40" cy="22" r="7" style={{ stroke: acc, fill: "rgb(var(--c-app))" }} strokeWidth="3" />
          <circle cx="40" cy="74" r="7" style={{ stroke: mute, fill: "rgb(var(--c-app))" }} strokeWidth="3" strokeDasharray="3 3" />
          <circle cx="80" cy="62" r="7" style={{ stroke: mute, fill: "rgb(var(--c-app))" }} strokeWidth="3" strokeDasharray="3 3" />
        </>
      )}
      {art === "select" && (
        <>
          <rect x="26" y="22" width="68" height="52" rx="8" style={{ stroke, fill: "rgb(var(--c-panel))" }} strokeWidth="2" />
          <path d="M36 36h30M36 46h46M36 56h22" style={{ stroke: mute }} strokeWidth="3" strokeLinecap="round" />
          <circle cx="86" cy="66" r="12" style={{ fill: acc }} />
          <path d="M81 66l4 4 7-8" style={{ stroke: "rgb(var(--c-on-accent))" }} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {art === "diff" && (
        <>
          <rect x="24" y="20" width="72" height="56" rx="8" style={{ stroke, fill: "rgb(var(--c-panel))" }} strokeWidth="2" />
          <path d="M34 36h22" style={{ stroke: "rgb(var(--c-git-added))" }} strokeWidth="3" strokeLinecap="round" />
          <path d="M34 48h34" style={{ stroke: mute }} strokeWidth="3" strokeLinecap="round" />
          <path d="M34 60h18" style={{ stroke: "rgb(var(--c-git-deleted))" }} strokeWidth="3" strokeLinecap="round" />
        </>
      )}
      {art === "repo" && (
        <>
          <path d="M24 38a6 6 0 016-6h16l6 7h38a6 6 0 016 6v28a6 6 0 01-6 6H30a6 6 0 01-6-6V38z" style={{ stroke: acc, fill: "rgb(var(--c-panel))" }} strokeWidth="2.5" strokeLinejoin="round" />
          <circle cx="48" cy="58" r="4" style={{ fill: acc }} /><circle cx="72" cy="52" r="4" style={{ fill: mute }} /><circle cx="72" cy="66" r="4" style={{ fill: mute }} />
          <path d="M48 58V50c0 0 0-2 4-2h16M48 58c0 6 8 8 20 8" style={{ stroke: mute }} strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function EmptyState({ art, title, hint, children }: { art: Art; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center animate-fade-in">
      <EmptyArt art={art} />
      <div className="text-sm font-semibold text-gray-200">{title}</div>
      {hint && <div className="max-w-[260px] text-xs leading-relaxed text-gray-500">{hint}</div>}
      {children}
    </div>
  );
}
