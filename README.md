# CaesarGit

Cliente Git de escritorio (Tauri 2 + React): grafo de commits, staging por hunks/líneas, ramas, stash, rebase interactivo,
resolución de conflictos y blame.

## Descarga

Instaladores para macOS, Windows y Linux en [Releases](https://github.com/cesargarridor/caesargit/releases/latest).
La app se actualiza sola (pregunta antes de instalar).

## Desarrollo

```bash
npm ci
npm run tauri dev      # app en desarrollo
npm run build          # tipos + frontend
cargo check --manifest-path src-tauri/Cargo.toml
```

Requiere Node 20, Rust estable y las dependencias de Tauri 2 de tu sistema.

## Release

macOS se compila primero en local (firmado y notarizado), luego se publica:

```bash
node scripts/release.mjs "novedad 1 | novedad 2" patch
```

Compila el Mac, crea el tag, GitHub Actions compila Windows y Linux, y publica con `latest.json`. Ver `CLAUDE.md`.

## Licencia

MIT
