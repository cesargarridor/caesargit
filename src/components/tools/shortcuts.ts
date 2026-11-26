export interface ShortcutGroup { title: string; items: { keys: string; label: string }[] }

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Convierte "Mod+Shift+K" a la notación de la plataforma. */
export function fmtKeys(k: string): string {
  const map: Record<string, string> = isMac
    ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", Enter: "↵", Plus: "+", Minus: "-", Up: "↑", Down: "↓", Left: "←", Right: "→", Esc: "Esc" }
    : { Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl", Enter: "Enter", Plus: "+", Minus: "-", Up: "↑", Down: "↓", Left: "←", Right: "→", Esc: "Esc" };
  return k.split("+").map((p) => map[p] ?? p).join(isMac ? "" : "+");
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "Mod+K", label: "Paleta de comandos" }, { keys: "Mod+P", label: "Paleta de comandos" },
      { keys: "Mod+/", label: "Lista de atajos" }, { keys: "Mod+,", label: "Preferencias" },
      { keys: "Mod+Shift+O", label: "Abrir repositorio" }, { keys: "Mod+O", label: "Abrir repositorio" },
      { keys: "Esc", label: "Cerrar panel o diálogo" },
    ],
  },
  {
    title: "Pestañas",
    items: [
      { keys: "Mod+T", label: "Nueva pestaña" }, { keys: "Mod+W", label: "Cerrar pestaña" },
      { keys: "Mod+1…9", label: "Ir a la pestaña N" }, { keys: "Ctrl+Tab", label: "Pestaña siguiente" },
      { keys: "Ctrl+Shift+Tab", label: "Pestaña anterior" },
    ],
  },
  {
    title: "Ramas y red",
    items: [
      { keys: "Mod+B", label: "Crear rama" }, { keys: "Mod+L", label: "Fetch all" },
      { keys: "Mod+Z", label: "Deshacer última acción" }, { keys: "Mod+Shift+Z", label: "Rehacer" },
    ],
  },
  {
    title: "Commits y cambios",
    items: [
      { keys: "Mod+Enter", label: "Hacer commit" }, { keys: "Mod+Shift+Enter", label: "Stage all y commit" },
      { keys: "Mod+Shift+M", label: "Foco en el mensaje de commit" },
      { keys: "S", label: "Stage del archivo actual" }, { keys: "U", label: "Unstage del archivo actual" },
      { keys: "Mod+Shift+S", label: "Stage de todo" }, { keys: "Mod+Shift+U", label: "Unstage de todo" },
      { keys: "Mod+D", label: "Abrir en difftool externo" },
    ],
  },
  {
    title: "Navegación del grafo",
    items: [
      { keys: "J", label: "Commit siguiente" }, { keys: "K", label: "Commit anterior" },
      { keys: "H", label: "Panel izquierdo" }, { keys: "L", label: "Panel derecho" },
      { keys: "Mod+Up", label: "Primer commit" }, { keys: "Mod+Down", label: "Último commit" },
      { keys: "Mod+F", label: "Buscar commits" }, { keys: "Mod+Shift+H", label: "Buscar archivo (historial / blame)" },
    ],
  },
  {
    title: "Vista",
    items: [
      { keys: "Mod+J", label: "Mostrar / ocultar panel izquierdo" }, { keys: "Mod+Alt+F", label: "Filtro del panel izquierdo" },
      { keys: "Mod+Plus", label: "Aumentar zoom" }, { keys: "Mod+Minus", label: "Reducir zoom" }, { keys: "Mod+0", label: "Zoom 100 %" },
      { keys: "Alt+T", label: "Abrir terminal" }, { keys: "Alt+O", label: "Abrir en el explorador de archivos" },
    ],
  },
];
