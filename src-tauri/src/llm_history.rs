use crate::app_data;

pub fn clear_all_llm_iteration_history(app: &tauri::AppHandle) -> Result<(), String> {
    let mut store = app_data::load_store(app).unwrap_or_default();
    if store.llm_history.sessions.is_empty() {
        return Ok(());
    }

    store.llm_history.sessions.clear();
    app_data::save_store(app, &store)
}

#[tauri::command]
pub fn append_llm_iteration_response(
    app: tauri::AppHandle,
    session_id: String,
    target_field: String,
    response_text: String,
) -> Result<(), String> {
    let session_key = session_id.trim();
    let field_key = target_field.trim();
    let response_value = response_text.trim();

    if session_key.is_empty() {
        return Err("Session ID is required.".to_string());
    }
    if field_key.is_empty() {
        return Err("Target field is required.".to_string());
    }
    if response_value.is_empty() {
        return Ok(());
    }

    let mut store = app_data::load_store(&app).unwrap_or_default();
    let session_entry = store
        .llm_history
        .sessions
        .entry(session_key.to_string())
        .or_default();

    let field_entry = session_entry
        .entry(field_key.to_string())
        .or_default();

    field_entry.push(response_value.to_string());

    // Keep only a bounded tail to avoid unbounded growth.
    const MAX_RESPONSES_PER_FIELD: usize = 30;
    if field_entry.len() > MAX_RESPONSES_PER_FIELD {
        let keep_from = field_entry.len() - MAX_RESPONSES_PER_FIELD;
        field_entry.drain(0..keep_from);
    }

    app_data::save_store(&app, &store)
}

#[tauri::command]
pub fn get_llm_iteration_responses(
    app: tauri::AppHandle,
    session_id: String,
    target_field: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let session_key = session_id.trim();
    let field_key = target_field.trim();

    if session_key.is_empty() || field_key.is_empty() {
        return Ok(Vec::new());
    }

    let store = app_data::load_store(&app)?;
    let responses = store
        .llm_history
        .sessions
        .get(session_key)
        .and_then(|session| session.get(field_key))
        .cloned()
        .unwrap_or_default();

    if responses.is_empty() {
        return Ok(responses);
    }

    let bounded_limit = limit.unwrap_or(5).clamp(1, 20);
    let start_index = responses.len().saturating_sub(bounded_limit);
    Ok(responses[start_index..].to_vec())
}

#[tauri::command]
pub fn clear_llm_iteration_history(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let session_key = session_id.trim();
    if session_key.is_empty() {
        return Ok(());
    }

    let mut store = app_data::load_store(&app).unwrap_or_default();
    store.llm_history.sessions.remove(session_key);
    app_data::save_store(&app, &store)
}
