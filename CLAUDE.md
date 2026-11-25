# Normas de releases (CaesarGit)

- **macOS se compila siempre primero en el Mac del usuario**, nunca el `.dmg` en GitHub Actions.
  Orden: 1) compilar y probar la versión de Mac en local (`universal-apple-darwin`: `.dmg`, `.app.tar.gz` y su `.sig`);
  2) solo entonces lanzar la release (`node scripts/release.mjs "notas" [patch|minor|major]`) para Windows/Linux y publicar;
  3) subir los artefactos de Mac a la release y comprobar que `latest.json` incluye las plataformas darwin.
- No dar una release por lista sin que los artefactos de Mac locales estén subidos y verificados.
- Antes de lanzar, pedir confirmación al usuario (publicar es una acción externa).
- Nunca poner a Claude como Co-Authored-By en commits ni PRs.
- Nunca subir un `.dmg` sin firma/notarizar (Gatekeeper avisaría): `scripts/mac-build.mjs` lo impide salvo `--unsigned`.
- Clave del actualizador en `~/.tauri/caesargit.key` (nunca versionada); secretos del repo: `TAURI_SIGNING_PRIVATE_KEY` y
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Credenciales de Apple en `~/.tauri/apple.env`.
- Repo público: `cesargarridor/caesargit` (el workflow usa `GITHUB_TOKEN`). Notas de cada versión en `release-notes/vX.Y.Z.md`.
