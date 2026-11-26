# Medidas de GitKraken (v12.6.1, Dark, zoom 100 %)

Fuente: ventana de GitKraken de 3440×1331 pt. El árbol de accesibilidad y la captura salen reducidos a 1568 px de ancho,
así que **pt = px de captura × 2,194**. Precisión ≈ ±2 pt. Ronda 1: layout general. Pendiente de afinar con zoom.

## Layout general (pt)

| Elemento | Medida |
|---|---|
| Barra de pestañas (altura total) | 44; los semáforos van dentro (sin barra de título aparte) |
| Botón de pestaña | ~35 alto; la pestaña activa lleva «×» |
| Toolbar (altura) | 48, empieza justo debajo de la barra de pestañas |
| Botón de toolbar (Undo, Redo, Pull, Push, Branch, Stash, Pop, Terminal) | ~48 ancho × 46 alto (icono arriba, texto pequeño debajo) |
| Selectores «repository» y «branch» | ~110 ancho × 46 alto, a la izquierda del toolbar; el toolbar de acciones va centrado |
| Barra de estado | 28 |
| Barra lateral izquierda | ~208 ancho |
| Panel derecho (commit) | ~399 ancho |
| Fila del grafo | 28 alto (confirmada: 35 filas = 446 px captura) |
| Columna «Branch / Tag» | ~154 ancho |
| Columna «Graph» | ~116 ancho |
| Columna «Commit message» | resto del ancho |

## Estructura (de arriba abajo)

1. Pestañas de repositorio con icono de rama; la activa lleva «×» y hay un «+» al final. A la derecha: «Start a Trial», avisos y perfil.
2. Toolbar: repo y rama a la izquierda; Undo, Redo, Pull (con desplegable), Push, Branch, Stash, Pop, Terminal en el centro; Actions y Search a la derecha.
3. Barra lateral: conmutador «List / Agents», «Viewing N», filtro, secciones LOCAL, REMOTE, ISSUES, TEAMS, TAGS (con contador).
4. Grafo: cabecera «BRANCH / TAG · GRAPH · COMMIT MESSAGE»; filas con etiquetas de rama como chips de color; las fechas se muestran como marcas pequeñas a la derecha («yesterday», «2 days ago»).
5. Panel derecho: «commit: hash», botón «Explain commit», mensaje, autor y fecha, «parent», contador «N modified · N added», conmutador Path / Tree y «View all files», lista de archivos con la ruta en gris y el nombre en blanco.
6. Barra de estado: «Connect an integration», zoom (100 %), «Support», versión.

## Pendiente de medir

- Fuentes y tamaños de texto exactos, tamaño de iconos y chips de rama.
- Hover y selección de fila (la fila seleccionada va en azul).
- Paneles que se abren: diff, stash, rama.
- Menús contextuales. Con el permiso actual (GitKraken solo en modo clic) no se puede hacer clic derecho: hay que pedir permiso completo o abrirlos tú.

## Aplicado en CaesarGit (ronda 1)

- `src/index.css`: `--h-tab` 44, `--h-toolbar` 48, `--h-row` 28, `--h-status` 28.
- `src/App.tsx`: paneles por defecto 15 % / 57 % / 28 % (≈ 208 / 399 pt en ventana de 1440); `autoSaveId` cambiado a `caesargit-main-v2`.
- macOS: `titleBarStyle: Overlay` + `hiddenTitle`, 80 px de hueco para los semáforos y `data-tauri-drag-region` en la barra de pestañas.
