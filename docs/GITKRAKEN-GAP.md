# CaesarGit vs GitKraken Desktop — análisis de huecos

Fuentes: help.gitkraken.com/gitkraken-desktop (interfaz, atajos, preferencias, ramas, stash, worktrees, búsqueda) + conocimiento del producto. Estado de CaesarGit leído de `src/`, `commands.rs` (≈60 comandos), `docs/SPEC.md`, `docs/PLAN.md`.
Estado: OK = hecha, PAR = parcial, NO = falta. Solo funciones git locales (sin Workspaces/Launchpad/PRs/AI/cloud).

## A. Tabla de funciones

### Repositorio y pestañas
| Función GitKraken | Estado | Notas / qué añadir |
|---|---|---|
| Abrir repo, pestañas multi-repo, cerrar, recientes | OK | RepoTabBar |
| Clone (URL, carpeta, shallow, submódulos) | NO | `clone_repo(url,dest,depth,recursive)`; modal `CloneModal`; progreso por evento |
| Init repo (carpeta, .gitignore, licencia, rama inicial) | NO | `init_repo(path,defaultBranch)`; `InitModal` |
| Reordenar pestañas, alias por pestaña, agrupar worktrees | NO | store + drag; persistir alias en prefs |
| Atajos de pestaña (⌘T, ⌘1-9, Ctrl+Tab) | PAR | solo ⌘O/⌘W; añadir resto en `useGitEvents` |
| Favoritos de repos / pantalla "New Tab" con búsqueda | NO | `NewTabView` con recientes, favoritos, Open/Clone/Init |
| Perfiles (config distinta por perfil) | NO | prefs con perfiles; baja prioridad |
| Activity log (registro de comandos git ejecutados) | NO | executor guarda ring buffer; `get_activity_log`; `ActivityLogModal` |
| Open in terminal / file manager / editor externo | NO | `open_in_terminal`, `reveal_in_file_manager`, `open_in_editor(path)` (Tauri opener, sin shell del frontend) |
| Terminal integrada | NO | opcional (pty); baja prioridad |
| Deep links `gitkraken://` | NO | omitir |

### Ramas, merge, rebase
| Función | Estado | Notas |
|---|---|---|
| Listar local/remote, checkout, crear, renombrar, borrar | OK | falta borrado múltiple |
| Crear rama desde commit | OK | |
| Borrar varias ramas (Shift/Cmd en panel) | NO | selección múltiple en Sidebar + `delete_branches(names,force)` |
| Borrar rama local+remota a la vez | NO | menú "Delete local and remote" |
| Merge (menú) | OK | opciones: `--no-ff`, `--ff-only`, `--squash`; añadir parámetro `mode` a `merge_branch` |
| Rebase current onto X | OK | falta `rebase --autostash`, `--rebase-merges` |
| Fast-forward ref sin checkout (`fetch origin b:b`) | NO | `fast_forward_branch(name)` |
| Drag&drop rama→rama (menú Merge / Rebase / Fast-forward) | NO | DnD en pills y sidebar; popup con 3 opciones |
| Drag&drop rama local→remota (Push) | NO | `push_branch(remote,local,remoteBranch,force)` |
| Set upstream / cambiar tracking | NO | `set_upstream(branch,remoteBranch)`, `unset_upstream` |
| Pin to left / Unpin | NO | prefs por repo; pin de ramas arriba del panel |
| Hide / Show rama en grafo | NO | filtro de refs en `get_graph(excludeRefs)` |
| Solo rama (ver solo esa) | NO | `get_graph(includeRefs)`; chips "Solo" en toolbar |
| Hide/Show todas las remotas, tags, stashes | NO | menú de cabecera de sección |
| Smart Branch Visibility (solo HEAD+target+upstream) | NO | prefs |
| Color de rama personalizable | NO | prefs `branchColors[ref]`; picker en menú |
| Detached HEAD (banner + crear rama) | PAR | checkout detached existe; falta aviso y acción "Create branch" en toolbar |
| Compare ramas/commits (diff entre dos refs) | NO | `compare_refs(a,b)` → `Vec<DiffFile>`; `CompareView`; seleccionar 2 commits con Cmd+clic |
| Conflict prevention (detectar choque con target) | NO | `merge-tree --write-tree` check; pill de aviso |

### Commits
| Función | Estado | Notas |
|---|---|---|
| Commit, amend (precarga mensaje) | OK | |
| Amend de commit antiguo / reword | PAR | solo reword por rebase interactivo; añadir "Edit commit message" (menú) |
| Commit sin staged ("stage all and commit") ⌘⇧Enter | NO | atajo + botón |
| Plantilla de commit (`commit.template`) | NO | `get_commit_template` precarga summary/desc |
| Co-autor (Co-authored-by) | NO | campo en caja commit |
| Firma GPG/SSH (`-S`, `commit.gpgsign`) | NO | ajustes repo + `-S` en commit/tag/merge |
| Identidad por repo (user.name/email local) | NO | `get_repo_config`/`set_repo_config`; modal repo prefs |
| Cherry-pick 1 commit | OK | |
| Cherry-pick varios commits (rango/multi-select) | NO | selección múltiple en grafo, `cherry_pick(shas[])` en orden topológico |
| Revert | OK | varios commits y `--no-commit`: NO |
| Reset soft/mixed/hard | OK | |
| Squash commits seleccionados (menú, multi-select) | NO | `squash_commits(shas,message)` vía rebase scriptado |
| Fixup / "Squash into parent" | PAR | solo en interactive rebase; añadir `fixup_commit(sha)` (`commit --fixup` + autosquash) |
| Interactive rebase (pick/reword/edit/squash/fixup/drop) | OK | falta DnD de reorden pulido y "Edit" paso a paso |
| Rebase N commits onto X (rango) | NO | |
| Undo / Redo de acciones | PAR | solo `undo_last_commit`; falta pila Undo/Redo real (ver abajo) |
| Reflog (ver/restaurar) | NO | `get_reflog(limit)`, `ReflogModal`, "Reset to this" |
| Bisect (good/bad/skip/reset) | NO | `bisect_start/mark/reset` + banner; GK no lo tiene nativo pero es útil |
| Patches: crear (`format-patch`/diff) y aplicar | NO | `create_patch(shas|wip)`, `apply_patch(file,check)`; menú commit "Create patch", File → "Apply patch" |

### Stash
| Función | Estado | Notas |
|---|---|---|
| Stash push con mensaje, apply, pop, drop, branch from stash | OK | |
| Stash incluyendo untracked (`-u`) / ignored (`-a`) | NO | parámetros en `stash_push` |
| Stash solo staged (`--staged`) / archivos concretos | NO | `stash_push(paths,staged)`; menú "Stash file" |
| Aplicar archivo concreto de un stash | NO | `stash_apply_file(index,path)` |
| Editar mensaje de stash | NO | `stash_rename(index,msg)` (drop+store) |
| Ver contenido de stash (diff) | PAR | verificar CommitDetail con `stash@{n}` |
| Stash nodos en el grafo + hide | NO | `get_graph` incluye `refs/stash`; ocultar |

### Tags
| Función | Estado | Notas |
|---|---|---|
| Ligero/anotado, borrar, push tag | OK | |
| Borrar tag remoto | NO | `delete_remote_tag(remote,name)` |
| Push all tags / `--follow-tags` | NO | |
| Tag firmado, editar mensaje | NO | |
| Mostrar/ocultar tags en grafo | NO | |

### Remotos y red
| Función | Estado | Notas |
|---|---|---|
| Fetch, Fetch All, Fetch & Prune | OK | |
| Auto-fetch periódico (0-60 min) | NO | timer en store + pref |
| Pull ff-only/rebase/merge | OK | pull por defecto configurable: NO |
| Push, force-with-lease, set-upstream | OK | `--force` plano, push tags, `--no-verify`: NO |
| Gestionar remotos (add/edit/remove/rename URL) | NO | `list_remotes`, `add_remote`, `set_remote_url`, `remove_remote`, `rename_remote`; `RemotesModal` |
| Credenciales HTTPS / SSH agent / claves | PAR | usa credenciales del sistema; falta UI de claves SSH |
| Barra de progreso de fetch/push/clone | NO | evento `git-progress` (stderr `--progress`) |

### Archivos, diff, blame, historial
| Función | Estado | Notas |
|---|---|---|
| Stage/unstage/discard archivo, todo | OK | |
| Stage hunk / líneas | OK | |
| Vista lista vs árbol (path/tree) de archivos | NO | toggle en WipPanel y CommitDetail |
| Vista diff unified/split | OK | |
| Ignorar whitespace | OK | |
| Word diff / intra-line highlight | NO | `--word-diff` o diff por palabras en CodeMirror |
| Diff de imágenes (side-by-side / swipe / onion) | NO | `get_file_blob_base64(rev,path)`; `ImageDiff` |
| Contexto de líneas configurable (3/…/archivo completo) | NO | `-U<n>` en `get_file_diff` |
| Hunk view / Inline / ver archivo completo | PAR | falta "View file" |
| Editar archivo desde el diff (editor integrado, guardar) | NO | `read_file`, `write_file` con path_guard |
| Blame | OK | BlameModal; falta clic en sha → ir al commit |
| File history | OK | falta `--follow`, diff de cada versión, "buscar archivo" ⌘⇧H |
| Abrir en herramienta externa de diff/merge (⌘D) | NO | `git difftool`/`mergetool` con config en prefs |
| Ver archivo en rev / "Open file at this commit" | NO | `show_file(rev,path)` |
| Eliminar `.orig` tras merge | NO | pref |
| .gitignore (añadir archivo/carpeta/extensión) | PAR | `ignore_path` solo; añadir patrón por extensión, ignorar solo local (`.git/info/exclude`) |
| Untracked: stage/delete, clean | PAR | `git clean` falta (`clean_untracked(paths)`) |
| Archivos grandes / EOL / autocrlf | NO | prefs |

### Conflictos
| Función | Estado | Notas |
|---|---|---|
| Banner merge/rebase/cherry-pick/revert + continue/abort | OK | |
| Editor 3 vías (ours/theirs/result) | OK | |
| Accept Current/Incoming/Both | OK | por región y por archivo: verificar |
| "Resolve using ours/theirs" por archivo (`checkout --ours/--theirs`) | NO | `resolve_with_side(path,side)` |
| Delete/modify conflicts (DU/UD) UI | PAR | |
| Skip en rebase (`--skip`) | NO | `op_skip` |

### Submódulos, subtrees, worktrees, LFS, Flow, hooks
| Función | Estado | Notas |
|---|---|---|
| Submódulos: listar, add, init, update, remove, abrir como repo, estado | NO | `list_submodules`, `submodule_add/init/update(recursive)/sync/remove`; sección Submodules en Sidebar |
| Subtrees (add/pull/push/split) | NO | GK no lo ofrece en UI nativa (CLI); opcional `subtree_*` |
| Worktrees: listar, crear desde rama, abrir (nueva pestaña), lock/unlock, remove (+delete branch) | NO | `list_worktrees`, `add_worktree(path,branch,new)`, `lock/unlock/remove_worktree`, `prune_worktrees`; sección en Sidebar y WIP rows por worktree en grafo |
| Git LFS: install, track/untrack patrones, lista de archivos, pull/fetch/prune, lock/unlock | NO | `lfs_status`, `lfs_track(pattern)`, `lfs_untrack`, `lfs_pull`, `lfs_fetch`, `lfs_prune`, `lfs_locks`; botón LFS en toolbar si `.gitattributes` tiene filter=lfs |
| Git Flow (init, start/finish feature/release/hotfix, config de prefijos) | NO | implementar con git puro (sin git-flow CLI): `flow_init(cfg)`, `flow_start(kind,name)`, `flow_finish(kind,name,opts)`; botón Gitflow en toolbar |
| Git Hooks (listar, activar/desactivar, editar, plantillas) | NO | `list_hooks`, `read_hook`, `write_hook`, `toggle_hook`; `HooksModal` en ajustes del repo |
| Bypass hooks (`--no-verify`) | NO | checkbox en commit/push |

### Búsqueda, grafo y navegación
| Función | Estado | Notas |
|---|---|---|
| Command Palette (commits, ramas, tags, acciones) | OK | GK usa ⌘P; CaesarGit ⌘K |
| Búsqueda de commits en grafo (mensaje/sha/autor) con resaltado y siguiente/anterior | PAR | `search_commits` existe; falta barra ⌘F en grafo con filtros: mensaje, autor, sha, **archivo (`-- path`)**, **cambios (`-S`/`-G`)**, fecha, y saltar con Enter |
| Filtro por autor (columna Author) | NO | `get_graph(author)` |
| Columnas: toggle/reordenar/redimensionar (BRANCH/TAG, GRAPH, MESSAGE, AUTHOR, DATE, SHA) | NO | persistir por repo |
| Resaltar ramas al hover (fade del resto) | NO | CSS + hover state |
| "Ghost branch" de commit seleccionado | NO | |
| Selección de rango de commits (Shift) y menús multi | NO | selección múltiple en CommitGraph |
| Navegación teclado J/K/H/L, Shift+J/K, ⌘↑/↓ | NO | `useGitEvents` |
| Mostrar todos los commits / lazy load / nº inicial | PAR | paginado fijo; pref |
| Mostrar autor: iniciales/avatar (gravatar) | PAR | iniciales sí; avatar gravatar/remoto NO |
| Formato fecha/hora configurable | NO | pref |
| Rama remota "pill" con icono de host/avatar | NO | ver B |

### Ajustes y varios
| Función | Estado |
|---|---|
| Temas, acento, updates | OK |
| Atajos listados (⌘/) | NO — `ShortcutsModal` |
| Zoom UI 80-300 % (⌘+/-/0) | NO |
| Toggle panel izquierdo ⌘J / panel detalle ⌘K (GK) | NO (⌘K ocupado por palette) |
| Fullscreen | NO (Tauri window API) |
| Pantalla de Preferencias completa (General, External Tools, UI, Commit signing, Editor, Repo-specific) | PAR (solo tema/acento/updates) |
| Herramientas externas (merge/diff/editor/terminal) | NO |
| Git executable path, default branch name, auto-prune, longpaths | NO |
| Drag & drop de carpeta sobre la ventana para abrir repo | NO |

### Undo / Redo (diseño)
GK deshace: checkout, crear/renombrar/borrar rama, commit, amend, merge, rebase, cherry-pick, revert, reset, stash/pop/apply/drop, stage/unstage/discard (archivos), tag create/delete, edición de mensaje. No deshace: push, fetch, pull remoto, conflictos en curso.
Implementación: `undo_stack: Vec<UndoEntry{label, refs_before: HashMap<ref,sha>, head_before, index_stash:Option<sha>}>` en Rust por repo; antes de cada acción de escritura guardar snapshot de `HEAD` + refs afectadas (`for-each-ref`) + `stash create` del WIP si procede. Undo = `update-ref` + `reset --hard/--keep` + restaurar WIP. Comandos: `undo_action`, `redo_action`, `undo_state -> {undoLabel?, redoLabel?}`. Botones y ⌘Z/⌘⇧Z.

### Lista concreta de comandos Rust a añadir (resumen)
`clone_repo, init_repo, list_remotes, add_remote, set_remote_url, remove_remote, rename_remote, set_upstream, fast_forward_branch, push_branch, delete_branches, delete_remote_tag, push_all_tags, merge_branch(mode), cherry_pick(shas[]), revert_commit(shas[],noCommit), squash_commits, fixup_commit, edit_commit_message, op_skip, resolve_with_side, stash_push(untracked,staged,paths), stash_apply_file, stash_rename, compare_refs, get_reflog, bisect_*, create_patch, apply_patch, clean_untracked, ignore_pattern(local|gitignore), get_file_blob_base64, show_file, read_file, write_file, get_repo_config, set_repo_config, get_commit_template, list_submodules, submodule_*, list_worktrees, add_worktree, lock_worktree, unlock_worktree, remove_worktree, lfs_*, flow_*, list_hooks, read_hook, write_hook, toggle_hook, get_activity_log, undo_action, redo_action, undo_state, open_in_terminal, reveal_in_file_manager, open_in_editor, run_difftool, run_mergetool, git_progress (evento), get_graph(+includeRefs, excludeRefs, author, path, grep, since).
### Componentes React a añadir
`CloneModal, InitModal, NewTabView, RemotesModal, SubmodulesPanel, WorktreesPanel, LfsModal, GitflowModal, HooksModal, ReflogModal, BisectBanner, PatchModal, CompareView, ImageDiff, FileTree (lista/árbol), SearchBar (⌘F), ColumnHeader (toggle/reorden/resize), BranchPill (con icono/avatar), ShortcutsModal, PreferencesModal ampliado, ActivityLogModal, StatusBar, UndoRedoButtons, DragDropLayer (branch DnD), MultiSelect en grafo, CommitTemplate/CoAuthor en caja de commit, ContextMenu genérico con submenús y separadores.

---

## B. UI de GitKraken (para imitar)

### Layout general (de arriba a abajo)
1. **Barra de pestañas** (altura ≈36 px, fondo más oscuro que el app). Una pestaña por repo: icono de carpeta/repo + nombre (+ alias); pestaña activa con fondo del panel y línea superior de acento; botón `x` al hover; botón `+` al final y desplegable "lista de repos abiertos". Pestañas arrastrables; las de worktrees del mismo repo van agrupadas en contenedor con borde y asa de puntos. Derecha: engranaje (Preferencias/integraciones), icono de notificaciones, avatar de perfil, botón de búsqueda.
2. **Toolbar central** (≈44 px, icono grande + etiqueta debajo opcional). Izquierda: nombre del repo / rama actual con selector (dropdown repo y rama). Centro, grupo separado por divisores: `Undo` `Redo` | `Pull ▾` (Fetch All, FF si posible, FF only, Rebase, definir por defecto) `Push` `Branch` `Stash` `Pop` | (si aplica) `LFS`, `Gitflow`. Derecha: barra de búsqueda de commits (⌘F) con lupa, y menú de columnas (engranaje).
3. **Tres columnas redimensionables:**
   - **Panel izquierdo** (≈250 px, ⌘J lo oculta): control `List | Agents`; caja **Filter** (⌘⌥F) con iconos; secciones colapsables con contador y flecha: **LOCAL** (rama HEAD en negrita con icono de check, ramas con flechas ↑N ↓N de ahead/behind, rama de worktree con icono de carpeta), **REMOTE** (cada remoto como carpeta con icono de host y ramas dentro; si hay `/` se agrupan en carpetas), **PULL REQUESTS**, **ISSUES**, **TEAMS**, **TAGS** (icono de etiqueta), **STASHES**, **SUBMODULES**. Doble clic en cabecera = maximizar sección; clic derecho en cabecera = mostrar/ocultar secciones. Cada fila: icono ojo (hide, al hover), pin, nombre. Ramas con jerarquía `feature/…` en carpetas.
   - **Grafo central:** cabecera con columnas **BRANCH/TAG**, **GRAPH**, **COMMIT MESSAGE** (más opcionales AUTHOR, DATE/TIME, SHA); separadores arrastrables, reordenables, clic derecho o engranaje para activarlas, guardadas por repo. Primera fila: nodo **WIP** (círculo punteado) con `// WIP` + resumen "N cambios: +A ~M −D" y chip de rama; clic muestra cambios en el panel derecho. Resto de filas: nodo circular relleno (avatar del autor dentro del círculo si "avatars"), líneas curvas de colores por carril. Merge: nodo con icono pequeño. Stash: nodo con icono de caja. Fila de ≈26-28 px, fuente 12-13 px.
   - **Panel derecho (Commit Panel, ≈350 px):** con WIP → "Unstaged Files (N)" con botón verde `Stage all changes`, "Staged Files (N)" con `Unstage all`, y cuadro de commit con **Summary** (contador 72), **Description**, checkbox **Amend**, botón grande verde/azul `Commit changes to N files` (y `Stash`). Cabecera de lista con toggle **Path | Tree** y vista lista/árbol; tabs "Commit" y "Stash". Con commit seleccionado: avatar + autor + fecha, SHA copiable, padres (links), mensaje completo, lista de archivos "N files changed" con toggle Path/Tree, botón "View all files", `Compare`/`Cherry-pick`. Archivos con icono de estado de color (verde + añadido, naranja ✎ modificado, rojo − borrado, azul → renombrado) y a la derecha `+`/`−` al hover. Clic en archivo abre el diff a pantalla del grafo (reemplaza el grafo; botones: Hunk/Inline/Split, Whitespace, "View file", "Edit", Blame, History, Prev/Next change, cerrar con Esc).
4. **Barra inferior (status bar, ≈24 px):** izquierda: resumen Launchpad (omitible) / plan; derecha: selector de zoom 80-300 %, indicador de actividad/progreso, versión / feedback. En CaesarGit: rama, ahead/behind, estado de fetch, zoom, versión.

### Pills de rama/tag (columna BRANCH/TAG)
- Pill con esquinas redondeadas ≈ 10 px, 11 px de fuente, fondo del color del carril al ~20 % de opacidad + borde/texto del color pleno; la rama HEAD con fondo sólido de acento y texto contrastado + icono check.
- Icono izquierdo: **local** = monitor/laptop; **remote** = logo del host (GitHub, GitLab, Bitbucket, Azure) o nube; **tag** = etiqueta; **stash** = caja; **PR** = icono de PR. Si hay local y remota de la misma rama se fusionan en una pill con ambos iconos ("origin/main" colapsado). Con muchas refs: primera visible + "+N" con tooltip.
- Avatar redondo del autor (gravatar/GitHub) pequeño (16-18 px) junto al nodo y en columna AUTHOR; fallback iniciales sobre color hash.
- Línea de conexión horizontal fina del color del carril desde la pill hasta el nodo.
- Hover sobre rama: el resto del grafo se atenúa (opacidad ~0.3).

### Menús contextuales (exactos / por superficie)
- **Commit (grafo):** Create branch here · Checkout this commit · Create tag here · Create annotated tag here · Cherry pick commit · Revert commit · Reset *<branch>* to this commit ▸ (Soft / Mixed / Hard) · Edit commit message (solo HEAD) · Interactive rebase *<branch>* onto this commit / Rebase *<branch>* onto this commit · Squash N commits (multi-selección) · Cherry pick N commits (multi) · Compare commits (2 seleccionados) · Copy commit sha · Copy commit message · Create patch from commit · Hide / Solo.
- **Rama (pill o panel):** Checkout · Merge *<rama>* into *<actual>* · Rebase *<actual>* onto *<rama>* · Fast-forward *<actual>* to *<rama>* · Create branch here · Rename · Delete · Pin to left / Unpin · Hide / Show · Solo / Unsolo · Set upstream · Push / Pull / Fetch · Create worktree from… · Copy branch name · Change branch color (rueda) · (remota) Delete remote branch · Checkout. Con rama en worktree: Open this worktree / Open in new tab / Lock / Remove.
- **Tag:** Checkout · Create branch here · Push tag · Delete tag (local/remoto) · Copy tag name · Hide/Solo.
- **Stash:** Apply · Pop · Delete · Hide · Edit stash message · Copy.
- **Archivo (Commit Panel):** Stage file / Unstage file · Discard changes · Stash file · Ignore ▸ (this file / folder / extension) · File history · Blame · Open in default program · Open in external diff tool · Open in editor · Show in folder · Copy file path · Resolve (conflicto). Multi-selección con Shift/Ctrl: "Stage N files", "Discard N files", "Stash N files".
- **Cabecera de columna / sección:** mostrar/ocultar columnas o secciones.
- **Pestaña:** Rename (alias) · Close · Close others · Open in terminal / file manager · Copy path.
- **Submódulo:** Open · Update · Init · Remove. **Remoto:** Fetch · Edit · Delete · Add remote.

### Colores y densidad
- Tema Dark por defecto: fondo app ≈ #1B1F27 / paneles #232933, bordes finos, texto #D9DEE7, acento verde-azulado `#00C7A0` (GK usa verde para commit/stage y azul/morado para rama HEAD). CaesarGit mantiene su acento ámbar; solo copiar *estructura*, no la paleta.
- Carriles: ≈10 colores saturados (rojo, naranja, amarillo, verde, cian, azul, violeta, rosa…), ancho de línea 2 px, nodos 10-12 px, separación de carril 14-16 px.
- Densidad: filas 26-28 px, pestañas 36 px, toolbar 44 px, status 24 px; fuente UI 13 px; mono 12 px para SHA y diff. Iconos 16 px (lucide stroke 1.75).
- Estados: hover = +4 % luz; selección = fondo acento al 18 % + borde izquierdo 2 px.

### Modales y diálogos
- **Create Branch / Stash / Tag:** input único inline sobre la toolbar (popover anclado al botón) con Enter para confirmar, Esc cancelar; Create Branch con checkbox "Checkout".
- **Merge / Rebase por DnD:** popover en el punto de soltar con 3 opciones: *Merge A into B*, *Rebase A onto B*, *Fast-forward*; Push por DnD a remoto: *Push A to B* / *Force push*.
- **Pull ▾**: menú con radios (Fast-forward if possible / Fast-forward only / Rebase), "Set as default" y "Fetch all".
- **Reset:** modal con 3 radios Soft / Mixed / Hard y descripción de cada uno, botón rojo en Hard.
- **Interactive rebase:** panel en la zona del grafo (no modal) con lista arrastrable, selector de acción por fila (pick/reword/squash/fixup/drop/edit), botón `Start Rebase`.
- **Clone/Init:** pantalla tipo wizard en pestaña "New Tab" con panel izquierdo (Open / Clone / Init / Hosts) y formulario derecha (URL, carpeta, nombre, botón `Clone the repo!`, barra de progreso).
- **Conflictos:** vista completa de 3 paneles (Current/Incoming arriba con checkboxes por bloque, Output abajo, botón `Save`/`Mark resolved`), contador de conflictos y navegación entre archivos en lista izquierda.
- **Preferences:** modal grande con lista de secciones a la izquierda (General, UI Customization, External Tools, Commit Signing, Editor, Notifications, Repo-specific…) y contenido a la derecha.
- **Confirmaciones destructivas:** diálogo pequeño centrado, título + descripción + botón rojo; confirmar "Discard", "Delete branch", "Force push".
- **Toasts** inferiores derechos para errores/ok con botón "Undo" tras acciones reversibles.
- **Atajos GK a replicar:** ⌘B crear rama · ⌘L fetch all · S/U stage/unstage archivo actual · ⌘⇧S/⌘⇧U todo · ⌘Enter commit · ⌘⇧Enter stage all + commit · ⌘⇧M foco mensaje · J/K/H/L navegación · ⌘↑/↓ primer/último commit · ⌘Z/⌘Y undo/redo · ⌘P palette · ⌘F buscar commits · ⌘⇧O abrir repo · ⌘⇧H buscar archivo (historial/blame) · ⌘⌥F filtro panel izq. · ⌥T terminal · ⌥O file manager · ⌘D difftool · ⌘T/W/1-9 pestañas · ⌘J panel izq. · ⌘+/−/0 zoom · ⌘/ lista de atajos · Esc cerrar panel.
