import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme } from "./lib/themes";
import { usePrefs } from "./store/usePrefs";
import "./index.css";
if (/Mac/i.test(navigator.platform)) document.documentElement.classList.add("is-mac");

// Aplica el tema antes de pintar y cada vez que cambia
let last = { themeId: "", accent: null as string | null };
const apply = (p: { themeId: string; accent: string | null }) => {
  if (p.themeId === last.themeId && p.accent === last.accent) return;
  last = { themeId: p.themeId, accent: p.accent };
  applyTheme(p.themeId, p.accent);
};
apply(usePrefs.getState());
usePrefs.subscribe(apply);
// Con «Automático», sigue el modo claro/oscuro del sistema en vivo
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const p = usePrefs.getState();
  if (p.themeId === "auto") applyTheme(p.themeId, p.accent);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
