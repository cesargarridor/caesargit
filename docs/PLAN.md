# CaesarGit — PLAN (contrato + reparto)

Lee antes docs/SPEC.md. Cada agente SOLO toca sus archivos. El contrato de abajo es ley: backend y frontend deben coincidir.

## Paso 0 — Scaffold (1 agente, primero)
En /Users/cesargarrido/Proyectos/caesargit (no borrar docs/):
- `package.json` (name caesargit, type module): deps react@18, react-dom@18, zustand, react-resizable-panels, @tanstack/react-virtual, lucide-react, @tauri-apps/api@2, @tauri-apps/plugin-dialog@2, @codemirror/{state,view,merge,language,commands,lang-javascript,lang-rust,lang-python,lang-json,lang-html,lang-css,lang-markdown,lang-sql,lang-java}. dev: vite, @vitejs/plugin-react, typescript, tailwindcss@3, postcss, autoprefixer, @types/react, @types/react-dom, @tauri-apps/cli@2. Scripts: dev, build (`tsc --noEmit && vite build`), tauri.
- `tsconfig.json` strict (noUnusedLocals, noUnusedParameters), vite.config.ts (port 1420, strictPort), tailwind.config.js con colores graphite/amber (SPEC), index.html, src/main.tsx, src/index.css (@tailwind + fuentes + scrollbars), stub src/App.tsx.
- `src-tauri/Cargo.toml`: tauri 2, tauri-plugin-dialog 2, tokio (features process,io-util,sync,rt-multi-thread,macros,fs,time), notify 6, serde(derive), serde_json, regex, once_cell, tempfile (dep normal, se usa para el script de rebase), thiserror. lib name `caesargit_lib`. build.rs, tauri.conf.json (identifier com.caesar.git, ventana 1400x900, CSP del SPEC, devUrl http://localhost:1420, frontendDist ../dist), capabilities/default.json (`core:default`, `dialog:allow-open`), icons mínimos (generar con `npx tauri icon` desde un PNG simple creado por script).
- Esqueleto de módulos vacíos con `pub mod` para que compile (los agentes rellenan). Verifica `npm install`, `cargo check`.

## CONTRATO — models.rs (serde `#[serde(rename_all="camelCase")]`, derive Debug, Clone, Serialize, Deserialize) ↔ types/git.ts

```
RepoInfo { id:String, path:String, name:String }              // id = hash estable de path canonizado (hex)
RepoStatus { branch:Option<String>, headSha:Option<String>, upstream:Option<String>, ahead:u32, behind:u32,
             files:Vec<FileChange>, operation:Option<String> } // operation: "merge"|"rebase"|"cherry-pick"|"revert"|null
FileChange { path:String, origPath:Option<String>, index:char /*X: ' ' M A D R C U ?*/, worktree:char /*Y*/,
             staged:bool, unstaged:bool, conflicted:bool }
CommitNode { sha:String, shortSha:String, parents:Vec<String>, authorName, authorEmail:String, authorDate:i64,
             committerName, committerEmail:String, committerDate:i64, subject:String, body:String, refs:Vec<RefLabel> }
RefLabel { name:String, kind:String /*"local"|"remote"|"tag"|"head"*/ }
GraphSegment { fromCol:u32, toCol:u32, colorIdx:u32, kind:String /*"pass"|"merge"|"branch"|"up"|"down"*/ }
GraphRow { commit:CommitNode, column:u32, colorIdx:u32, lanes:Vec<GraphSegment>, isMerge:bool, isWip:bool, maxColumns:u32 }
GraphPage { rows:Vec<GraphRow>, nextCursor:Option<u32> /*offset*/, total:Option<u32> }
BranchInfo { name:String, sha:String, isHead:bool, upstream:Option<String>, ahead:u32, behind:u32, isRemote:bool, remote:Option<String> }
TagInfo { name:String, sha:String, annotated:bool, message:Option<String> }
StashEntry { index:u32, refName:String, message:String, branch:String, date:i64 }
DiffFile { path:String, oldPath:Option<String>, status:String, additions:u32, deletions:u32, binary:bool, hunks:Vec<DiffHunk> }
DiffHunk { header:String, oldStart:u32, oldLines:u32, newStart:u32, newLines:u32, lines:Vec<DiffLine> }
DiffLine { kind:String /*"add"|"del"|"ctx"*/, content:String, oldNo:Option<u32>, newNo:Option<u32> }
ConflictFile { path:String, ours:String, theirs:String, base:Option<String>, merged:String /*con marcadores*/, regions:Vec<ConflictRegion> }
ConflictRegion { startLine:u32, endLine:u32, oursLines:Vec<String>, theirsLines:Vec<String>, baseLines:Vec<String> } // líneas 0-index del archivo con marcadores
BlameLine { sha:String, author:String, date:i64, lineNo:u32, content:String }
RebaseTodoItem { action:String /*pick|reword|edit|squash|fixup|drop*/, sha:String, subject:String, newMessage:Option<String> }
AppError { code:String, message:String }  // serializado como JSON; códigos: "invalid_path","invalid_arg","git_failed","not_a_repo","io","conflict","busy"
```
Todos los comandos devuelven `Result<T, AppError>`.

## CONTRATO — comandos Tauri (commands.rs). Todos reciben `repoPath: String` salvo indicado → Rust `repo_path` (Tauri convierte camelCase JS ↔ snake_case Rust).
Repo: `open_repo(path)->RepoInfo` · `get_status(repoPath)->RepoStatus`
Grafo: `get_graph(repoPath, cursor:u32, limit:u32, hasWip:bool)->GraphPage` · `search_commits(repoPath, query)->Vec<CommitNode>`
Refs: `list_branches(repoPath)->Vec<BranchInfo>` · `list_tags->Vec<TagInfo>` · `list_stashes->Vec<StashEntry>`
Ramas: `checkout(repoPath, target, create:bool)` · `create_branch(repoPath,name,startPoint:Option<String>,checkout:bool)` · `rename_branch(repoPath,old,new)` · `delete_branch(repoPath,name,force)` · `delete_remote_branch(repoPath,remote,branch)` · `checkout_remote_branch(repoPath,remoteBranch)` · `merge_branch(repoPath,name)` · `rebase_onto(repoPath,name)`
Tags: `create_tag(repoPath,name,target:Option<String>,message:Option<String>)` · `delete_tag` · `push_tag(repoPath,remote,name)`
Remoto: `fetch(repoPath,all,prune)` · `pull(repoPath,mode:"ff"|"rebase"|"merge")` · `push(repoPath,force:bool, setUpstream:bool)` (force = `--force-with-lease`)
Stash: `stash_push(repoPath,message:Option<String>)` · `stash_apply(repoPath,index)` · `stash_pop(repoPath,index)` · `stash_drop(repoPath,index)` · `stash_branch(repoPath,index,name)`
Staging: `stage_paths(repoPath,paths)` · `unstage_paths` · `stage_all` · `unstage_all` · `discard_paths(repoPath,paths)` · `discard_all`(confirmación en UI) · `ignore_path(repoPath,path)`
Diff: `get_file_diff(repoPath,path,staged:bool,ignoreWhitespace:bool)->DiffFile` · `get_commit_files(repoPath,sha)->Vec<DiffFile>` (sin hunks, solo stats) · `get_commit_file_diff(repoPath,sha,path,ignoreWhitespace)->DiffFile` · `get_commit_detail(repoPath,sha)->CommitNode`
Patch: `apply_hunk(repoPath,path,staged:bool,hunkIndex,action:"stage"|"unstage"|"discard",ignoreWhitespace)` · `apply_lines(repoPath,path,hunkIndex,lineIndices:Vec<u32>,action:"stage"|"unstage")`
Commit: `commit(repoPath,summary,description,amend:bool)->String(sha)` · `last_commit_message(repoPath)->String` · `undo_last_commit(repoPath)`
Commit-ops: `cherry_pick(repoPath,sha)` · `revert_commit(repoPath,sha)` · `reset_to(repoPath,sha,mode:"soft"|"mixed"|"hard")` · `is_ancestor_of_head(repoPath,sha)->bool`
Rebase: `rebase_interactive(repoPath,baseSha,items:Vec<RebaseTodoItem>)` · `list_rebase_commits(repoPath,baseSha)->Vec<RebaseTodoItem>`
Operación en curso: `op_continue(repoPath)` · `op_abort(repoPath)` (según status.operation: merge/rebase/cherry-pick/revert)
Conflictos: `get_conflict(repoPath,path)->ConflictFile` · `resolve_conflict(repoPath,path,content:String)` (escribe vía path_guard + `git add`)
Blame/Historial: `blame_file(repoPath,path,rev:Option<String>)->Vec<BlameLine>` · `file_history(repoPath,path)->Vec<CommitNode>`
Watcher: `watch_repo(repoPath)` · `unwatch_repo(repoPath)` → evento `"repo-changed"` payload `{ repoPath:String }`.

## Diseños clave
- **executor.rs**: `pub async fn read(repo:&Path, args:&[&str]) -> Result<String>` (env GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0, LC_ALL=C) · `write(...)` toma Mutex por repo (`once_cell` + `HashMap<PathBuf,Arc<Mutex<()>>>`) · `write_stdin(repo,args,stdin_bytes)` · `write_env(repo,args,envs)` para rebase. Sanitizar stderr: sustituir ruta del repo por `<repo>`, truncar a 2000 chars.
- **arg_guard.rs**: `validate_ref(&str)` (regex `^[A-Za-z0-9._/@{}^~:+-]+$`, no empieza por `-`, sin `..` salvo rangos permitidos explícitos, sin espacios); `validate_sha`; `validate_branch_name`; `validate_remote`. Rutas de archivo siempre tras `--`.
- **path_guard.rs**: `open_repo_root(path)->PathBuf` (canonicalize + `rev-parse --show-toplevel`); `safe_join(root, rel)->PathBuf` canoniza el padre si el archivo no existe y exige `starts_with(root)`; rechaza `..`, rutas absolutas fuera, NUL. Tests: traversal, symlink fuera, ruta válida.
- **parsers.rs**: status `--porcelain=v2 -z --branch`; log con `%x00` entre campos y `%x1e` entre commits; diff unificado → DiffFile/Hunk; branches `for-each-ref`; blame `--porcelain`; stash `%gd%x00%gs%x00%ct`.
- **graph_engine.rs**: entrada = commits topo-order con parents. Mantiene `lanes: Vec<Option<String>>` (sha esperado por carril). Por commit: columna = primer carril que espera su sha (si ninguno, primer hueco o nuevo); los demás carriles que esperan el mismo sha convergen (`merge`). Padre 0 hereda carril (`down`); padres extra buscan carril que ya los espere o abren uno nuevo (`branch`). Carriles no tocados → `pass`. color_idx = columna del carril al crearse, ciclando 8, estable mientras viva el carril. Paginación: `--skip=cursor --max-count=limit`, estado de carriles se recomputa desde offset 0 hasta cursor+limit cachéandolo por repo (HEAD sha como clave de invalidación). Fila WIP la inserta el frontend/`get_graph` cuando `hasWip` (isWip=true, sha "WIP", padre = HEAD, carril del HEAD). Tests: lineal, merge, rama larga, octopus.
- **patcher.rs**: `build_hunk_patch(file:&DiffFile, hunkIndex)` → cabecera `diff --git a/p b/p\n--- a/p\n+++ b/p\n` + hunk. `build_lines_patch(file, hunkIndex, selected, reverse)`: recorre líneas del hunk; líneas add/del NO seleccionadas: add→se omite (stage) , del→se convierte en contexto; para unstage (aplicado con `--reverse` sobre el diff staged) la lógica espejo; recalcula `@@ -a,b +c,d @@`. Se aplica con `git apply --cached --recount [--unidiff-zero] [--reverse]` por stdin. Discard hunk: `git apply --reverse` sobre el worktree (sin --cached). Tests con patches sintéticos.
- **rebase interactivo**: escribir todo-list a archivo temporal (tempfile), `GIT_SEQUENCE_EDITOR` = script (`sh` solo en unix; en Windows `cmd`) que copia ese archivo sobre el todo — el valor del env lo construye Rust con rutas escapadas y validadas, NUNCA con datos del usuario; los mensajes de `reword` se aplican con `GIT_EDITOR` análogo apuntando a archivo temporal con el mensaje. Ejecutar `git rebase -i <baseSha>`; si hay conflicto, devolver AppError code "conflict" (el banner de op en curso lo gestiona).
- **conflict.rs**: parsea marcadores `<<<<<<<`/`=======`/`>>>>>>>` (y `|||||||` diff3) → `ConflictRegion`. `ours/theirs/base` vía `git show :2:path`, `:3:path`, `:1:path`.
- **watcher**: `notify::RecommendedWatcher` sobre repo root recursivo; ignorar rutas bajo `.git/` salvo `HEAD`, `index`, `refs`, `MERGE_HEAD`, `rebase-*`; debounce 200ms con tokio; evitar bucles: no reaccionar a `.git/index.lock`; emitir `repo-changed`.
- **Frontend store** `useRepoStore`: `tabs: RepoTab[]` y `activeId`; por tab: status, graph rows (+cursor), branches, tags, stashes, selection (`{kind:"wip"}|{kind:"commit",sha}|{kind:"file",...}`), diff, loading flags. Acciones envuelven `invoke` y refrescan. `useGitEvents` escucha `repo-changed` (refresh con throttle) y registra atajos: Cmd/Ctrl+O, K, Enter(commit), W cerrar pestaña.
- **Estilo**: tokens Tailwind `bg-app #0D0E11`, `bg-panel #13151A`, `bg-elev #1A1D24`, `border-line #262A34`, `amber`, colores git. Tema oscuro CodeMirror propio.

## Reparto (archivos exclusivos)
- **A** (tras Paso 0): `error.rs`, `security/*`, `git/executor.rs`, `git/models.rs`, `git/parsers.rs`, `watcher/*`, `lib.rs`, `main.rs`. Tests path_guard/arg_guard/parsers. → publica API que B y C usan.
- **B** (paralelo con A; usa signatures del contrato): `git/graph_engine.rs`, `git/patcher.rs`, `git/conflict.rs` con sus tests. Define sus entradas con tipos de models.rs (A los escribe primero; si no existen, B espera ver models.rs — A debe escribir models.rs ANTES que nada).
- **C** (tras A y B): `git/commands.rs` completo + registro en `lib.rs` (`generate_handler!`) coordinado con A.
- **D1** (paralelo desde el inicio, solo contrato): `src/types/git.ts`, `src/store/useRepoStore.ts`, `src/hooks/useGitEvents.ts`, `components/layout/*`, `components/graph/*`, `App.tsx`, `index.css`.
- **D2** (paralelo): `components/inspector/*`, `components/merge/*` (usa store de D1 vía interfaz acordada: `useRepoStore` expone `activeTab()`, `run(cmd,args)`, `refresh()`, `selection`, `setSelection`).
Orden: Paso 0 → {A, B, D1, D2} en paralelo → C → verificación.

## Verificación final
`cargo check` · `cargo test` · `cargo clippy` sin warnings · `npm run build` limpio · grep de que cada comando del contrato está en `generate_handler!` y se llama desde el frontend · capabilities sin permisos extra · sin `TODO`, `unimplemented!`, `todo!`, mocks.
