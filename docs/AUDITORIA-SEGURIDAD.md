# Auditoría de seguridad de CaesarGit

Fecha: 2026-11-26. Versión auditada: 0.2.1 (árbol de trabajo en `master`, con cambios sin commitear en `tauri.conf.json`, `capabilities/default.json`, `App.tsx`, `RepoTabBar.tsx`, `index.css`).
Alcance: `src-tauri/` (Rust), `src/` (React/TS), configuración Tauri, `scripts/`, `.github/workflows/`, dependencias.
Método: revisión estática manual de código (solo lectura), `npm audit --omit=dev` y `cargo audit`. No se ejecutó la aplicación ni se hicieron pruebas dinámicas/fuzzing. No se modificó ningún archivo del repo salvo este informe.

Todas las rutas son relativas a `/Users/cesargarrido/Proyectos/caesargit`. Las del backend son `src-tauri/src/...`.

## 1. Resumen ejecutivo

El diseño es sólido para ser una app que envuelve `git`: nunca se usa shell, los argumentos se pasan como vector, casi todos los datos de usuario pasan por validadores (`arg_guard`, `path_guard`), hay `--` en la mayoría de los comandos con rutas, las claves de configuración editables están en lista blanca, la CSP es estricta, el frontend no tiene sinks de HTML y el actualizador verifica firma minisign. `npm audit` y `cargo audit` no encuentran vulnerabilidades (solo 3 avisos de crates sin mantenimiento/unsound transitivos).

El riesgo real no está en la inyección de argumentos sino en el modelo de confianza: **CaesarGit ejecuta `git` dentro de cualquier carpeta que el usuario abra, y git ejecuta programas definidos en `.git/config` y `.git/hooks` de esa carpeta**. La app no distingue repos de confianza de repos no confiables.

| Severidad | Nº | Hallazgos |
|---|---|---|
| Crítico | 0 | |
| Alto | 1 | H-01 abrir un repo no confiable ejecuta código (`core.fsmonitor` y similares) |
| Medio | 5 | M-01 `open` ejecuta `.app` dentro del repo; M-02 pathspecs mágicos/glob en rutas; M-03 snapshot de undo guarda archivos sin seguimiento en `.git/objects`; M-04 `commit.template` lee archivos del HOME; M-05 difftool/mergetool con config del repo |
| Bajo | 9 | B-01 a B-09 |
| Info | 8 | I-01 a I-08 |

## 2. Hallazgos

### H-01 (Alto): abrir un repositorio no confiable ejecuta código del repo

- Archivos: `src-tauri/src/git/executor.rs:99-116` (`run_inner`), `src-tauri/src/security/path_guard.rs:7-24` (`open_repo_root`), `src-tauri/src/git/commands.rs:170-180` (`open_repo`, `get_status`), `src-tauri/src/watcher/repo_watcher.rs:44-60`.
- Descripción: cada comando se lanza con `git -c core.quotepath=false ...` en el directorio del repo, sin neutralizar la configuración local. No hay ningún aviso de confianza ni detección de claves peligrosas (`grep` de `fsmonitor`, `hooksPath`, `safe.directory`, `textconv` en `src/` y `src-tauri/src/`: sin resultados fuera de los tests).
- Explotación: el atacante entrega una carpeta que incluye su `.git/` (zip de un "proyecto", repo sincronizado en la nube, USB, adjunto, repo compartido en una carpeta de red). En `.git/config` pone `core.fsmonitor = /ruta/o/comando`. Al abrir la carpeta la app llama a `status_of` (`git status --porcelain=v2 ...`, `commands.rs:36`) y git ejecuta el hook de fsmonitor. Otras claves con el mismo efecto al hacer status/diff/log/blame/checkout/commit: `core.sshCommand` (fetch automático de `useGitEvents.ts:68` lo dispara solo), `core.pager`, `core.editor`, `diff.<drv>.textconv` y `filter.<drv>.clean/smudge` (con `.gitattributes`), `credential.helper`, `gpg.program`, `core.hooksPath`, alias, `include.path`, `url.<x>.insteadOf`. Además `.git/hooks/*` se ejecutan en `commit`, `checkout`, `merge`, `rebase`, `push`, etc. (el commit con `--no-verify` es opcional). El `safe.directory` de git no ayuda: solo comprueba propietario y una carpeta descomprimida pertenece al usuario.
- Nota: un `git clone` normal NO trae config ni hooks, así que el flujo de clonado de la app no es vulnerable a esto. Solo carpetas locales preexistentes.
- Arreglo propuesto (mínimo, en `run_inner` y `run_streaming`):

```diff
-    cmd.arg("-c").arg("core.quotepath=false");
+    // Neutraliza vectores de ejecución por config local. fsmonitor nunca se necesita aquí.
+    cmd.args(["-c", "core.quotepath=false", "-c", "core.fsmonitor=false",
+              "-c", "core.untrackedCache=false", "-c", "protocol.ext.allow=never"]);
```

  Además, en `open_repo` (o en `open_repo_root`), antes del primer `status`, leer `git config --local --list -z` y, si aparece alguna de las claves de la lista anterior o hay hooks ejecutables no-`.sample` en `.git/hooks`, mostrar un diálogo «Este repositorio define comandos que se ejecutarán (core.fsmonitor=…). ¿Confiar?» y guardar la decisión por `repo_id`. Sin confianza: abrir en modo lectura con `-c core.fsmonitor=false -c core.hooksPath=<vacío>` y sin `fetch` automático.

### M-01 (Medio): `open <carpeta>` en macOS ejecuta bundles `.app` del repo

- Archivo: `src-tauri/src/git/ext_a.rs:1101-1125` (`reveal_in_file_manager`; la rama `open` para no-archivos está en 1111-1113).
- Descripción: si `path` apunta a un directorio dentro del repo (`is_file == false`), se ejecuta `open <ruta>`. En macOS, `open` sobre un directorio con extensión `.app` lo lanza como aplicación.
- Explotación: un repo malicioso incluye `Juego.app/Contents/MacOS/...` (git conserva el bit de ejecución). El usuario hace «Mostrar en Finder» sobre esa carpeta desde el panel de archivos. Los archivos traídos por git no llevan el atributo de cuarentena, así que Gatekeeper no los evalúa; un binario con firma ad-hoc basta en arm64.
- Arreglo:

```diff
-        if is_file {
-            executor::spawn_detached("open", &["-R", &t], None, false)
-        } else {
-            executor::spawn_detached("open", &[&t], None, false)
-        }
+        // -R revela en Finder sin abrir; para la raíz del repo (`path == None`) sigue valiendo `open`.
+        if path_is_some || is_file {
+            executor::spawn_detached("open", &["-R", &t], None, false)
+        } else {
+            executor::spawn_detached("open", &[&t], None, false)
+        }
```

  (`path_is_some` = el argumento `path` venía informado.) En Linux `xdg-open <dir>` abre el gestor; no ejecuta. En Windows `explorer.exe <dir>` tampoco ejecuta.

### M-02 (Medio): pathspecs mágicos y comodines en rutas de usuario

- Archivos: `src-tauri/src/security/path_guard.rs:62-69` (`safe_rel`), usado en `commands.rs:20-25` (`rels`) y en `stage_paths`/`discard_paths`/`stash_push`/`clean_untracked`/`blame`/`file_history`/`lfs_*`/`submodule_*`. `discard_rels` en `commands.rs:737-755` (`git restore --worktree -- <rutas>`, `git clean -f -d -- <ruta>`).
- Descripción: las rutas se pasan tras `--`, lo que evita option injection, pero git sigue interpretándolas como pathspec: prefijo mágico `:(...)`, `:/`, `:!` y comodines `*`, `?`, `[...]`. No se usa `--literal-pathspecs` ni `GIT_LITERAL_PATHSPECS` (grep sin resultados).
- Explotación: un archivo llamado `:(glob)**` o `*` (nombres válidos en Linux/macOS) aparece en el estado; si el usuario pulsa «Descartar» en él, `git restore --worktree -- ':(glob)**'` o `git clean -f -d -- '*'` afecta a muchos archivos más que el seleccionado: pérdida de datos no recuperable de cambios sin commitear. Caso no malicioso equivalente: `[id].tsx` (Next.js) con comodín `[...]` no coincide consigo mismo y sí con `i.tsx`/`d.tsx`.
- Arreglo (una línea en `run_inner`/`run_streaming`):

```diff
         .env("GIT_TERMINAL_PROMPT", "0")
+        .env("GIT_LITERAL_PATHSPECS", "1")
         .env("LC_ALL", "C")
```

  Excepción a revisar: `search_commits` con scope `file` (`commands.rs:~296`) pasa texto libre como pathspec y quizá se quiera glob; ahí se puede pasar `GIT_LITERAL_PATHSPECS=0` con `write_env`/`read_env`.

### M-03 (Medio): el undo guarda en `.git/objects` el contenido de todos los archivos sin seguimiento

- Archivo: `src-tauri/src/git/ext_a.rs:86-100` (`worktree_tree`, `git add -A` con índice temporal en la línea 96), `ext_a.rs:159-178` (`tracked`: llama a `snapshot` antes y después de cada operación).
- Descripción: cada acción envuelta en `tracked` (checkout, merge, stage, commit, stash…) ejecuta `git add -A` sobre un índice temporal. Eso escribe como objetos sueltos todos los archivos no ignorados del árbol: `.env` no ignorados, claves, volcados, binarios de GB. Quedan como objetos huérfanos en `.git/objects` hasta que `git gc` los poda (por defecto ≥ 2 semanas) y, mientras tanto, viajan con cualquier copia de la carpeta `.git`. También ejecuta los filtros `clean` configurados.
- Explotación: fuga local/persistencia de secretos que el usuario nunca pasó por `git add`; carpeta con archivos enormes sin ignorar puede colgar la app (sin límite de tiempo ni tamaño).
- Arreglo: limitar el snapshot de untracked: ignorar archivos > N MB y documentarlo, o usar `git stash create -u`-like con límites, o guardar solo hashes (`git hash-object` sin `-w` en memoria) y no escribir objetos. Como mínimo, avisar en Ajustes y ofrecer desactivar «Deshacer». Como mitigación barata: `-c core.bigFileThreshold` no sirve aquí; sí `GIT_OBJECT_DIRECTORY` apuntando a un tempdir con `GIT_ALTERNATE_OBJECT_DIRECTORIES` hacia el real, de modo que los objetos nuevos del `add -A` se escriben en el tempdir y se descartan junto al índice temporal (el `write-tree` los referencia solo en el snapshot; habría que conservar el tempdir mientras exista la entrada de undo en memoria).

### M-04 (Medio): `commit.template` permite leer archivos del HOME desde la config del repo

- Archivo: `src-tauri/src/git/ext_a.rs:979-1013` (`get_commit_template`).
- Descripción: la ruta sale de `git config --type=path --get commit.template`, o sea, de la config del repo. Se acepta cualquier archivo dentro del repo o de `$HOME` (≤ 64 KB) salvo si algún componente es `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`. El contenido se devuelve al frontend y se precarga en el cuadro de mensaje.
- Explotación (requiere config de repo no confiable, ver H-01): `commit.template = ~/.npmrc` (o `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.git-credentials`, `~/.zsh_history`, `~/Library/Application Support/...`). El texto aparece en el campo de commit y el usuario puede acabar commiteándolo y empujándolo sin darse cuenta. Las líneas que empiezan por `#` se filtran, el resto se muestra.
- Arreglo: permitir solo rutas dentro del repo (`canon.starts_with(&r)`) o dentro de un único archivo conocido por el usuario guardado en Ajustes. Si se mantiene el HOME, ampliar la lista a `.config`, `.netrc`, `.npmrc`, `.git-credentials`, `.gitconfig`, `Library`, `*history*`.

### M-05 (Medio): difftool/mergetool ejecutan el comando definido en la config del repo

- Archivo: `src-tauri/src/git/ext_a.rs:1169-1196` (`tool_configured`, `run_difftool`, `run_mergetool`). Lista blanca de claves editables en `src-tauri/src/security/arg_guard.rs:112-136` (incluye `diff.tool` y `merge.tool`).
- Descripción: `git difftool`/`git mergetool` ejecutan `difftool.<tool>.cmd`/`mergetool.<tool>.cmd` (o un ejecutable `git-difftool--helper`) definidos en cualquier nivel de config, incluida la del repo. La app solo comprueba que `diff.tool` tenga valor.
- Explotación: repo no confiable con `[difftool "x"] cmd = ...` y `[diff] tool = x`. Al pulsar «Abrir en difftool» se ejecuta. Es el mismo problema de fondo que H-01 pero con una acción explícita del usuario que parece inocua. Con la lista blanca actual el propio atacante no puede fijar `.cmd` desde la UI, solo desde el `.git/config` entregado.
- Arreglo: tratar `difftool.*.cmd`/`mergetool.*.cmd` como claves sensibles en el chequeo de confianza de H-01 y mostrar el comando exacto en un diálogo antes de ejecutar si proviene de la config local (`git config --show-origin --get diff.tool`).

### B-01 (Bajo): comandos de escritura distintos no rechazan `.git`

- Archivos: `src-tauri/src/git/commands.rs:1320-1327` (`resolve_conflict`) y `1299-1317` (`get_conflict`) usan `safe_rel`/`safe_join` sin `reject_dot_git` (ese control vive solo en `ext_a.rs:264` y se aplica en `rel_inside`).
- Descripción: `resolve_conflict(path=".git/hooks/pre-commit", content=...)` sobrescribe un hook existente (el `chmod` no se aplica aquí, así que solo sirve si ya era ejecutable) o `.git/config`. `get_conflict(path=".git/config")` lee `.git/config`. Con webview comprometido ya existe `write_hook`, así que es defensa en profundidad.
- Arreglo: mover `reject_dot_git` a `path_guard::safe_rel` para que lo apliquen todos los comandos.

### B-02 (Bajo): los hooks siguen symlinks y `core.hooksPath`

- Archivo: `src-tauri/src/git/ext_b.rs:1175-1179` (`hooks_dir` usa `rev-parse --git-path hooks`, que respeta `core.hooksPath`), `1249-1263` (`write_hook`), `1234-1245` (`read_hook`).
- Descripción: con config de repo no confiable, `core.hooksPath=/ruta/cualquiera` hace que `write_hook`/`toggle_hook`/`delete_hook` creen, copien, renombren y borren archivos con nombre de hook (`pre-commit`, etc.) fuera de `.git/hooks` con modo 0755. `read_hook` lee cualquier archivo con ese nombre. `tokio::fs::write` sigue symlinks existentes.
- Arreglo: exigir que `hooks_dir` canonizado esté dentro del `git_dir` canonizado o mostrar la ruta real al usuario; abrir con `O_NOFOLLOW` o comprobar `symlink_metadata`.

### B-03 (Bajo): enmascarado de credenciales incompleto

- Archivos: `src-tauri/src/git/executor.rs:35` (`CRED_RE`), `executor.rs:41-56` (`describe`), `executor.rs:136-153` (`sanitize`), `src-tauri/src/git/ext_a.rs:249-261` (`mask_url`).
- Descripción: `CRED_RE = (://[^/@\s:]+):[^@\s/]+@` solo cubre `usuario:contraseña@`. No cubre tokens en el campo usuario (`https://ghp_xxx@github.com/...`, habitual con tokens de GitHub/GitLab), y una contraseña que contenga `@` o `/` deja un resto visible (`https://u:p@ss@host` → queda `ss@host`). `mask_url` conserva el campo `user`, que en el caso del token **es** el secreto. `sanitize` (mensajes de error de git que van al frontend y al registro de actividad) no aplica `CRED_RE`; solo sustituye la ruta del repo. Los argumentos con URL con credenciales también son visibles para otros usuarios locales con `ps` mientras corre git (`clone`, `remote add`).
- Arreglo: enmascarar todo el userinfo cuando no es el usuario de scp (`git@`):

```diff
-static CRED_RE: ... Regex::new(r"(://[^/@\s:]+):[^@\s/]+@")
+static CRED_RE: ... Regex::new(r"(?i)(\w+://)[^/\s]*@")   // -> "$1***@"
```

  y aplicar la misma sustitución dentro de `sanitize()`. Documentar que no se deben pegar tokens en la URL; usar el credential helper del sistema.

### B-04 (Bajo): sin versión mínima de git

- Archivos: todo el backend usa `Command::new("git")` (`executor.rs:100`, `231`); no hay comprobación de `git --version`.
- Descripción: parte de la seguridad (clonado local/recursivo, submódulos con symlinks, `file://` en submódulos) depende de que git esté parcheado. En concreto CVE-2024-32002/32004/32465 y la familia de abril de 2024 (clon recursivo y local de repos maliciosos) se corrigen a partir de git 2.45.1/2.44.1 y backports. El Git de macOS (Apple Git 2.50.1 en esta máquina) está por encima; en Windows y Linux depende del sistema del usuario.
- Arreglo: al arrancar ejecutar `git --version`, comparar y mostrar aviso «Actualiza git (versión mínima 2.45.1)». No pude verificar qué versiones de git llevan los usuarios finales.

### B-05 (Bajo): sin timeouts ni límite de salida en git

- Archivo: `src-tauri/src/git/executor.rs:128` (`wait_with_output` acumula todo stdout en memoria), `229-283` (`run_streaming` sin timeout), `GIT_TERMINAL_PROMPT=0` solo evita prompts de credenciales de git, no de ssh/askpass.
- Descripción: un remoto lento, un `ssh` que pida confirmar la clave de host o una salida enorme puede bloquear una tarea indefinidamente o agotar memoria. Efecto: DoS local, no hay escalada.
- Arreglo: `tokio::time::timeout` para comandos de red, límite de bytes en lectura, `GIT_SSH_COMMAND` con `-o BatchMode=yes` solo cuando el usuario no haya definido `core.sshCommand`.

### B-06 (Bajo): `git diff` de `create_patch` sin `--no-ext-diff`/`--no-textconv`

- Archivo: `src-tauri/src/git/ext_b.rs:198` (`diff --binary --no-color HEAD --`) y los `diff/show/log` que sí llevan `--no-ext-diff` (`commands.rs:120`, `829`, `850`, `ext_a.rs:1220`, `1244`) no llevan `--no-textconv`; `blame` y `file_history` tampoco.
- Descripción: `diff.<driver>.textconv` y `diff.external` son comandos arbitrarios si la config local los define (ver H-01). El resto del código ya quiso evitar `diff.external`; es una inconsistencia.
- Arreglo: añadir `--no-ext-diff --no-textconv` a todos los diffs/show/log -p/blame.

### B-07 (Bajo): TOCTOU y validación de rutas externas

- Archivos: `src-tauri/src/security/path_guard.rs:28-58` (`safe_join` resuelve symlinks al validar, pero la escritura posterior es otra operación), `ext_b.rs:38-53` (`validate_external_path`: no canoniza), `ext_b.rs:226-246` (`save_patch`).
- Descripción: entre la validación y el `write`, un proceso local puede sustituir un directorio por un symlink. Para `save_patch` y `add_worktree` la ruta es «absoluta, sin `..`, sin `.git`», sin canonizar, y `save_patch` solo exige extensión `.patch`/`.diff`. Con un webview comprometido permitiría crear archivos `.patch` en cualquier carpeta; con un diálogo legítimo no hay problema.
- Arreglo: canonizar el padre en `validate_external_path` y recomprobar justo antes de escribir.

### B-08 (Bajo): sin ACL de comandos de la app (todos los comandos disponibles al webview)

- Archivos: `src-tauri/build.rs:1` (`tauri_build::build()` sin `AppManifest`), `src-tauri/src/lib.rs:11-162`.
- Descripción: en Tauri 2 los comandos propios (~140) son invocables desde cualquier página cargada en el webview si no se declara un manifiesto de permisos de la app. Hoy el único origen es el propio bundle con CSP estricta y sin sinks de HTML, por lo que el riesgo es bajo, pero cualquier XSS futuro daría control total sobre cualquier repo del disco (leer, escribir, hooks, abrir terminal).
- Arreglo: `tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[...]))` y añadir los permisos `allow-*` generados a `capabilities/default.json`. Es trabajo mecánico, no urgente.

### B-09 (Bajo): cadena de suministro de CI y workflow

- Archivos: `.github/workflows/release.yml` y `.github/workflows/check.yml`.
- Descripción: acciones referenciadas por etiqueta móvil (`actions/checkout@v4`, `actions/setup-node@v4`, `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`, `tauri-apps/tauri-action@v0`), no por SHA. `tauri-action` recibe `TAURI_SIGNING_PRIVATE_KEY` y su contraseña: un compromiso de esa acción permitiría firmar actualizaciones maliciosas para Windows/Linux. `permissions: contents: write` está a nivel de workflow, no por job. El nombre del tag (`${{ github.ref_name }}`) se interpola directamente en scripts `run:`; solo explotable por quien ya puede subir tags. La toolchain `stable` sin fijar hace builds no reproducibles.
- Arreglo: fijar por SHA completo (Dependabot para actualizarlas), mover `permissions` a cada job (solo `prepare`, `release` y `publish` necesitan escribir), pasar `github.ref_name` por `env:` en vez de interpolarlo.

### Información / observaciones (I-01 a I-08)

- I-01 Windows, PATH: `Command::new("git")`, `wt.exe`, `cmd.exe`, `explorer.exe`, `notepad.exe`, `<editor>.cmd` (`executor.rs:100,231,289`; `ext_a.rs:1066-1167`). La biblioteca estándar de Rust en Windows busca en: PATH del hijo, directorio del ejecutable, carpetas del sistema, PATH del padre, y desde Rust 1.58 ya NO busca en el directorio actual del padre; `current_dir(repo)` no afecta a la búsqueda. Por tanto un `git.exe` plantado dentro de un repo no se ejecuta. Queda el riesgo normal de un PATH de usuario con carpetas escribibles por terceros y de DLL planting en el directorio del instalador (el `.exe` se instala en una ruta propia). No pude comprobar el comportamiento en una máquina Windows. Los editores se lanzan como `code.cmd`: el mitigante de CVE-2024-24576 (BatBadBut) está en Rust ≥ 1.77.2; CI usa `stable` y el Mac local tiene rustc 1.99.1, pero conviene fijar `rust-version` mínima y evitar que el argumento (ruta de archivo del repo, controlable por el atacante) contenga `%`/`&` antes de pasarlo a un `.cmd`.
- I-02 `CREATE_NO_WINDOW`: aplicado en `executor.rs:115-116` y `241-242` (git) y `294-298` (procesos externos; `CREATE_NEW_CONSOLE` solo en `open_in_terminal`). Correcto. Efecto de seguridad neutro (solo oculta la consola). No puedo afirmar el comportamiento real en Windows sin ejecutarlo.
- I-03 `core:default` en `capabilities/default.json`: da permisos de lectura de ventana/app/ruta/evento, sin escritura de FS ni shell. `core:window:allow-start-dragging` (añadido en el árbol sin commitear) y `core:webview:allow-set-webview-zoom` son benignos. No hay plugins `shell`, `fs`, `opener` ni `http`.
- I-04 CSP (`tauri.conf.json`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:`. `'unsafe-inline'` en estilos es necesario para React/CodeMirror y de impacto bajo. Faltan `base-uri 'none'`, `form-action 'none'` y `object-src 'none'` explícitos (`object-src` sí hereda de `default-src`, `base-uri` y `form-action` no). Falta `app.security.freezePrototype: true`. Mejora opcional.
- I-05 Almacenamiento en el navegador: `localStorage` guarda preferencias, rutas de repos recientes (`useRepoStore.ts:11,193,229`) y apodos de pestañas; no hay tokens, contraseñas ni secretos (grep de `password|token|credential|secret|apikey` solo da falsos positivos). Las rutas pueden revelar el nombre de usuario del sistema.
- I-06 Firma de binarios: `tauri.conf.json` no configura firma de Windows (`bundle.windows.certificateThumbprint`/`signCommand`), por lo que el instalador de Windows saldrá sin firmar (aviso de SmartScreen) a menos que se firme en otro sitio; no lo pude verificar. macOS sí se firma y notariza en local (`scripts/mac-build.mjs:49-66`). `SHA256SUMS.txt` lo genera el mismo pipeline, no aporta independencia.
- I-07 `scripts/mac-build.mjs:79`: `notarytool ... --password env.APPLE_PASSWORD` pasa la contraseña de aplicación como argumento (visible con `ps` durante la notarización). Usar un perfil de llavero (`xcrun notarytool store-credentials` y `--keychain-profile`). `scripts/release.mjs:~81` hace `git add -A`; `.gitignore` no cubre `.env`, `*.key`, `*.pem`, `.tauri/`, así que un secreto suelto en el árbol acabaría en el commit. Añadir esas entradas.
- I-08 Dependencias: el entorno `inherit`: `executor.rs` no limpia variables de entorno del padre (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`, `GIT_SSH_COMMAND`). Si la app se arranca desde una shell con ellas definidas, afectan a todos los comandos. Opcional: `env_remove` de las `GIT_*` peligrosas.

## 3. Lo que está bien (verificado leyendo el código)

1. Sin shell: `Command::new("git").args(...)` en `executor.rs:100,231` y `spawn_detached` (`executor.rs:289`). Los únicos `sh` son los scripts temporales del rebase (`commands.rs:1243-1266`), con rutas del propio tempdir y rechazo de `'`, `\n` y NUL (`sh_path`, `commands.rs:~1190-1198`); el contenido de los scripts nunca incluye datos del usuario (solo `cat`/`echo` sobre archivos del tempdir).
2. Option injection: `validate_ref` (`arg_guard.rs:16-26`) rechaza vacío, `-` inicial, `..`, y caracteres fuera de `[A-Za-z0-9._/@{}^~:+-]`; `validate_branch_name` (`45-63`) replica `check-ref-format`; `validate_sha`, `validate_remote`, `validate_date`, `validate_search_text`. Tests unitarios cubren `--upload-pack=`, `-x`, `ext::`. Revisé a mano los ~100 puntos de llamada de `commands.rs`, `ext_a.rs` y `ext_b.rs`: todo valor de usuario que va a una posición de argumento pasa por un validador, o va tras `--`, o va como valor de un flag (`-m`, `-b`, `--reason`, `-F -`).
3. Rutas: `safe_join` (`path_guard.rs:28-58`) rechaza `..`, NUL, rutas absolutas fuera de la raíz y resuelve symlinks canonizando el ancestro existente; tests de symlink y traversal incluidos. `open_repo_root` canoniza y confirma con `rev-parse --show-toplevel` (`7-24`). `rel_inside` rechaza `.git` en `read_file`/`write_file`/`show_file`/blobs/`ignore_pattern`/`clean_untracked`/`open_in_editor` (`ext_a.rs:264-276`); `write_file` revalida el padre tras `create_dir_all` (`920-928`).
4. Remotos y clonado: `validate_url` (`arg_guard.rs:79-93`) y `validate_git_url` (`ext_b.rs:278-308`) bloquean `-`, `::` (ext/fd), caracteres de control, y `ssh://-oProxyCommand`, `git@-host:`; `clone` y `submodule add/update` fuerzan `-c protocol.ext.allow=never` (`ext_a.rs:367`, `ext_b.rs:395,430`) y usan `--` antes de URL y destino. El `protocol.file.allow=always` solo se añade en `submodule add` para URLs locales escritas por el usuario (`ext_b.rs:397-399`).
5. Configuración: `set_repo_config` solo acepta 23 claves de lista blanca, ninguna ejecuta programas (`arg_guard.rs:112-136`; hay test explícito de que `core.sshCommand` y `core.editor` se rechazan, `ext_a.rs:1700`), valores de una línea, `gpg.format` validado, y usa `--local --`. `get_repo_config` es solo lectura.
6. Apertura externa por lista blanca: editores identificados por clave fija (`ext_a.rs:1128-1137`), terminal y gestor de archivos con ruta canonizada; `open -t` en macOS y `notepad.exe` en Windows abren como texto. Sin interpolación en cadenas de shell.
7. Parches: `apply_patch` usa `git apply` por stdin sin `--unsafe-paths`, de modo que git rechaza rutas fuera del repo, `.git/` y symlinks traversales; `apply_hunk`/`apply_lines` reconstruyen el parche desde el diff real, no desde texto del usuario.
8. Tauri: sin plugins `shell`, `fs`, `opener`, `http`; capability mínima por ventana (`capabilities/default.json`); sin `assetProtocol`; sin `withGlobalTauri`; `tauri = { features = [] }` en `Cargo.toml` ⇒ sin devtools en release; las llamadas al actualizador pasan por comandos propios (`updater.rs`), y el plugin JS del actualizador no tiene permiso.
9. Frontend: sin `dangerouslySetInnerHTML`, `eval`, `new Function`, `document.write`, `window.open`, `<iframe>`, `href=` ni markdown (grep en todo `src/`). Mensajes de commit, ramas, nombres de archivo, notas de actualización y diffs se renderizan como texto de React o dentro de CodeMirror en modo solo lectura (`DiffViewer.tsx:200`, el único `innerHTML` es `= ""`). Las imágenes van por `<img src="data:...">` (`ImageDiff.tsx:24,42,83,92`) con MIME de una lista fija (`ext_a.rs:~235-245`); SVG en `<img>` no ejecuta scripts. No hay `fetch`/`XMLHttpRequest`/`WebSocket` en el frontend.
10. Actualizador: `pubkey` minisign presente en `tauri.conf.json` y coincide con `~/.tauri/caesargit.key.pub` (comparado); endpoint HTTPS (`github.com/.../releases/latest/download/latest.json`); sin `dangerousInsecureTransportProtocol`; el plugin comprueba la firma antes de instalar y por defecto solo acepta versiones mayores (sin downgrade); `installMode: passive` en Windows.
11. Secretos: la clave privada del actualizador y `apple.env` están en `~/.tauri/` con modo 600 (comprobado con `stat`; no leí su contenido); `mac-build.mjs` la lee en memoria y no la imprime; `git grep` en el árbol y `git log -S"minisign secret key"` no encuentran material de claves; CI usa `secrets.*`.
12. Dependencias: `npm audit --omit=dev` → 0 vulnerabilidades. `cargo audit` (hay `cargo-audit 0.23.0` instalado, base RustSec de 1568 avisos, 508 crates) → 0 vulnerabilidades, 3 avisos permitidos: `chrono 0.4.45` sin mantenimiento (RUSTSEC-2026-0543), `proc-macro-error 1.0.4` sin mantenimiento (RUSTSEC-2024-0370), `glib 0.18.5` unsound (RUSTSEC-2024-0429, parche en ≥ 0.20; arrastrado por GTK de Tauri solo en Linux). Las dependencias directas son mínimas y de uso común (tauri 2.12.7, tauri-plugin-dialog 2.8.4, tauri-plugin-updater 2.14.1, tokio, notify, serde, regex, once_cell, tempfile, thiserror); nada sospechoso en `Cargo.toml` ni `package.json` (no revisé los ~500 crates transitivos uno a uno).
13. Registro de actividad: solo en memoria (tope 500), sin persistir; sustituye la ruta del repo por `<repo>`, enmascara credenciales de URL en el caso `user:pass@` (con las salvedades de B-03), recorta a 500/2000 caracteres.
14. Workflow de release: macOS se firma y notariza en local, el borrador de Release se publica solo cuando llega `mac-platforms.json`; el job `publish` valida que existan `darwin-aarch64` y `darwin-x86_64` antes de fusionar `latest.json`; `scripts/*.mjs` usan `execFileSync/spawnSync` sin shell y validan que el tag coincida con la versión.

## 4. Repos no confiables: resumen de qué ocurre

| Vector | ¿Se ejecuta con la app actual? | Referencia |
|---|---|---|
| `.git/config` entregado con la carpeta (`core.fsmonitor`, `core.sshCommand`, `credential.helper`, `textconv`, filtros, alias) | Sí, al abrir (status) o al usar la función correspondiente | H-01, B-06 |
| `.git/hooks/*` entregados con la carpeta | Sí, en commit/checkout/merge/rebase/push | H-01 |
| `core.hooksPath` a otra carpeta | Sí; además `write_hook` escribe ahí | B-02 |
| `difftool.<x>.cmd` en la config local | Sí, al pulsar abrir difftool/mergetool | M-05 |
| `commit.template` apuntando a `~/...` | Lee y muestra el archivo | M-04 |
| Carpeta `X.app` dentro del repo | Se ejecuta con «Mostrar en Finder» | M-01 |
| Archivo con nombre `:(glob)**` o `*` | «Descartar» afecta a más archivos | M-02 |
| Clon de un remoto malicioso (sin carpeta `.git` previa) | No hay config ni hooks; los riesgos son los de git (versión) | B-04 |
| `.gitmodules` con URLs `ext::` o `file://` | `ext` bloqueado (`protocol.ext.allow=never` en clone y submodule update); `file` en submódulos lo bloquea git por defecto | `ext_a.rs:367`, `ext_b.rs:430` |
| `.gitattributes` con `filter=`/`diff=` | Solo ejecuta si la config define el comando; sin config local no hay ejecución | H-01 |
| Symlinks dentro del repo apuntando fuera | Las rutas se canonizan; leer/escribir fuera del repo se rechaza | `path_guard.rs:28-58` |

## 5. Lo que NO pude verificar

- Comportamiento en Windows y Linux (no probé en esas plataformas): resolución de ejecutables, `.cmd` de editores, `wt.exe`, `xdg-open`, empaquetado AppImage/NSIS, firma de Windows.
- Ejecución real de los exploits descritos: los hallazgos H-01, M-01, M-02 y M-05 son por análisis de código y comportamiento conocido de git/macOS; no los reproduje.
- Que el hook de updater de Tauri 2.14.1 rechace de verdad firmas inválidas y downgrades (confío en la documentación y en el código del plugin, no lo auditué).
- `git` instalado en los equipos de los usuarios (versión, configuración global, helpers de credenciales). La app delega toda autenticación en git/ssh/credential helper del sistema y no almacena credenciales, lo cual es bueno, pero su seguridad es la del git del usuario.
- Los ~500 crates transitivos y sus `build.rs`; los archivos `ext_a.rs`/`ext_b.rs` los leí en las partes que manejan argumentos, rutas, procesos y archivos, no línea por línea las partes puramente de parseo (`parsers.rs`, `graph_engine.rs`, `models.rs`, `conflict.rs`, `patcher.rs`).
- Ajustes de GitHub (protección de rama/tags, 2FA, visibilidad de secretos) y estado de `~/.tauri/caesargit.key` (si tiene contraseña).
- Frontend: revisé por búsqueda dirigida (sinks de HTML, navegación, red, almacenamiento), no leí cada componente.

## 6. Riesgo residual

Nadie puede garantizar un «100 % seguro». Aun aplicando todo lo anterior queda:

- Una app que invoca `git` hereda la superficie de ataque de git y de sus programas auxiliares (ssh, gpg, git-lfs, credential helpers): la defensa es mantener git al día y no abrir repos no confiables sin la comprobación de H-01.
- Cualquier XSS o dependencia comprometida de npm daría al atacante, con la configuración actual, capacidad de leer/escribir cualquier repo y plantar hooks (B-08). La CSP y la ausencia de sinks reducen mucho la probabilidad, no la eliminan.
- La clave de firma del actualizador es el activo crítico: quien la obtenga puede distribuir código a todos los usuarios. Está protegida solo por permisos de archivo (600) en el Mac y por un secreto de GitHub Actions; convendría una contraseña fuerte, copia de seguridad offline y fijar por SHA la acción que la recibe (B-09).
- Los usuarios de Windows reciben un instalador posiblemente sin firma de código (I-06).

## 7. Orden de arreglo sugerido

1. H-01 + M-05: `-c core.fsmonitor=false` ya, y aviso de confianza por repo (el que más reduce riesgo).
2. M-02: `GIT_LITERAL_PATHSPECS=1` (una línea).
3. M-01: usar `open -R` para rutas dentro del repo.
4. M-03: limitar o desactivar el snapshot de archivos sin seguimiento en el undo.
5. M-04, B-01, B-02: reducir lecturas/escrituras fuera de los límites esperados.
6. B-03, B-06: mejorar el enmascarado de credenciales y añadir `--no-textconv`.
7. B-09, I-07: fijar acciones por SHA, `.gitignore` de secretos, `--keychain-profile` para notarizar.
8. B-08: manifiesto de permisos de la app (cuando haya tiempo).

---

## Estado tras los arreglos (2026-11-26)

**Arreglado** (cada punto lleva test de regresión en `cargo test`, 80 en total, salvo donde se indica):

| Id | Qué se hizo |
|---|---|
| H-01 | `-c core.fsmonitor=false` en todas las llamadas a git (reproducido: sin el flag, un repo ajeno ejecutaba código al abrirlo). |
| M-01 | «Mostrar en Finder» usa `open -R` dentro del repo: una carpeta `X.app` ya no se ejecuta. |
| M-02 | `GIT_LITERAL_PATHSPECS=1` solo en «Descartar». No es global porque rompe `git stash -u`. |
| M-03 | Los snapshots de undo escriben en un directorio temporal, no en `.git/objects` (verificado en ejecución). |
| M-04 | `commit.template`: lista de rutas y nombres permitidos; se rechazan `.npmrc`, `.env*`, claves… |
| M-05 | difftool/mergetool: solo herramientas integradas o del config global; el `.cmd` del repo se ignora. |
| B-01 a B-07, I-01, I-08 | `.git` rechazado en rutas de conflicto, `core.hooksPath` y symlinks en hooks, enmascarado de credenciales, versión mínima de git (`check_git_version`), timeouts y tope de salida, `--no-textconv`/`--no-ext-diff`, rutas externas canonizadas, entorno `GIT_*` limpio. I-01 (Windows) sin test. |
| B-08 | ACL por comando: 149 comandos en `build.rs` y `capabilities/default.json`; `scripts/check-acl.mjs` falla si falta alguno. |
| B-09, I-07 | Acciones de CI fijadas por SHA (verificados con `gh api`), permisos mínimos, notarización con `--keychain-profile`, `.gitignore` de secretos. |
| I-04 | CSP con `object-src 'none'; base-uri 'none'; form-action 'none'`. |

**Comprobado**: `tsc`, `npm run build`, `cargo clippy --all-targets` (sin avisos), `cargo test` (80/80), `npm audit` (0), y en la app real (macOS): abrir repo, detalle de commit, cherry-pick, undo/redo, stash/pop, merge con conflicto, resolutor de tres paneles, continuar merge, abort, rebase interactivo.

**Sigue abierto / no verificado**:
- `cargo audit`: 3 avisos transitivos (`chrono`, `proc-macro-error`, `glib 0.18` solo Linux).
- Windows y Linux sin probar (rutas, `.cmd` de editores, firma del instalador de Windows).
- Hooks, difftool/mergetool, blame y plantillas solo por tests unitarios, no en la UI.
- `check_git_version` existe pero el frontend aún no muestra el aviso.
- `freezePrototype` sin activar (no probado); `GIT_SSH_COMMAND` con `BatchMode` sin añadir (pisaría el `core.sshCommand` del usuario).
- Una URL con credenciales sigue visible con `ps` mientras corre git.
- El directorio temporal de undo contiene, comprimidos, los archivos sin seguimiento mientras dure la entrada, y no se borra si la app se cierra de golpe.
- La notarización por keychain profile no se ha ejecutado de verdad; la primera vez pedirá la contraseña.
- Ventana TOCTOU mínima entre validar y escribir rutas.
- No es una garantía de «100 % seguro»: es una revisión estática más pruebas; no hay pentest dinámico.
