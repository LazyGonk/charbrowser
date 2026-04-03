use id3::TagLike;
use std::fs;
use std::path::Path;

pub mod types;
pub mod utils;
pub mod image;
pub mod audio;
pub mod video;
pub mod fits;

use fits::extract_fits_metadata;
pub mod embedded;

pub use types::{EmbeddedJsonEntry, FileFilterInfo, FileMetadata, TextEntry};

pub use image::generate_thumbnail;
pub use audio::{generate_audio_cover, get_audio_data_url};
pub use video::get_video_data_url;
pub use embedded::{file_has_embedded_json, list_embedded_base64_json_entries, list_text_entries, update_embedded_base64_json};

fn detect_file_type_by_magic_bytes(path: &Path) -> Option<&'static str> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 4 {
        return None;
    }

    // PNG
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image");
    }
    // JPEG
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image");
    }
    // GIF
    if bytes.starts_with(b"GIF89a") || bytes.starts_with(b"GIF87a") {
        return Some("image");
    }
    // WebP
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image");
    }
    // BMP
    if bytes.starts_with(b"BM") {
        return Some("image");
    }
    // MP4
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("video");
    }
    // MP3
    if bytes.starts_with(&[0xFF, 0xFB]) || bytes.starts_with(&[0xFF, 0xF3]) || bytes.starts_with(&[0xFF, 0xF2]) {
        return Some("audio");
    }
    // OGG
    if bytes.starts_with(&[0x4F, 0x67, 0x67, 0x53]) {
        return Some("audio");
    }
    // FLAC
    if bytes.starts_with(b"fLaC") {
        return Some("audio");
    }
    // WAV
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("audio");
    }
    // FITS
    if bytes.starts_with(b"SIMPLE  =") {
        return Some("fits");
    }

    None
}

pub fn extract_metadata(path: &Path) -> Result<FileMetadata, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let file_path = path.to_str().unwrap_or("Unknown").to_string();
    let file_size = metadata.len();
    let modified_timestamp = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Try magic byte detection first for more reliable type detection
    let detected_type = detect_file_type_by_magic_bytes(path);

    let file_type = detected_type.unwrap_or_else(|| match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" => "image",
        "mp4" | "mov" | "avi" | "mkv" => "video", 
        "mp3" | "m4a" => "audio",
        "ogg" => "audio",
        "flac" => "audio",
        "wav" => "audio",
        "fits" | "fit" => "fits",
        _ => "unknown",
    });

    match file_type {
        "image" => {
            match image::extract_image_metadata(path, file_name.clone(), file_path.clone(), file_size, modified_timestamp) {
                Ok(metadata) => Ok(metadata),
                Err(_) => {
                    // If image processing fails, treat as unknown type (may have embedded JSON/text)
                    Ok(FileMetadata {
                        file_name,
                        file_path,
                        file_size,
                        modified_timestamp,
                        file_type: "Unknown".to_string(),
                        width: None,
                        height: None,
                        duration: None,
                        bit_rate: None,
                        sample_rate: None,
                        channels: None,
                        format_specific: serde_json::json!({}),
                    })
                }
            }
        }
        "video" => {
            video::extract_video_metadata(path, file_name, file_path, file_size, modified_timestamp)
        }
        "audio" => match extension.as_str() {
            "mp3" | "m4a" => audio::extract_audio_metadata(path, file_name, file_path, file_size, modified_timestamp),
            "ogg" => audio::extract_ogg_metadata(path, file_name, file_path, file_size, modified_timestamp),
            "flac" => audio::extract_flac_metadata(path, file_name, file_path, file_size, modified_timestamp),
            "wav" => audio::extract_wav_metadata(path, file_name, file_path, file_size, modified_timestamp),
            _ => audio::extract_audio_metadata(path, file_name, file_path, file_size, modified_timestamp),
        },
        "fits" => extract_fits_metadata(path, file_name, file_path, file_size, modified_timestamp),
        _ => {
            // Try image extraction as fallback for unknown types
            if let Ok(metadata) = image::extract_image_metadata(path, file_name.clone(), file_path.clone(), file_size, modified_timestamp) {
                Ok(metadata)
            } else {
                Ok(FileMetadata {
                    file_name,
                    file_path,
                    file_size,
                    modified_timestamp,
                    file_type: "Unknown".to_string(),
                    width: None,
                    height: None,
                    duration: None,
                    bit_rate: None,
                    sample_rate: None,
                    channels: None,
                    format_specific: serde_json::json!({}),
                })
            }
        }
    }
}

pub fn extract_filter_info(path: &Path, include_exif: bool) -> Result<FileFilterInfo, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let file_path = path.to_str().unwrap_or("Unknown").to_string();
    let file_size = metadata.len();
    let modified_timestamp = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut width = None;
    let mut height = None;
    let mut duration = None;
    let mut has_exif = None;
    let mut search_parts = vec![file_name.clone(), file_path.clone()];

    let file_kind = if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "fits" | "fit") {
        if let Ok((w, h)) = ::image::image_dimensions(path) {
            width = Some(w);
            height = Some(h);
            search_parts.push(format!("{}x{}", w, h));
        }

        if include_exif {
            let exif = image::extract_exif_metadata(path).is_some();
            has_exif = Some(exif);
            search_parts.push(if exif { "exif" } else { "no_exif" }.to_string());
        }
        "image".to_string()
    } else if matches!(extension.as_str(), "mp4" | "mov" | "avi" | "mkv") {
        "video".to_string()
    } else if matches!(extension.as_str(), "mp3" | "wav" | "flac" | "ogg" | "m4a") {
        if extension == "mp3" {
            if let Ok(tag) = id3::Tag::read_from_path(path) {
                if let Some(v) = tag.title() {
                    search_parts.push(v.to_string());
                }
                if let Some(v) = tag.artist() {
                    search_parts.push(v.to_string());
                }
                if let Some(v) = tag.album() {
                    search_parts.push(v.to_string());
                }
                if let Some(v) = tag.genre() {
                    search_parts.push(v.to_string());
                }
                if let Some(v) = tag.duration() {
                    duration = Some(v as f64 / 1000.0);
                    search_parts.push(v.to_string());
                }
            }
        }
        "audio".to_string()
    } else {
        "other".to_string()
    };

    search_parts.push(file_kind.clone());
    search_parts.push(extension);

    Ok(FileFilterInfo {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_kind,
        width,
        height,
        duration,
        has_exif,
        search_text: search_parts.join(" ").to_lowercase(),
    })
}
