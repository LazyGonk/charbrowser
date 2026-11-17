use crate::bulk_edit::{
    apply_plan, capabilities, default_registry, plan_request, BulkApplyResult, BulkCapabilityResponse,
    BulkPlan, BulkPlanRequest, FileJournal, FsWriter,
};
use std::path::PathBuf;
use tauri::Manager;

/// Returns the capability matrix for the selected files.
///
/// Derives support from the registered format writers, so the UI never guesses
/// which files an operation can touch.
#[tauri::command(async)]
pub fn get_bulk_edit_capabilities(paths: Vec<String>) -> Result<BulkCapabilityResponse, String> {
    capabilities(&paths, &default_registry())
}

/// Plans one bulk-edit batch without touching the filesystem.
#[tauri::command(async)]
pub fn plan_bulk_edit(request: BulkPlanRequest) -> Result<BulkPlan, String> {
    let registry = default_registry();
    plan_request(&request, &registry)
}

/// Replays one reviewed plan and returns per-file results.
///
/// The audit journal lives at `<app data dir>/bulk-edit-journal.jsonl`.
#[tauri::command(async)]
pub fn apply_bulk_edit(app: tauri::AppHandle, plan: BulkPlan) -> Result<BulkApplyResult, String> {
    let registry = default_registry();
    let journal_path = resolve_journal_path(&app)?;
    let mut journal = FileJournal::new(journal_path);

    apply_plan(&plan, &registry, &FsWriter, &mut journal)
}

/// Resolves the append-only bulk-edit journal file inside the app data dir.
pub fn resolve_journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    app_data_dir.push("bulk-edit-journal.jsonl");
    Ok(app_data_dir)
}
