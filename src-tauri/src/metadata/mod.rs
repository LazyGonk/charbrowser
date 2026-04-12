use id3::TagLike;
use std::fs;
use std::collections::HashMap;
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

/// Routes thumbnail generation to the format-specific handler.
/// FITS files use a dedicated arcsinh-stretched renderer; all other image
/// formats are handled by the image crate via `image::generate_thumbnail`.
pub fn generate_thumbnail(file_path: &str, max_size: u32) -> Result<String, String> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "fits" | "fit" => fits::generate_fits_thumbnail(file_path, max_size),
        _ => image::generate_thumbnail(file_path, max_size),
    }
}

pub use audio::{generate_audio_cover, get_audio_data_url};
pub use video::get_video_data_url;
pub use embedded::{
    create_png_character_card,
    file_has_embedded_json,
    list_embedded_base64_json_entries,
    list_text_entries,
    update_embedded_base64_json,
    upsert_png_character_card,
};

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SOI_FF_D8_FF: [u8; 3] = [0xFF, 0xD8, 0xFF];
const GIF87A_SIGNATURE: [u8; 6] = *b"GIF87a";
const GIF89A_SIGNATURE: [u8; 6] = *b"GIF89a";
const RIFF_SIGNATURE: [u8; 4] = *b"RIFF";
const WEBP_SIGNATURE: [u8; 4] = *b"WEBP";
const WAVE_SIGNATURE: [u8; 4] = *b"WAVE";
const BMP_SIGNATURE: [u8; 2] = *b"BM";
const MP4_FTYP_SIGNATURE: [u8; 4] = *b"ftyp";
const OGG_SIGNATURE: [u8; 4] = [0x4F, 0x67, 0x67, 0x53];
const FLAC_SIGNATURE: [u8; 4] = *b"fLaC";
const FITS_SIGNATURE: [u8; 9] = *b"SIMPLE  =";
const TIFF_LE_SIGNATURE: [u8; 4] = [0x49, 0x49, 0x2A, 0x00];
const TIFF_BE_SIGNATURE: [u8; 4] = [0x4D, 0x4D, 0x00, 0x2A];
const MP3_FRAME_SYNC_FB: [u8; 2] = [0xFF, 0xFB];
const MP3_FRAME_SYNC_F3: [u8; 2] = [0xFF, 0xF3];
const MP3_FRAME_SYNC_F2: [u8; 2] = [0xFF, 0xF2];

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn display_file_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Detects broad media type by inspecting well-known file signatures.
pub fn detect_file_type_by_magic_bytes(path: &Path) -> Option<&'static str> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 4 {
        return None;
    }

    // PNG
    if bytes.starts_with(&PNG_SIGNATURE) {
        return Some("image");
    }
    // JPEG
    if bytes.starts_with(&JPEG_SOI_FF_D8_FF) {
        return Some("image");
    }
    // GIF
    if bytes.starts_with(&GIF89A_SIGNATURE) || bytes.starts_with(&GIF87A_SIGNATURE) {
        return Some("image");
    }
    // WebP
    if bytes.len() >= 12 && bytes[0..4] == RIFF_SIGNATURE && bytes[8..12] == WEBP_SIGNATURE {
        return Some("image");
    }
    // BMP
    if bytes.starts_with(&BMP_SIGNATURE) {
        return Some("image");
    }
    // MP4
    if bytes.len() >= 12 && bytes[4..8] == MP4_FTYP_SIGNATURE {
        return Some("video");
    }
    // MP3
    if bytes.starts_with(&MP3_FRAME_SYNC_FB)
        || bytes.starts_with(&MP3_FRAME_SYNC_F3)
        || bytes.starts_with(&MP3_FRAME_SYNC_F2)
    {
        return Some("audio");
    }
    // OGG
    if bytes.starts_with(&OGG_SIGNATURE) {
        return Some("audio");
    }
    // FLAC
    if bytes.starts_with(&FLAC_SIGNATURE) {
        return Some("audio");
    }
    // WAV
    if bytes.len() >= 12 && bytes[0..4] == RIFF_SIGNATURE && bytes[8..12] == WAVE_SIGNATURE {
        return Some("audio");
    }
    // FITS
    if bytes.starts_with(&FITS_SIGNATURE) {
        return Some("fits");
    }
    // TIFF (little-endian II and big-endian MM variants).
    // Detected after other formats because TIFF-based camera RAW files share
    // these magic bytes — they all fall through to image extraction.
    if bytes.starts_with(&TIFF_LE_SIGNATURE) || bytes.starts_with(&TIFF_BE_SIGNATURE)
    {
        return Some("image");
    }

    None
}

/// Extracts full metadata payload for a single media file.
pub fn extract_metadata(path: &Path) -> Result<FileMetadata, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_name = display_file_name(path);
    let file_path = display_file_path(path);
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
        // Standard image formats
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" => "image",
        // TIFF and TIFF-based camera RAW formats (all decoded via the image crate tiff feature)
        "tif" | "tiff" | "nef" | "arw" | "orf" | "pef" | "rw2" | "dng" => "image",
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

/// Updates editable metadata fields for supported formats.
///
/// Current write support is intentionally limited to formats that can be
/// updated safely with existing dependencies:
/// - FITS header cards (in-place updates)
/// - MP3 ID3 tags
/// - FLAC Vorbis comments
///
/// EXIF (JPEG/TIFF/WebP) and OGG writes are deferred to avoid heavier
/// dependencies or risky container-level rewrites in this phase.
pub fn update_format_metadata_fields(
    file_path: &str,
    updates: &HashMap<String, String>,
) -> Result<usize, String> {
    if updates.is_empty() {
        return Err("No metadata updates provided.".to_string());
    }

    let path = Path::new(file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "fits" | "fit" => fits::update_fits_header_fields(path, updates),
        "mp3" => audio::update_mp3_metadata_fields(path, updates),
        "flac" => audio::update_flac_vorbis_fields(path, updates),
        "ogg" => Err("OGG metadata writing is deferred: safe page rewrite support is not yet implemented.".to_string()),
        "jpg" | "jpeg" | "tif" | "tiff" | "webp" => {
            Err("EXIF metadata writing is deferred: current EXIF dependency is read-only.".to_string())
        }
        _ => Err(format!("Metadata editing is not supported for .{} files.", extension)),
    }
}

/// Extracts lightweight metadata used for folder filtering and sorting.
pub fn extract_filter_info(path: &Path, include_exif: bool) -> Result<FileFilterInfo, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_name = display_file_name(path);
    let file_path = display_file_path(path);
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

    // TIFF and TIFF-based camera RAW formats are handled alongside standard images.
    // image::image_dimensions works for TIFF once the "tiff" feature is enabled.
    let file_kind = if matches!(extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "fits" | "fit" |
        "tif" | "tiff" | "nef" | "arw" | "orf" | "pef" | "rw2" | "dng"
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_temp_file(suffix: &str, bytes: &[u8]) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("charbrowser-magic-{}-{}", nanos, suffix));
        fs::write(&path, bytes).expect("temp file write should succeed");
        path
    }

    #[test]
    fn detects_png_jpeg_and_gif_as_image() {
        let png = write_temp_file(".png", &[137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
        let jpg = write_temp_file(".jpg", &[0xFF, 0xD8, 0xFF, 0xEE, 0, 0]);
        let gif = write_temp_file(".gif", b"GIF89a1234");

        assert_eq!(detect_file_type_by_magic_bytes(&png), Some("image"));
        assert_eq!(detect_file_type_by_magic_bytes(&jpg), Some("image"));
        assert_eq!(detect_file_type_by_magic_bytes(&gif), Some("image"));

        let _ = fs::remove_file(png);
        let _ = fs::remove_file(jpg);
        let _ = fs::remove_file(gif);
    }

    #[test]
    fn detects_audio_video_and_fits_signatures() {
        let mp4 = write_temp_file(".mp4", b"\x00\x00\x00\x18ftypisom");
        let mp3 = write_temp_file(".mp3", &[0xFF, 0xFB, 0x90, 0x64]);
        let flac = write_temp_file(".flac", b"fLaC\x00\x00\x00\x00");
        let fits = write_temp_file(".fits", b"SIMPLE  = T");

        assert_eq!(detect_file_type_by_magic_bytes(&mp4), Some("video"));
        assert_eq!(detect_file_type_by_magic_bytes(&mp3), Some("audio"));
        assert_eq!(detect_file_type_by_magic_bytes(&flac), Some("audio"));
        assert_eq!(detect_file_type_by_magic_bytes(&fits), Some("fits"));

        let _ = fs::remove_file(mp4);
        let _ = fs::remove_file(mp3);
        let _ = fs::remove_file(flac);
        let _ = fs::remove_file(fits);
    }

    #[test]
    fn returns_none_for_unknown_or_too_small_files() {
        let tiny = write_temp_file(".bin", &[1, 2, 3]);
        let random = write_temp_file(".bin", &[1, 2, 3, 4, 5, 6, 7, 8]);

        assert_eq!(detect_file_type_by_magic_bytes(&tiny), None);
        assert_eq!(detect_file_type_by_magic_bytes(&random), None);

        let _ = fs::remove_file(tiny);
        let _ = fs::remove_file(random);
    }
}
