use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct IterationHistoryStore {
    #[serde(default)]
    pub sessions: HashMap<String, HashMap<String, Vec<String>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppDataStore {
    #[serde(default)]
    pub settings: serde_json::Value,
    #[serde(default)]
    pub llm_history: IterationHistoryStore,
}

impl Default for AppDataStore {
    fn default() -> Self {
        Self {
            settings: serde_json::json!({}),
            llm_history: IterationHistoryStore::default(),
        }
    }
}

/// Resolves the persistent JSON path for all application data.
pub fn resolve_app_data_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    app_data_dir.push("app_data.json");
    Ok(app_data_dir)
}

/// Loads the application data store from disk.
pub fn load_store(app: &tauri::AppHandle) -> Result<AppDataStore, String> {
    let path = resolve_app_data_path(app)?;

    if !path.exists() {
        return Ok(AppDataStore::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read app data: {}", e))?;

    match serde_json::from_str::<AppDataStore>(&raw) {
        Ok(store) => Ok(store),
        Err(parse_error) => {
            let backup_path = path.with_extension("json.corrupt");
            let _ = fs::rename(&path, &backup_path);
            Err(format!(
                "Failed to parse app data (backup: {}): {}",
                backup_path.to_string_lossy(),
                parse_error
            ))
        }
    }
}

/// Persists the application data store to disk.
pub fn save_store(app: &tauri::AppHandle, store: &AppDataStore) -> Result<(), String> {
    let path = resolve_app_data_path(app)?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize app data: {}", e))?;

    fs::write(path, json).map_err(|e| format!("Failed to write app data: {}", e))
}

/// Returns persisted frontend settings JSON.
#[tauri::command]
pub fn get_app_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let store = load_store(&app)?;
    Ok(store.settings)
}

/// Saves frontend settings JSON inside the unified app data store.
#[tauri::command]
pub fn save_app_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings payload must be a JSON object.".to_string());
    }

    let mut store = load_store(&app).unwrap_or_default();
    store.settings = settings;
    save_store(&app, &store)
}

/// Returns the absolute path to the unified app data JSON file.
#[tauri::command]
pub fn get_app_data_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = resolve_app_data_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}
