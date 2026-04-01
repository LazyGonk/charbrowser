// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod metadata;

use metadata::{extract_filter_info, extract_metadata, FileFilterInfo, FileMetadata};
use std::path::Path;

#[tauri::command]
fn get_file_metadata(file_path: String) -> Result<FileMetadata, String> {
    let path = Path::new(&file_path);
    extract_metadata(path)
}

#[tauri::command]
fn get_file_filter_info(file_path: String, include_exif: bool) -> Result<FileFilterInfo, String> {
    let path = Path::new(&file_path);
    extract_filter_info(path, include_exif)
}

#[tauri::command]
fn has_embedded_json(file_path: String) -> Result<bool, String> {
    metadata::file_has_embedded_json(&file_path)
}

#[tauri::command]
fn get_thumbnail(file_path: String, max_size: u32) -> Result<String, String> {
    metadata::generate_thumbnail(&file_path, max_size)
}

#[tauri::command]
fn get_audio_cover(file_path: String, max_size: u32) -> Result<String, String> {
    metadata::generate_audio_cover(&file_path, max_size)
}

#[tauri::command]
fn get_video_data_url(file_path: String, max_bytes: u32) -> Result<String, String> {
    metadata::get_video_data_url(&file_path, max_bytes as usize)
}

#[tauri::command]
fn get_embedded_base64_json_entries(file_path: String) -> Result<Vec<metadata::EmbeddedJsonEntry>, String> {
    metadata::list_embedded_base64_json_entries(&file_path)
}

#[tauri::command]
fn update_embedded_base64_json(file_path: String, entry_id: usize, json_text: String) -> Result<(), String> {
    metadata::update_embedded_base64_json(&file_path, entry_id, &json_text)
}

#[tauri::command]
fn list_directory_files(dir_path: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir_path);
    
    if !path.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut files = Vec::new();
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    let ext = ext.to_string_lossy().to_lowercase();
                    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" 
                                | "mp4" | "mov" | "avi" | "mkv" 
                                | "mp3" | "wav" | "flac" | "ogg" | "m4a") {
                        if let Some(path_str) = path.to_str() {
                            files.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
fn open_url_in_system_browser(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    webbrowser::open(trimmed)
        .map(|_| ())
        .map_err(|e| format!("Failed to open URL: {}", e))
}

#[tauri::command]
fn open_legal_document_in_system_browser(doc_id: String) -> Result<(), String> {
    let (title, body) = match doc_id.as_str() {
        "license" => ("MIT License", include_str!("../../LICENSE")),
        "notices" => ("Third-Party Notices", include_str!("../../THIRD_PARTY_NOTICES.md")),
        _ => return Err("Unknown legal document".to_string()),
    };

    let mut temp_path = std::env::temp_dir();
    temp_path.push(format!("charbrowser-{}.html", doc_id));

    let escaped = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font-family:Consolas,Monaco,monospace;background:#15161a;color:#d5d9e0;margin:0;padding:20px}}pre{{white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:13px;background:#1f2127;border:1px solid #2f3440;border-radius:8px;padding:16px}}</style></head><body><pre>{}</pre></body></html>",
        title,
        escaped
    );

    std::fs::write(&temp_path, html)
        .map_err(|e| format!("Failed to write temp document: {}", e))?;

    let file_url = format!("file:///{}", temp_path.to_string_lossy().replace('\\', "/"));
    webbrowser::open(&file_url)
        .map(|_| ())
        .map_err(|e| format!("Failed to open legal document: {}", e))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_file_metadata,
            get_file_filter_info,
            get_thumbnail,
            get_audio_cover,
            get_video_data_url,
            has_embedded_json,
            get_embedded_base64_json_entries,
            update_embedded_base64_json,
            list_directory_files,
            open_url_in_system_browser,
            open_legal_document_in_system_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
