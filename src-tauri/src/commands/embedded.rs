/// Checks whether a file contains one or more embedded JSON payloads.
#[tauri::command]
pub fn has_embedded_json(file_path: String) -> Result<bool, String> {
    crate::metadata::file_has_embedded_json(&file_path)
}

/// Lists embedded JSON entries detected in a file.
#[tauri::command]
pub fn get_embedded_base64_json_entries(
    file_path: String,
) -> Result<Vec<crate::metadata::EmbeddedJsonEntry>, String> {
    crate::metadata::list_embedded_base64_json_entries(&file_path)
}

/// Updates one embedded JSON entry by id.
#[tauri::command]
pub fn update_embedded_base64_json(
    file_path: String,
    entry_id: usize,
    json_text: String,
) -> Result<(), String> {
    crate::metadata::update_embedded_base64_json(&file_path, entry_id, &json_text)
}

/// Inserts or replaces the PNG character card payload.
#[tauri::command]
pub fn upsert_png_character_card(file_path: String, json_text: String) -> Result<(), String> {
    crate::metadata::upsert_png_character_card(&file_path, &json_text)
}

/// Creates a new PNG character card from image content and JSON payload.
#[tauri::command]
pub fn create_png_character_card(
    file_path: String,
    image_data_url: String,
    json_text: String,
) -> Result<(), String> {
    crate::metadata::create_png_character_card(&file_path, &image_data_url, &json_text)
}
