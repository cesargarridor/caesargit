# CaesarGit — Spec (fuente de verdad)

Cliente Git de escritorio nativo, local-first, <100 MB RAM, sustituto de GitKraken sin Electron.
REGLA: completo y funcional. Prohibido TODO, mocks, placeholders. Cada botón/menú/atajo conectado a `git` real.
Fin: `cargo check`, `cargo test` (en src-tauri) y `npm run build` (TS estricto) limpios, sin warnings.

## Stack
Backend (src-tauri, Rust + Tauri 2): SOLO binario `git` del sistema vía `tokio::process::Command` (PROHIBIDO git2/libgit2). `notify` con debounce 200ms. serde/serde_json tipado.
Frontend (src/, React 18 + TS + Tailwind): zustand (indexado por repoId, multi-pestaña), react-resizable-panels, @tanstack/react-virtual, @codemirror/merge + state + view + lang-(javascript, rust, python, json, html, css, markdown, sql, java), lucide-react.

## Seguridad (zero-trust)
1. Cero shell injection: nunca `sh -c`/`cmd /C`/concatenar. `Command::new("git").args([...])`. Refs/ramas/rutas del usuario que empiecen por `-`: anteponer `--` o validar con regex (bloquear `--upload-pack`, `--exec`...).
2. `security/path_guard.rs`: repo_path canonizado (`fs::canonicalize`) + `git rev-parse --show-toplevel`. Todo archivo leído/escrito/descartado/resuelto: canonizar y `starts_with(repo_root)`.
3. Lecturas (status, log, diff, show, branch, tag, stash list, blame, rev-parse) con `GIT_OPTIONAL_LOCKS=0`. Escrituras (stage, commit, merge, rebase, checkout, pull, push, stash) bajo Mutex por repo.
4. Tauri 2: CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;`. capabilities/default.json mínimo: `core:default`, `dialog:allow-open`. Sin fs/shell desde frontend. Errores sanitizados (sin rutas fuera del repo ni env).

## Identidad "Graphite & Amber"
Fondo app #0D0E11; paneles #13151A; elevado/hover/modales #1A1D24; bordes #262A34 1px.
Acento #F59E0B (hover #D97706, glow rgba(245,158,11,.14)).
Git: added/staged #10B981, modified #F59E0B, deleted #EF4444, renamed #3B82F6, conflict #F43F5E con badge pulsante.
Carriles grafo (8): #F59E0B #38BDF8 #10B981 #A78BFA #FB7185 #2DD4BF #FBBF24 #818CF8.
Tipografía: Inter/system-ui UI; JetBrains Mono/Fira Code (ligaduras) para hashes, diffs.

## Funcionalidad
A. Multi-repo: barra de pestañas (abrir `+`/Cmd-Ctrl+O, rama activa, punto si cambios, cerrar, recientes en localStorage). Toolbar: Fetch (dropdown Fetch All, Fetch & Prune), Pull (FF, Rebase, Merge), Push (force-with-lease tras confirmación), Branch (desde HEAD), Stash (1 clic, mensaje opcional), Pop Stash, Undo (`reset --soft HEAD~1` o revert). Indicador ahead ↑N / behind ↓N. Command Palette Cmd/Ctrl+K: commits (mensaje/hash/autor), ramas, tags, acciones git.
B. Sidebar: LOCAL (HEAD ámbar con pin; doble clic=checkout; menú: Checkout, Create Branch here, Merge into current, Rebase current onto this, Rename, Delete (force)). REMOTES agrupados (Checkout=tracking, Pull into current, Push, Delete remote branch). TAGS (Checkout, Create Tag, Push Tag, Delete Tag). STASHES (Apply, Pop, Drop, Branch from Stash). Filtros.
C. Grafo metro: `graph_engine.rs` ejecuta `git log --all --topo-order --parents --format=...` paginado/incremental; calcula por commit column, color_idx, passing_lanes, merge_from, branch_to; frontend solo pinta SVG en react-virtual. Nodo WIP virtual en fila 0 (línea punteada ámbar a HEAD). Fila: nodos circulares (doble anillo ámbar HEAD, iconos tag/merge), pills de ramas/tags, mensaje, avatar iniciales, hash 7 chars copiable, tiempo relativo. Menú commit: Checkout (detached), Create branch/tag here, Cherry-pick, Revert, Reset (Soft/Mixed/Hard con modal), Interactive Rebase (si ancestro de HEAD), Copy SHA, Copy message.
D. Interactive Rebase visual: modal, reordenar, acciones Pick/Reword/Edit/Squash/Fixup/Drop, `GIT_SEQUENCE_EDITOR` determinista desde Rust (script temporal seguro).
E. Panel derecho WIP: Unstaged vs Staged; Stage All/Unstage All/Discard All (confirmar); por archivo icono estado, ruta, +, -, ↺, menú (File History, Blame, Ignore). DiffViewer @codemirror/merge: Unified/Split, ignorar whitespace (-w), Next/Prev hunk. `patcher.rs`: Stage/Unstage/Discard Hunk y Stage/Unstage Selected Lines construyendo parche unificado y enviándolo por stdin a `git apply --cached` (--unidiff-zero / --reverse). Caja commit: Summary (contador 50/72), Description, Amend (precarga último mensaje), botón ámbar `Commit Changes (N files)` Cmd/Ctrl+Enter.
   Commit histórico: metadatos completos (autor, committer, email, fecha, SHA, padres), mensaje, archivos, diff solo-lectura, Blame y File History.
F. Conflictos: detectar vía `git status --porcelain=v2` (UU, AA, DU, UD). Banner merge/rebase/cherry-pick en curso con Abort y Continue. 3-Way Merge Editor: Current (HEAD) arriba-izq con Accept Current; Incoming (MERGE_HEAD) arriba-der con Accept Incoming y Accept Both; Result abajo editable, marcadores de conflictos restantes, `Mark as Resolved` (guarda con path_guard + `git add`).

## Estructura obligatoria
```
src-tauri/src/
  main.rs lib.rs error.rs
  security/{mod.rs,path_guard.rs,arg_guard.rs}
  git/{mod.rs,executor.rs,models.rs,parsers.rs,graph_engine.rs,patcher.rs,conflict.rs,commands.rs}
  watcher/{mod.rs,repo_watcher.rs}   # notify + debounce 200ms -> evento "repo-changed"
src/
  types/git.ts  (1:1 con models.rs)
  store/useRepoStore.ts
  hooks/useGitEvents.ts
  components/layout/{RepoTabBar,ActionToolbar,Sidebar,CommandPalette}.tsx
  components/graph/{CommitGraph,GraphCell}.tsx
  components/inspector/{WipPanel,CommitDetail,DiffViewer,BlameModal}.tsx
  components/merge/{ThreeWayResolver,InteractiveRebaseModal}.tsx
  App.tsx
```
Parsers con separador NUL (-z / %x00). Tests unitarios Rust para graph_engine, patcher, path_guard.
