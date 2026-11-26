// Comprueba que cada comando de generate_handler! (lib.rs) está en build.rs y en capabilities/default.json.
import { readFileSync } from "node:fs";
const rd = (p) => readFileSync(new URL(`../src-tauri/${p}`, import.meta.url), "utf8");
const lib = rd("src/lib.rs"), build = rd("build.rs"), cap = JSON.parse(rd("capabilities/default.json")).permissions;
const body = /generate_handler!\[([\s\S]*?)\]\)/.exec(lib)[1].replace(/\/\/.*$/gm, "");
const cmds = body.split(",").map((x) => x.trim().split("::").pop()).filter(Boolean);
const miss = [];
for (const c of cmds) {
  if (!build.includes(`"${c}"`)) miss.push(`build.rs: ${c}`);
  if (!cap.includes(`allow-${c.replaceAll("_", "-")}`)) miss.push(`capabilities: allow-${c.replaceAll("_", "-")}`);
}
if (miss.length) { console.error("Faltan en el ACL:\n" + miss.join("\n")); process.exit(1); }
console.log(`ACL OK: ${cmds.length} comandos cubiertos.`);
