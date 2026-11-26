# API R1 (backend) — firmas finales

Todos los comandos se invocan con `invoke(nombre, { ...args })`. Args en camelCase; `repoPath` siempre es la ruta del repo salvo que se indique.
Errores: `{code, message}` (`invalid_path | invalid_arg | git_failed | not_a_repo | io | conflict | busy`).
`?` = opcional (puede omitirse o ir `null`). Los comandos existentes siguen funcionando sin los args nuevos, salvo los dos cambios de forma marcados como **ROMPE**.

## Evento

`git-progress` (emitido por `clone_repo`): `{ repoPath?: string, op: "clone", percent: number /*0-100 global*/, message: string }`.

## Undo / Redo

| Comando | Args | Retorno |
|---|---|---|
| `undo_state` | `repoPath` | `{ undoLabel: string\|null, redoLabel: string\|null }` |
| `undo_action` | `repoPath` | `string` (etiqueta de lo deshecho). Error `invalid_arg` si no hay nada |
| `redo_action` | `repoPath` | `string` (etiqueta de lo rehecho) |

Se registra una entrada antes de: checkout (+remoto), crear/renombrar/borrar rama(s), commit, amend, merge, rebase (+interactivo, +continue), cherry-pick, revert, reset, `undo_last_commit`, stash push/apply/pop/drop/branch/apply_file/rename, stage/unstage (rutas, todo, hunk, líneas), discard (rutas, todo, hunk), `clean_untracked`, tags (crear/borrar), `fast_forward_branch`, `edit_commit_message`. Solo si el comando cambió HEAD/refs/stash/índice/working tree (los que no cambian nada no dejan entrada). Un nuevo comando limpia la pila de redo. Máx. 100 por repo (en memoria). NO se deshacen: push, fetch, pull, config, remotos, escritura de archivos, resolver conflictos. Si hay una operación en curso (merge/rebase/...) el undo la aborta antes de restaurar. Incluye archivos sin seguimiento. Tras undo/redo el watcher emite `repo-changed`; refresca estado.
Etiquetas ejemplo: `"Commit"`, `"Amend"`, `"Checkout main"`, `"Merge x"`, `"Stage"`, `"Descartar todo"`, `"Cherry-pick de 3 commits"`, `"Stash"`.
Para R2: `crate::git::ext_a::tracked(&root, "etiqueta", async { ...; Ok(()) }).await` envuelve cualquier escritura.

## Comandos existentes con cambios

| Comando | Args (nuevos en negrita) | Retorno |
|---|---|---|
| `get_status` | `repoPath` | `RepoStatus` + **`detached: boolean`**, **`worktreeName: string\|null`** |
| `get_graph` | `repoPath, cursor, limit, hasWip, includeRefs?: string[], excludeRefs?: string[], author?, path?, grep?, since?, pickaxe?, pickaxeMode?: "S"\|"G", includeStashes?: boolean` | `GraphPage` |
| `search_commits` | `repoPath, query, scope?: "all"\|"message"\|"author"\|"sha"\|"file"\|"pickaxeS"\|"pickaxeG", since?, until?` | `CommitNode[]` (máx 200). `query` vacío + fechas = solo filtro por fecha |
| `get_file_diff` | `repoPath, path, staged, ignoreWhitespace, contextLines?: number, wordDiff?: boolean` | `DiffFile` |
| `get_commit_file_diff` | `repoPath, sha, path, ignoreWhitespace, contextLines?, wordDiff?` | `DiffFile` |
| `merge_branch` | `repoPath, name, mode?: "default"\|"no-ff"\|"ff-only"\|"squash"` | `void` (squash deja los cambios en stage, sin commit) |
| `rebase_onto` | `repoPath, name, autostash?: boolean` | `void` |
| `cherry_pick` | `repoPath, shas: string[]` **ROMPE** (antes `sha`) | `void`. Orden topológico automático |
| `revert_commit` | `repoPath, shas: string[], noCommit?: boolean` **ROMPE** (antes `sha`) | `void`. Del más nuevo al más antiguo |
| `stash_push` | `repoPath, message?, untracked?: boolean /*def. true*/, includeIgnored?, stagedOnly?, paths?: string[]` | `void` |
| `commit` | `repoPath, summary, description, amend, signoff?, noVerify?, coAuthors?: string[] /*"Nombre <correo>"*/, gpgSign?: boolean /*false=--no-gpg-sign*/` | `string` (sha) |
| `push` | `repoPath, force, setUpstream, noVerify?, tags?, followTags?, forceMode?: "lease"\|"force"` | `void` (`force` sin `forceMode` = lease) |
| `pull` | `repoPath, mode: "ff"\|"rebase"\|"merge", autostash?` | `void` |

`get_graph`: `cursor`/`nextCursor` cuentan commits crudos de git. `includeRefs` (si no vacío) reemplaza `--all`. `excludeRefs`: nombres cortos (`main`, `origin/main`, `v1`). Con `author/grep/since/pickaxe` los padres se omiten (nodos sueltos, `lanes` sin continuación); con `path` el grafo se reescribe. `includeStashes=true` añade cada stash como un nodo (un solo padre) con `refs: [{name:"stash@{0}", kind:"stash"}]`; con `false` los stashes ya no aparecen (antes `--all` los mostraba con sus commits internos). `pickaxe` por defecto `-S`.

## Nuevos (ext_a.rs)

| Comando | Args | Retorno |
|---|---|---|
| `clone_repo` | `url, dest /*ruta absoluta, vacía o inexistente*/, depth?, recursive?, branch?` (sin repoPath) | `string` ruta final. Emite `git-progress` |
| `init_templates` | — | `{ gitignore: string[], licenses: string[] }` |
| `init_repo` | `path, defaultBranch?, gitignoreTemplate?, license?` (sin repoPath) | `string` ruta. Licencias: MIT, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense |
| `list_remotes` | `repoPath` | `{name, fetchUrl, pushUrl}[]` (credenciales de URL enmascaradas) |
| `add_remote` | `repoPath, name, url` | `void` |
| `set_remote_url` | `repoPath, name, url, push?: boolean` | `void` |
| `remove_remote` | `repoPath, name` | `void` |
| `rename_remote` | `repoPath, old, new` | `void` |
| `set_upstream` | `repoPath, branch, remoteBranch` (p. ej. `origin/main`) | `void` |
| `unset_upstream` | `repoPath, branch` | `void` |
| `fast_forward_branch` | `repoPath, name, target?` (sin `target`: su upstream). Sin checkout si `name` no es HEAD | `void` |
| `push_branch` | `repoPath, remote, local, remoteBranch, force` (force = `--force-with-lease`) | `void` |
| `delete_branches` | `repoPath, names: string[], force` (borra todas las posibles; error agregado si alguna falla) | `void` |
| `delete_remote_tag` | `repoPath, remote, name` | `void` |
| `push_all_tags` | `repoPath, remote?` | `void` |
| `op_skip` | `repoPath` (rebase/cherry-pick/revert) | `void` |
| `resolve_with_side` | `repoPath, path, side: "ours"\|"theirs"` (también delete/modify) | `void` |
| `stash_apply_file` | `repoPath, index, path` | `void` |
| `stash_rename` | `repoPath, index, message` | `void` |
| `clean_untracked` | `repoPath, paths?: string[]` (sin paths = todo lo no ignorado) | `void` |
| `ignore_pattern` | `repoPath, path, kind: "file"\|"folder"\|"extension", target: "gitignore"\|"local"` (`local` = `.git/info/exclude`) | `void` |
| `get_file_blob_base64` | `repoPath, rev /*sha, ref, "INDEX" o "WORKTREE"*/, path` (máx 20 MB) | `{ base64, mime, size }` |
| `show_file` | `repoPath, rev, path` (texto, máx 10 MB, error si binario) | `string` |
| `read_file` | `repoPath, path` (máx 10 MB) | `string` |
| `write_file` | `repoPath, path, content` (crea carpetas; prohibido `.git/**`) | `void` |
| `get_repo_config` | `repoPath` | `{ key, local: string\|null, effective: string\|null }[]` |
| `set_repo_config` | `repoPath, key, value: string\|null` (`null` borra) | `void` |
| `get_commit_template` | `repoPath` | `{ summary, description } \| null` |
| `edit_commit_message` | `repoPath, sha, message` (HEAD: amend sin colar lo staged; antiguo: rebase scriptado con autostash; error con merges en medio o commit inicial) | `void` |
| `open_in_terminal` | `repoPath` | `void` |
| `reveal_in_file_manager` | `repoPath, path?` | `void` |
| `open_in_editor` | `repoPath, path, editor?: "code"\|"cursor"\|"windsurf"\|"zed"\|"subl"\|"idea"\|"webstorm"\|"pycharm"` (sin editor: editor de texto del sistema) | `void` |
| `run_difftool` | `repoPath, path, staged` (requiere `diff.tool`; lanza sin esperar) | `void` |
| `run_mergetool` | `repoPath, path` (requiere `merge.tool`) | `void` |
| `get_activity_log` | `limit?: number` (def. 200, máx 500; global a todos los repos) | `ActivityEntry[]` (recientes primero) |
| `compare_refs` | `repoPath, a, b` | `DiffFile[]` (sin hunks) |
| `compare_file_diff` | `repoPath, a, b, path, ignoreWhitespace?, contextLines?, wordDiff?` | `DiffFile` |
| `is_ancestor` | `repoPath, a, b` | `boolean` |
| `list_authors` | `repoPath` | `{ name, email, count }[]` |

Claves de `get_repo_config`/`set_repo_config` (lista blanca): `user.name user.email user.signingkey commit.gpgsign tag.gpgsign gpg.format(openpgp|ssh|x509) pull.rebase pull.ff fetch.prune push.autosetupremote push.default core.autocrlf core.eol core.filemode core.ignorecase core.longpaths init.defaultbranch commit.template merge.ff rebase.autostash rebase.autosquash diff.tool merge.tool`.

## Estructuras nuevas / cambiadas (JSON)

```jsonc
// DiffLine (words solo con wordDiff=true y solo en líneas add/del emparejadas)
{ "kind": "add", "content": "x", "oldNo": null, "newNo": 3, "words": [ { "text": "let ", "changed": false }, { "text": "foo", "changed": true } ] }

// RefLabel.kind admite ahora "stash"
{ "name": "stash@{0}", "kind": "stash" }

// ActivityEntry
{ "id": 12, "timestampMs": 1760000000000, "repo": "mi-repo", "kind": "read|write",
  "command": "git log --all --topo-order ...", "ok": true, "durationMs": 14, "error": null }

// RemoteInfo
{ "name": "origin", "fetchUrl": "https://github.com/a/b.git", "pushUrl": "https://github.com/a/b.git" }

// BlobData
{ "base64": "iVBORw0...", "mime": "image/png", "size": 12345 }

// ConfigEntry / CommitTemplate / AuthorInfo / UndoState / InitTemplates
{ "key": "user.name", "local": "Ana", "effective": "Ana" }
{ "summary": "feat: ", "description": "cuerpo" }
{ "name": "Ana", "email": "a@x.com", "count": 42 }
{ "undoLabel": "Commit", "redoLabel": null }
{ "gitignore": ["Node", "Rust"], "licenses": ["MIT", "ISC"] }

// RepoStatus (campos nuevos)
{ "branch": null, "detached": true, "worktreeName": "wt-feature" }
```

## Seguridad / notas

- Sin shell; URLs validadas (`https|http|ssh|git|file://`, `user@host:ruta`, ruta local; bloquea `-`, `ext::`, espacios); clone con `protocol.ext.allow=never`.
- Toda ejecución de proceso en Windows usa `CREATE_NO_WINDOW`; solo `open_in_terminal` (fallback `cmd.exe`) usa `CREATE_NEW_CONSOLE`.
- `read_file/write_file/show_file/ignore_pattern/open_in_editor` pasan por `path_guard` y rechazan cualquier ruta con componente `.git`.
- El activity log guarda comando sanitizado (`<repo>` en vez de la ruta, credenciales de URL ocultas) y no guarda stdin (mensajes de commit por `-F -`).
- Undo usa un índice temporal (`GIT_INDEX_FILE`) para fotografiar el working tree; los objetos quedan en el ODB (gc normal).
