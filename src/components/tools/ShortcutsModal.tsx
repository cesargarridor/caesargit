import { useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { Modal, inputCls } from "./ui";
import { SHORTCUT_GROUPS, fmtKeys } from "./shortcuts";
import type { ToolProps } from "./types";

export function KeyCaps({ keys }: { keys: string }) {
  return (
    <span className="flex shrink-0 gap-1">
      {fmtKeys(keys).split(/(?<=[⌘⇧⌥⌃↵↑↓←→])|\+/).filter(Boolean).map((k, i) => (
        <kbd key={i} className="min-w-[22px] rounded border border-line bg-app px-1.5 py-0.5 text-center font-mono text-[11px] text-gray-200 shadow-sm">{k}</kbd>
      ))}
    </span>
  );
}

export default function ShortcutsModal({ onClose }: ToolProps) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    return SHORTCUT_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !t || `${i.label} ${fmtKeys(i.keys)}`.toLowerCase().includes(t)) })).filter((g) => g.items.length);
  }, [q]);
  return (
    <Modal title="Atajos de teclado" icon={<Keyboard size={15} />} onClose={onClose} width={720}>
      <input autoFocus className={inputCls} placeholder="Buscar atajo…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {groups.map((g) => (
          <section key={g.title} className="animate-fade-in">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">{g.title}</h3>
            <div className="space-y-1">
              {g.items.map((i) => (
                <div key={i.keys + i.label} className="flex items-center justify-between gap-3 rounded px-1 py-0.5 hover:bg-line/40">
                  <span className="text-gray-300">{i.label}</span>
                  <KeyCaps keys={i.keys} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
