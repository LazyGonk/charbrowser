use crate::metadata::{extract_filter_info, extract_metadata, FileFilterInfo, FileMetadata};
use std::collections::HashMap;
use std::path::Path;

/// Extracts full metadata payload for one file.
#[tauri::command]
pub fn get_file_metadata(file_path: String) -> Result<FileMetadata, String> {
    let path = Path::new(&file_path);
    extract_metadata(path)
}

/// Extracts lightweight metadata payload used by folder filters.
#[tauri::command]
pub fn get_file_filter_info(file_path: String, include_exif: bool) -> Result<FileFilterInfo, String> {
    let path = Path::new(&file_path);
    extract_filter_info(path, include_exif)
}

/// Generates an image thumbnail data URL for supported image formats.
#[tauri::command]
pub fn get_thumbnail(file_path: String, max_size: u32) -> Result<String, String> {
    crate::metadata::generate_thumbnail(&file_path, max_size)
}

/// Extracts embedded cover art from audio files as a data URL.
#[tauri::command]
pub fn get_audio_cover(file_path: String, max_size: u32) -> Result<String, String> {
    crate::metadata::generate_audio_cover(&file_path, max_size)
}

/// Loads bounded in-memory video data for browser preview playback.
#[tauri::command]
pub fn get_video_data_url(file_path: String, max_bytes: u32) -> Result<String, String> {
    crate::metadata::get_video_data_url(&file_path, max_bytes as usize)
}

/// Loads bounded in-memory audio data for browser preview playback.
#[tauri::command]
pub fn get_audio_data_url(file_path: String, max_bytes: u32) -> Result<String, String> {
    crate::metadata::get_audio_data_url(&file_path, max_bytes as usize)
}

/// Reads image bytes and returns one data URL for card editor import.
#[tauri::command]
pub fn get_image_data_url(file_path: String) -> Result<String, String> {
    use base64::Engine;
    use std::fs;

    let path = Path::new(&file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "",
    };

    if !mime.is_empty() {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read image file: {}", e))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(format!("data:{};base64,{}", mime, encoded));
    }

    // Fallback path: decode with the image crate and return PNG data URL.
    // This keeps create-mode drag/drop resilient for formats supported by decoders.
    let image = image::open(path).map_err(|e| {
        format!(
            "Image preview not supported for extension '{}' and decode fallback failed: {}",
            ext, e
        )
    })?;

    let mut buffer = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode fallback PNG: {}", e))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer);
    Ok(format!("data:image/png;base64,{}", encoded))
}

/// Returns plaintext entries from metadata containers where supported.
#[tauri::command]
pub fn get_text_entries(file_path: String) -> Result<Vec<crate::metadata::TextEntry>, String> {
    crate::metadata::list_text_entries(&file_path)
}

/// Applies metadata updates to one file for supported writable formats.
#[tauri::command]
pub fn update_file_metadata_fields(file_path: String, updates: HashMap<String, String>) -> Result<usize, String> {
    crate::metadata::update_format_metadata_fields(&file_path, &updates)
}

/// Moves a file to the system trash/recycle bin.
/// Returns error message if operation fails (permission denied, file not found, etc).
#[tauri::command]
pub fn delete_file_to_trash(file_path: String) -> Result<(), String> {
    match trash::delete(&file_path) {
        Ok(()) => Ok(()),
        Err(e) => Err(format!("Failed to delete file: {}", e)),
    }
}
