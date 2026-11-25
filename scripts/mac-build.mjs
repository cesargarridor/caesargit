#!/usr/bin/env node
// macOS se compila SIEMPRE en el Mac del dueño, nunca en GitHub Actions (norma de releases, ver CLAUDE.md).
//
//   node scripts/mac-build.mjs build  [vX.Y.Z]   compila el universal (aarch64 + x86_64), lo firma para el actualizador
//                                                 y deja los archivos en dist-mac/vX.Y.Z/
//   node scripts/mac-build.mjs upload [vX.Y.Z]   espera al borrador de la Release en el repo público y sube los archivos
//   node scripts/mac-build.mjs all    [vX.Y.Z]   las dos cosas
//
// Lo llama scripts/release.mjs (build antes del push del tag, upload después). El workflow, al terminar Windows y Linux,
// espera a `mac-platforms.json`, lo fusiona en latest.json y publica la Release.
//
// Clave del actualizador: TAURI_SIGNING_PRIVATE_KEY_PATH (por defecto ~/.tauri/caesargit.key; se lee dentro del script) y, si tiene contraseña,
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD en el entorno. El script no lee nunca el contenido de la clave: la usa Tauri.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "cesargarridor";
const PUBLIC_REPO = `${OWNER}/caesargit`;
const [, , cmd = "all", tagArg] = process.argv;
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const version = conf.version;
const tag = tagArg ?? `v${version}`;
if (tag !== `v${version}`) throw new Error(`El tag ${tag} no coincide con la versión del proyecto (${version}).`);
const out = join("dist-mac", tag);
const bundle = "src-tauri/target/universal-apple-darwin/release/bundle";
const F = { dmg: `CaesarGit_${version}_universal.dmg`, tar: "CaesarGit_universal.app.tar.gz", sig: "CaesarGit_universal.app.tar.gz.sig", plat: "mac-platforms.json" };

const sh = (c, a, opts = {}) => {
  const r = spawnSync(c, a, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`Falló: ${c} ${a.join(" ")}`);
};

function build() {
  if (process.platform !== "darwin") throw new Error("macOS solo se compila en un Mac.");
  const have = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  for (const t of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) if (!have.includes(t)) sh("rustup", ["target", "add", t]);
  const env = { ...process.env };
  // Tauri 2 solo acepta el CONTENIDO de la clave en TAURI_SIGNING_PRIVATE_KEY (la ruta no vale): se carga en memoria del
  // proceso hijo y no se imprime ni se guarda en ningún sitio.
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), ".tauri", "caesargit.key");
    if (!existsSync(keyPath)) throw new Error(`No encuentro la clave del actualizador (${keyPath}).`);
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
  }
  // Firma y notarización de Apple (sin ellas Gatekeeper dice «Apple no ha podido verificar que CaesarGit está libre de
  // malware»). Hace falta un certificado «Developer ID Application» en el llavero y las credenciales de notarización:
  // APPLE_ID, APPLE_PASSWORD (contraseña específica de app) y APPLE_TEAM_ID, en el entorno o en ~/.tauri/apple.env.
  const appleFile = join(homedir(), ".tauri", "apple.env");
  if (existsSync(appleFile)) {
    for (const l of readFileSync(appleFile, "utf8").split(/\r?\n/)) {
      const m = /^\s*(APPLE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!process.argv.includes("--unsigned")) {
    if (!env.APPLE_SIGNING_IDENTITY) {
      const ids = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
      const m = /"(Developer ID Application:[^"]+)"/.exec(ids);
      if (m) env.APPLE_SIGNING_IDENTITY = m[1];
    }
    if (!env.APPLE_SIGNING_IDENTITY) throw new Error("No hay certificado «Developer ID Application» en el llavero (el «Apple Distribution» y el «Apple Development» no valen para apps fuera de la App Store). Instálalo (Xcode → Ajustes → Cuentas → Gestionar certificados → + → Developer ID Application) o usa --unsigned bajo tu responsabilidad.");
    for (const k of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) if (!env[k]) throw new Error(`Falta ${k} para notarizar (entorno o ~/.tauri/apple.env).`);
    console.log(`Firmando con: ${env.APPLE_SIGNING_IDENTITY} (y notarizando con ${env.APPLE_ID})`);
  } else console.warn("⚠ Compilando SIN firma de Apple: Gatekeeper avisará al descargar.");
  console.log(`\n▶ Compilando macOS universal ${tag} en este Mac…`);
  rmSync(bundle, { recursive: true, force: true });
  sh("npm", ["run", "tauri", "--", "build", "--target", "universal-apple-darwin"], { env });

  const dmg = join(bundle, "dmg", F.dmg), tar = join(bundle, "macos", "CaesarGit.app.tar.gz"), sig = `${tar}.sig`;
  for (const f of [dmg, tar, sig]) if (!existsSync(f)) throw new Error(`Falta ${f} tras compilar.`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(dmg, join(out, F.dmg));
  // Tauri solo notariza la .app: el .dmg también se notariza y se grapa para que Gatekeeper lo acepte al descargarlo.
  if (env.APPLE_SIGNING_IDENTITY) {
    sh("xcrun", ["notarytool", "submit", join(out, F.dmg), "--apple-id", env.APPLE_ID, "--team-id", env.APPLE_TEAM_ID, "--password", env.APPLE_PASSWORD, "--wait"]);
    sh("xcrun", ["stapler", "staple", join(out, F.dmg)]);
  }
  copyFileSync(tar, join(out, F.tar));
  copyFileSync(sig, join(out, F.sig));
  const signature = readFileSync(sig, "utf8").trim();
  const url = `https://github.com/${PUBLIC_REPO}/releases/download/${tag}/${F.tar}`;
  const entry = { signature, url };
  const platforms = {};
  for (const k of ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"]) platforms[k] = entry;
  writeFileSync(join(out, F.plat), JSON.stringify({ platforms }, null, 2));
  console.log(`✔ macOS compilado y firmado: ${out}/`);
}

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

async function upload() {
  for (const f of Object.values(F)) if (!existsSync(join(out, f))) throw new Error(`Falta ${join(out, f)}: ejecuta primero «build».`);
  console.log(`\n▶ Esperando al borrador de la Release ${tag} en ${PUBLIC_REPO} (lo crea GitHub Actions al subir el tag)…`);
  let id = "";
  for (let i = 0; i < 60 && !id; i++) {
    id = gh("api", `repos/${PUBLIC_REPO}/releases`, "--jq", `.[] | select(.tag_name=="${tag}") | .id`).split("\n")[0];
    if (!id) await new Promise((r) => setTimeout(r, 20000));
  }
  if (!id) throw new Error(`No apareció la Release ${tag}. Cuando exista: node scripts/mac-build.mjs upload ${tag}`);
  // mac-platforms.json va el último: es la señal que espera el workflow para publicar.
  const files = [F.dmg, F.tar, F.sig, F.plat].map((f) => join(out, f));
  for (const f of files) gh("release", "upload", tag, f, "--repo", PUBLIC_REPO, "--clobber");
  console.log(`✔ Archivos de macOS subidos a ${tag}. El workflow publicará la Release al terminar Windows y Linux.`);
}

try {
  if (cmd === "build" || cmd === "all") build();
  if (cmd === "upload" || cmd === "all") await upload();
  if (!["build", "upload", "all"].includes(cmd)) throw new Error("Uso: node scripts/mac-build.mjs build|upload|all [vX.Y.Z]");
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
}
