use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Actualizador no disponible: {e}"))?;
    let found = updater
        .check()
        .await
        .map_err(|e| format!("No se pudo comprobar si hay actualizaciones: {e}"))?;
    Ok(found.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Descarga e instala la última versión (emite `update-progress`) y reinicia.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Actualizador no disponible: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("No se pudo comprobar si hay actualizaciones: {e}"))?
        .ok_or_else(|| "Ya tienes la última versión.".to_string())?;

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    "update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("No se pudo instalar la actualización: {e}"))?;

    app.restart()
}
