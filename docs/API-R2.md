# API R2 (git::ext_b) — comandos Tauri

Convenciones: `invoke("cmd", {args})` con args en camelCase; errores `{code, message}` (`invalid_arg`, `invalid_path`, `git_failed`, `conflict`...).
`repoPath` = ruta del repo en todos los comandos salvo `save_patch` y `hook_templates`. `T?` = opcional (puede omitirse).
Todas las structs devuelven JSON camelCase.

## Reflog
- `get_reflog {repoPath, limit?: number (def 200, máx 5000)}` -> `ReflogEntry[]` = `{sha, selector:"HEAD@{n}", action:"commit|checkout|reset|rebase...", message, date: ISO-8601}`. Repo vacío -> `[]`.

## Bisect (todos devuelven `BisectStatus`)
`BisectStatus = {active, current?: sha (HEAD a probar), remaining?: number (candidatos), log: string[], firstBad?: sha, message: string (salida de git)}`
- `bisect_start {repoPath, bad, good}`
- `bisect_mark {repoPath, kind: "good"|"bad"|"skip"}` (cuando `firstBad` viene relleno, bisect terminó; llamar `bisect_reset`)
- `bisect_reset {repoPath}` (restaura la rama original)
- `bisect_status {repoPath}`

## Parches
- `create_patch {repoPath, shas?: string[], wip?: boolean}` -> `string`. `wip=true`: diff de cambios sin commitear vs HEAD (con binarios); si no, `format-patch` de cada sha en el orden dado, concatenados. Error si queda vacío.
- `save_patch {path, content}` -> `void`. `path` absoluta del diálogo de guardado (puede estar fuera del repo); sin `..`, sin pasar por `.git`, extensión `.patch`/`.diff`, carpeta existente.
- `apply_patch {repoPath, patch, check, index}` -> `void`. `check=true` solo comprueba (`git apply --check`); `index=true` aplica también al índice.

## Submódulos
`Submodule = {name, path, url, branch?, sha, status: "ok"|"uninitialized"|"modified"|"conflict"}`
- `list_submodules {repoPath}` -> `Submodule[]`
- `submodule_add {repoPath, url, path, branch?}` -> `void` (url: https://, ssh://, git@host:ruta, file://, ruta local; `ext::` y similares rechazados)
- `submodule_init {repoPath, path?}` -> `void`
- `submodule_update {repoPath, recursive, remote, path?}` -> `void` (incluye `--init`)
- `submodule_sync {repoPath, recursive}` -> `void`
- `submodule_remove {repoPath, path}` -> `void` (deinit + rm + limpia .gitmodules + borra `.git/modules/<name>`)

Nota: para actualizar submódulos con URL `file://` git exige `protocol.file.allow=always` en la config (solo `submodule_add` lo fuerza).

## Worktrees
`Worktree = {path, branch?, sha, locked, lockReason?, prunable, isMain, detached}`
- `list_worktrees {repoPath}` -> `Worktree[]`
- `add_worktree {repoPath, path, branch, newBranch, startPoint?}` -> `void` (`path` absoluta del usuario; `newBranch=true` crea la rama desde `startPoint` o HEAD)
- `lock_worktree {repoPath, path, reason?}` -> `void`
- `unlock_worktree {repoPath, path}` -> `void`
- `remove_worktree {repoPath, path, force, deleteBranch}` -> `void` (el principal no se puede eliminar; `deleteBranch` usa `-d`, o `-D` con `force`)
- `prune_worktrees {repoPath}` -> `number` (worktrees obsoletos que había)
`path` en lock/unlock/remove debe ser uno de los listados.

## Git LFS
Sin git-lfs instalado: `lfs_status` devuelve `installed:false`; el resto falla con `{code:"git_failed", message:"Git LFS no está instalado..."}`.
- `lfs_status {repoPath}` -> `{installed, version, patterns: {pattern, source}[], files: {path, oid, downloaded}[]}`
- `lfs_install {repoPath}` -> `string` (`git lfs install --local`)
- `lfs_track {repoPath, pattern}` / `lfs_untrack {repoPath, pattern}` -> `void`
- `lfs_pull` / `lfs_fetch` / `lfs_prune {repoPath}` -> `string` (salida)
- `lfs_locks {repoPath}` -> `{id, path, owner, lockedAt}[]`
- `lfs_lock {repoPath, path}` -> `void`
- `lfs_unlock {repoPath, path, force}` -> `void`

## Gitflow (config en `.git/config`, claves `gitflow.*`)
`FlowConfig = {initialized, master, develop, feature, release, hotfix, support, versionTag}` (los 4 prefijos terminan en `/`, p. ej. `"feature/"`; `initialized` se ignora al enviar)
- `flow_get_config {repoPath}` -> `FlowConfig` (defaults si no está inicializado)
- `flow_init {repoPath, config: FlowConfig}` -> `FlowConfig` (la rama master debe existir; crea develop si falta)
- `flow_start {repoPath, kind: "feature"|"release"|"hotfix"|"support", name}` -> `string` (rama creada; feature/release parten de develop, hotfix/support de master)
- `flow_finish {repoPath, kind, name, opts?: {keepBranch, squash, noFf, tag, tagMessage?, push}}` -> `void`. feature -> develop (noFf opcional); release/hotfix -> master (+tag `versionTag+name` si `tag`) y develop, siempre `--no-ff` salvo `squash`; `push` envía a `origin`. Un conflicto devuelve `code:"conflict"` y deja el merge en curso (usar `op_abort`/resolver). `support` no se finaliza.
- `flow_status {repoPath}` -> `{initialized, config, feature: string[], release: string[], hotfix: string[], support: string[], current?: {kind, name}}` (nombres sin prefijo)

## Hooks
Nombres permitidos: lista blanca de hooks estándar de git (applypatch-msg, pre-commit, commit-msg, pre-push, post-merge, ...). Respeta `core.hooksPath`.
- `list_hooks {repoPath}` -> `{name, exists, active, isSample, disabled}[]`
- `read_hook {repoPath, name}` -> `string` (real, `.disabled` o `.sample`)
- `write_hook {repoPath, name, content}` -> `void` (LF, chmod 755; si estaba desactivado lo sigue estando)
- `toggle_hook {repoPath, name, enabled}` -> `void` (renombra `.disabled`; activar un `.sample` lo copia)
- `delete_hook {repoPath, name}` -> `void`
- `hook_templates {}` -> `{name, title, description, content}[]` (pre-commit, commit-msg, pre-push)

## Squash / fixup / drop / move (reescriben historia; exigen tramo sin merges)
Si el rebase se detiene por conflicto devuelven `code:"conflict"`; el frontend usa `op_continue`/`op_abort`.
- `squash_commits {repoPath, shas: string[] (>=2, consecutivos, cualquier orden), message}` -> `void` (mensaje vacío = el combinado por defecto)
- `fixup_commit {repoPath, sha}` -> `void` (requiere cambios preparados; `commit --fixup` + autosquash; conserva los no preparados con autostash)
- `drop_commit {repoPath, sha}` -> `void`
- `move_commit {repoPath, sha, direction: "up"|"down"}` -> `void` ("up" = hacia HEAD/más nuevo, "down" = hacia la raíz)

## Prevención de conflictos
- `check_merge_conflicts {repoPath, source}` -> `{willConflict, files: string[], truncated}`. Simula `merge source` sobre HEAD con `git merge-tree --write-tree`; no toca el árbol de trabajo.

## Estadísticas
- `repo_stats {repoPath}` -> `{commits, branches, remoteBranches, tags, contributors: {name, email, commits}[] (top 10)}`
