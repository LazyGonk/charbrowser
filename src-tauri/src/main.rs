// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_data;
mod commands;
mod llm_history;
mod metadata;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::files::get_file_metadata,
            commands::files::get_file_filter_info,
            commands::files::get_thumbnail,
            commands::files::get_audio_cover,
            commands::files::get_audio_data_url,
            commands::files::get_video_data_url,
            commands::files::get_image_data_url,
            commands::embedded::has_embedded_json,
            commands::embedded::get_embedded_base64_json_entries,
            commands::embedded::update_embedded_base64_json,
            commands::embedded::upsert_png_character_card,
            commands::embedded::create_png_character_card,
            commands::files::get_text_entries,
            commands::files::update_file_metadata_fields,
            commands::files::delete_file_to_trash,
            commands::browser::list_directory_files,
            commands::system::open_url_in_system_browser,
            commands::system::open_legal_document_in_system_browser,
            llm_history::append_llm_iteration_response,
            llm_history::get_llm_iteration_responses,
            llm_history::clear_llm_iteration_history,
            app_data::get_app_settings,
            app_data::save_app_settings,
            app_data::get_app_data_path,
            commands::llm::get_llm_models,
            commands::llm::call_llm_chat,
            commands::comfyui::comfyui_test_connection,
            commands::comfyui::comfyui_submit_prompt,
            commands::comfyui::comfyui_get_history,
            commands::comfyui::comfyui_download_image
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Application error: {}", e);
            std::process::exit(1);
        });

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Err(error) = llm_history::clear_all_llm_iteration_history(app_handle) {
                eprintln!("Failed to clear LLM iteration history on exit: {}", error);
            }
        }
    });
}
