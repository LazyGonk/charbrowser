use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use image::GenericImageView;
use id3::TagLike;
use id3::frame::{Comment, Content, ExtendedText, Frame, Lyrics};
use std::str;
use std::io::{BufReader, Read};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbeddedJsonEntry {
    pub id: usize,
    pub chunk_type: String,
    pub label: String,
    pub base64: String,
    pub payload: String,
    pub payload_format: String,
    pub decoded_json: String,
}

#[derive(Clone, Copy)]
enum Base64Encoding {
    Standard,
    StandardNoPad,
    UrlSafe,
    UrlSafeNoPad,
}

struct PngChunk {
    chunk_type: [u8; 4],
    data: Vec<u8>,
}

struct EmbeddedJsonMatch {
    id: usize,
    chunk_index: usize,
    data_start: usize,
    data_end: usize,
    chunk_type: String,
    label: String,
    payload: String,
    decoded_json: serde_json::Value,
    encoding: JsonPayloadEncoding,
}

struct Mp3JsonMatch {
    id: usize,
    label: String,
    payload: String,
    decoded_json: serde_json::Value,
    encoding: JsonPayloadEncoding,
    frame_kind: Mp3FrameKind,
}

struct VideoJsonMatch {
    id: usize,
    start: usize,
    end: usize,
    label: String,
    payload: String,
    decoded_json: serde_json::Value,
    encoding: JsonPayloadEncoding,
    atom_path: Vec<usize>,
}

#[derive(Clone, Copy)]
enum Mp4AtomSizeKind {
    Fixed32(u32),
    Extended64(u64),
    ToEof,
}

struct Mp4Atom {
    start: usize,
    end: usize,
    data_start: usize,
    atom_type: [u8; 4],
    size_kind: Mp4AtomSizeKind,
    parent: Option<usize>,
}

enum Mp3FrameKind {
    Text { frame_id: String },
    ExtendedText { description: String },
    Comment { lang: String, description: String },
    Lyrics { lang: String, description: String },
}

enum JsonPayloadEncoding {
    Base64(Base64Encoding),
    PlainText,
    ZtxtCompressed,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
    pub modified_timestamp: Option<i64>,
    pub file_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub bit_rate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub format_specific: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileFilterInfo {
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
    pub modified_timestamp: Option<i64>,
    pub file_kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub has_exif: Option<bool>,
    pub search_text: String,
}

pub fn extract_metadata(path: &Path) -> Result<FileMetadata, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let file_path = path
        .to_str()
        .unwrap_or("Unknown")
        .to_string();

    let file_size = metadata.len();
    let modified_timestamp = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" => {
            extract_image_metadata(path, file_name, file_path, file_size, modified_timestamp)
        }
        "mp4" | "mov" | "avi" | "mkv" => {
            extract_video_metadata(path, file_name, file_path, file_size, modified_timestamp)
        }
        "mp3" | "flac" | "ogg" | "m4a" => {
            extract_audio_metadata(path, file_name, file_path, file_size, modified_timestamp)
        }
        "wav" => extract_wav_metadata(path, file_name, file_path, file_size, modified_timestamp),
        _ => Ok(FileMetadata {
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
        }),
    }
}

pub fn extract_filter_info(path: &Path, include_exif: bool) -> Result<FileFilterInfo, String> {
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let file_path = path
        .to_str()
        .unwrap_or("Unknown")
        .to_string();
    let file_size = metadata.len();
    let modified_timestamp = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
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

    let file_kind = if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp") {
        if let Ok((w, h)) = image::image_dimensions(path) {
            width = Some(w);
            height = Some(h);
            search_parts.push(format!("{}x{}", w, h));
        }

        if include_exif {
            let exif = extract_exif_metadata(path).is_some();
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

pub fn file_has_embedded_json(file_path: &str) -> Result<bool, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "png" {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
        let chunks = parse_png_chunks(&bytes)?;
        return png_has_embedded_json(&chunks);
    }

    if ext == "mp3" {
        let tag = id3::Tag::read_from_path(path)
            .map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
        if mp3_tag_has_embedded_json(&tag) {
            return Ok(true);
        }

        let bytes = fs::read(path).map_err(|e| format!("Failed to read MP3 file: {}", e))?;
        return mp3_raw_has_embedded_json(&bytes);
    }

    if matches!(ext.as_str(), "mp4" | "mov") {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
        return Ok(!find_mp4_embedded_json_matches(&bytes)?.is_empty());
    }

    if matches!(ext.as_str(), "avi" | "mkv") {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
        return Ok(!find_video_embedded_json_matches(&bytes)?.is_empty());
    }

    Ok(false)
}

fn extract_image_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let (width, height) = img.dimensions();
    let color_type = format!("{:?}", img.color());

    let mut format_specific = serde_json::Map::new();
    format_specific.insert("color_type".to_string(), serde_json::json!(color_type));

    if let Some(exif_data) = extract_exif_metadata(path) {
        format_specific.insert("exif".to_string(), exif_data);
    }

    // Extract PNG-specific metadata if it's a PNG
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
    {
        if let Ok(png_metadata) = extract_png_chunks(path) {
            format_specific.insert("png_chunks".to_string(), png_metadata);
        }
    }

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "Image".to_string(),
        width: Some(width),
        height: Some(height),
        duration: None,
        bit_rate: None,
        sample_rate: None,
        channels: None,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

fn extract_exif_metadata(path: &Path) -> Option<serde_json::Value> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    let mut out = serde_json::Map::new();
    for field in exif.fields() {
        let key = format!("{} ({})", field.tag, field.ifd_num);
        let value = field.display_value().with_unit(&exif).to_string();
        out.insert(key, serde_json::Value::String(value));
    }

    if out.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(out))
    }
}

fn extract_png_chunks(path: &Path) -> Result<serde_json::Value, String> {
    let file = fs::File::open(path)
        .map_err(|e| format!("Failed to open PNG file: {}", e))?;
    
    let decoder = png::Decoder::new(file);
    let reader = decoder.read_info()
        .map_err(|e| format!("Failed to read PNG info: {}", e))?;
    
    let info = reader.info();
    
    let mut chunks = serde_json::Map::new();
    chunks.insert("bit_depth".to_string(), serde_json::json!(info.bit_depth as u8));
    chunks.insert("color_type".to_string(), serde_json::json!(format!("{:?}", info.color_type)));
    chunks.insert("compression".to_string(), serde_json::json!(format!("{:?}", info.compression)));
    chunks.insert("interlaced".to_string(), serde_json::json!(format!("{:?}", info.interlaced)));
    
    Ok(serde_json::Value::Object(chunks))
}

fn extract_video_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    // Basic video metadata - in a production app, you'd want to use a proper video parsing library
    // For now, we'll return basic info with placeholder values
    let mut format_specific = serde_json::Map::new();
    format_specific.insert("codec".to_string(), serde_json::json!("Unknown"));
    format_specific.insert("container".to_string(), serde_json::json!(
        path.extension().and_then(|e| e.to_str()).unwrap_or("unknown")
    ));

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "Video".to_string(),
        width: None,
        height: None,
        duration: None,
        bit_rate: None,
        sample_rate: None,
        channels: None,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

fn extract_audio_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();

    // Try to extract ID3 tags for MP3 files
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if ext.to_lowercase() == "mp3" {
            if let Ok(tag) = id3::Tag::read_from_path(path) {
                if let Some(title) = tag.title() {
                    format_specific.insert("title".to_string(), serde_json::json!(title));
                }
                if let Some(artist) = tag.artist() {
                    format_specific.insert("artist".to_string(), serde_json::json!(artist));
                }
                if let Some(album) = tag.album() {
                    format_specific.insert("album".to_string(), serde_json::json!(album));
                }
                if let Some(year) = tag.year() {
                    format_specific.insert("year".to_string(), serde_json::json!(year));
                }
                if let Some(genre) = tag.genre() {
                    format_specific.insert("genre".to_string(), serde_json::json!(genre));
                }
                
                // Extract duration if available from the tag
                if let Some(duration) = tag.duration() {
                    return Ok(FileMetadata {
                        file_name,
                        file_path,
                        file_size,
                        modified_timestamp,
                        file_type: "Audio".to_string(),
                        width: None,
                        height: None,
                        duration: Some(duration as f64 / 1000.0),
                        bit_rate: None,
                        sample_rate: None,
                        channels: None,
                        format_specific: serde_json::Value::Object(format_specific),
                    });
                }
            }
        }
    }

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "Audio".to_string(),
        width: None,
        height: None,
        duration: None,
        bit_rate: None,
        sample_rate: None,
        channels: None,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

fn extract_wav_metadata(
    _path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();
    format_specific.insert("format".to_string(), serde_json::json!("WAV"));

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "Audio".to_string(),
        width: None,
        height: None,
        duration: None,
        bit_rate: None,
        sample_rate: None,
        channels: None,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

pub fn generate_thumbnail(file_path: &str, max_size: u32) -> Result<String, String> {
    let path = Path::new(file_path);
    
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" => {
            let img = image::open(path)
                .map_err(|e| format!("Failed to open image: {}", e))?;
            
            let thumbnail = img.thumbnail(max_size, max_size);
            
            let mut buffer = Vec::new();
            thumbnail
                .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;
            
            use base64::Engine;
            Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&buffer)))
        }
        _ => Err("Thumbnail generation not supported for this file type".to_string()),
    }
}

pub fn generate_audio_cover(file_path: &str, max_size: u32) -> Result<String, String> {
    let path = Path::new(file_path);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if extension != "mp3" {
        return Err("Embedded cover extraction is currently supported for MP3 files".to_string());
    }

    let tag = id3::Tag::read_from_path(path)
        .map_err(|e| format!("Failed to read ID3 tag: {}", e))?;

    let picture = tag
        .pictures()
        .next()
        .ok_or_else(|| "No embedded cover art found".to_string())?;

    let image = image::load_from_memory(&picture.data)
        .map_err(|e| format!("Failed to decode embedded cover art: {}", e))?;

    let thumbnail = image.thumbnail(max_size, max_size);
    let mut buffer = Vec::new();
    thumbnail
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cover thumbnail: {}", e))?;

    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buffer)
    ))
}

pub fn get_video_data_url(file_path: &str, max_bytes: usize) -> Result<String, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogg" | "ogv" => "video/ogg",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ => return Err("Video preview not supported for this extension".to_string()),
    };

    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size = metadata.len() as usize;

    if file_size == 0 {
        return Err("Video file is empty".to_string());
    }

    if file_size > max_bytes {
        return Err(format!(
            "Video is too large for in-app preview ({} MB > {} MB)",
            file_size / (1024 * 1024),
            max_bytes / (1024 * 1024)
        ));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

pub fn list_embedded_base64_json_entries(file_path: &str) -> Result<Vec<EmbeddedJsonEntry>, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "png" {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
        let chunks = parse_png_chunks(&bytes)?;
        let matches = find_embedded_json_matches(&chunks)?;

        return Ok(matches
            .into_iter()
            .map(|m| EmbeddedJsonEntry {
                id: m.id,
                chunk_type: m.chunk_type,
                label: m.label,
                base64: m.payload.clone(),
                payload: m.payload,
                payload_format: payload_format_name(&m.encoding).to_string(),
                decoded_json: serde_json::to_string_pretty(&m.decoded_json)
                    .unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    if ext == "mp3" {
        let tag = id3::Tag::read_from_path(path)
            .map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
        let mut matches = find_mp3_embedded_json_matches(&tag)?;

        // Some generators write non-standard but still readable JSON into early ID3 bytes.
        // If high-level parsing finds nothing, fall back to a raw ID3v2 scan.
        if matches.is_empty() {
            let bytes = fs::read(path).map_err(|e| format!("Failed to read MP3 file: {}", e))?;
            matches = find_mp3_json_matches_from_raw_id3(&bytes)?;
        }

        return Ok(matches
            .into_iter()
            .map(|m| EmbeddedJsonEntry {
                id: m.id,
                chunk_type: "ID3".to_string(),
                label: m.label,
                base64: m.payload.clone(),
                payload: m.payload,
                payload_format: payload_format_name(&m.encoding).to_string(),
                decoded_json: serde_json::to_string_pretty(&m.decoded_json)
                    .unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    if matches!(ext.as_str(), "mp4" | "mov") {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
        let matches = find_mp4_embedded_json_matches(&bytes)?;

        return Ok(matches
            .into_iter()
            .map(|m| EmbeddedJsonEntry {
                id: m.id,
                chunk_type: "mp4-atom".to_string(),
                label: m.label,
                base64: m.payload.clone(),
                payload: m.payload,
                payload_format: payload_format_name(&m.encoding).to_string(),
                decoded_json: serde_json::to_string_pretty(&m.decoded_json)
                    .unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    if matches!(ext.as_str(), "avi" | "mkv") {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
        let matches = find_video_embedded_json_matches(&bytes)?;

        return Ok(matches
            .into_iter()
            .map(|m| EmbeddedJsonEntry {
                id: m.id,
                chunk_type: "video-raw".to_string(),
                label: m.label,
                base64: m.payload.clone(),
                payload: m.payload,
                payload_format: payload_format_name(&m.encoding).to_string(),
                decoded_json: serde_json::to_string_pretty(&m.decoded_json)
                    .unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    Ok(Vec::new())
}

pub fn update_embedded_base64_json(
    file_path: &str,
    entry_id: usize,
    json_text: &str,
) -> Result<(), String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "png" {
        return update_png_embedded_json(path, entry_id, json_text);
    }

    if ext == "mp3" {
        return update_mp3_embedded_json(path, entry_id, json_text);
    }

    if matches!(ext.as_str(), "mp4" | "mov" | "avi" | "mkv") {
        return update_video_embedded_json(path, &ext, entry_id, json_text);
    }

    Err("Editing embedded JSON is currently supported for PNG, MP3, and common video files".to_string())
}

fn update_video_embedded_json(path: &Path, ext: &str, entry_id: usize, json_text: &str) -> Result<(), String> {
    let new_json_value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    if matches!(ext, "mp4" | "mov") {
        return update_mp4_embedded_json(path, entry_id, &new_json_compact);
    }

    let mut bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
    let matches = find_video_embedded_json_matches(&bytes)?;
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let new_payload = encode_payload_with_encoding(&new_json_compact, &target.encoding)
        .map_err(|e| format!("Failed to encode payload: {}", e))?;
    let old_len = target.end.saturating_sub(target.start);

    if new_payload.len() != old_len {
        return Err(format!(
            "Edited payload length changed (old {} bytes, new {} bytes). For video files, keep the JSON length unchanged to avoid breaking container offsets.",
            old_len,
            new_payload.len()
        ));
    }

    bytes.splice(target.start..target.end, new_payload.iter().copied());
    write_with_backup(path, &bytes)
        .map_err(|e| format!("Failed to write updated video file: {}", e))?;
    Ok(())
}

fn update_mp4_embedded_json(path: &Path, entry_id: usize, new_json_compact: &str) -> Result<(), String> {
    let mut bytes = fs::read(path).map_err(|e| format!("Failed to read MP4/MOV file: {}", e))?;
    let (atoms, matches) = find_mp4_embedded_json_matches_with_atoms(&bytes)?;
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let new_payload = encode_payload_with_encoding(new_json_compact, &target.encoding)
        .map_err(|e| format!("Failed to encode payload: {}", e))?;

    let old_len = target.end.saturating_sub(target.start);
    let delta = new_payload.len() as isize - old_len as isize;

    bytes.splice(target.start..target.end, new_payload.iter().copied());

    if delta != 0 {
        for atom_idx in target.atom_path {
            let atom = atoms
                .get(atom_idx)
                .ok_or_else(|| "Invalid MP4 atom path reference".to_string())?;
            apply_mp4_atom_size_delta(&mut bytes, atom, delta)?;
        }
    }

    write_with_backup(path, &bytes)
        .map_err(|e| format!("Failed to write updated MP4/MOV file: {}", e))?;
    Ok(())
}

fn update_png_embedded_json(path: &Path, entry_id: usize, json_text: &str) -> Result<(), String> {
    let new_json_value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mut chunks = parse_png_chunks(&bytes)?;
    let matches = find_embedded_json_matches(&chunks)?;
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let new_payload = encode_payload_with_encoding(&new_json_compact, &target.encoding)
        .map_err(|e| format!("Failed to encode payload: {}", e))?;
    let chunk = chunks
        .get_mut(target.chunk_index)
        .ok_or_else(|| "Invalid chunk reference".to_string())?;

    chunk.data.splice(
        target.data_start..target.data_end,
        new_payload.iter().copied(),
    );

    let updated_png = build_png_bytes(&chunks);
    write_with_backup(path, &updated_png)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

fn update_mp3_embedded_json(path: &Path, entry_id: usize, json_text: &str) -> Result<(), String> {
    let new_json_value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    let mut tag = id3::Tag::read_from_path(path)
        .map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
    let mut matches = find_mp3_embedded_json_matches(&tag)?;
    if matches.is_empty() {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read MP3 file: {}", e))?;
        matches = find_mp3_json_matches_from_raw_id3(&bytes)?;
    }
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let payload = String::from_utf8(
        encode_payload_with_encoding(&new_json_compact, &target.encoding)
            .map_err(|e| format!("Failed to encode payload: {}", e))?,
    )
    .map_err(|e| format!("Payload is not valid UTF-8: {}", e))?;

    let replacement = match target.frame_kind {
        Mp3FrameKind::Text { frame_id } => Frame::with_content(frame_id, Content::Text(payload)),
        Mp3FrameKind::ExtendedText { description } => Frame::with_content(
            "TXXX",
            Content::ExtendedText(ExtendedText {
                description,
                value: payload,
            }),
        ),
        Mp3FrameKind::Comment { lang, description } => Frame::with_content(
            "COMM",
            Content::Comment(Comment {
                lang,
                description,
                text: payload,
            }),
        ),
        Mp3FrameKind::Lyrics { lang, description } => Frame::with_content(
            "USLT",
            Content::Lyrics(Lyrics {
                lang,
                description,
                text: payload,
            }),
        ),
    };

    tag.add_frame(replacement);
    let backup_path = build_backup_path(path);
    fs::copy(path, &backup_path)
        .map_err(|e| format!("Failed to create backup before write: {}", e))?;

    if let Err(e) = tag.write_to_path(path, id3::Version::Id3v24) {
        let _ = fs::copy(&backup_path, path);
        let _ = fs::remove_file(&backup_path);
        return Err(format!("Failed to write ID3 tag: {}", e));
    }

    let _ = fs::remove_file(&backup_path);
    Ok(())
}

fn find_mp3_embedded_json_matches(tag: &id3::Tag) -> Result<Vec<Mp3JsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for frame in tag.frames() {
        let frame_id = frame.id().to_string();
        match frame.content() {
            Content::Text(text) => {
                if let Some((value, encoding, payload)) = decode_json_payload(text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: format!("{}", frame_id),
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::Text { frame_id },
                    });
                    next_id += 1;
                }
            }
            Content::ExtendedText(ext) => {
                if let Some((value, encoding, payload)) = decode_json_payload(&ext.value) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: if ext.description.is_empty() {
                            "TXXX".to_string()
                        } else {
                            format!("TXXX:{}", ext.description)
                        },
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::ExtendedText {
                            description: ext.description.clone(),
                        },
                    });
                    next_id += 1;
                }
            }
            Content::Comment(comment) => {
                if let Some((value, encoding, payload)) = decode_json_payload(&comment.text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: format!("COMM:{}:{}", comment.lang, comment.description),
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::Comment {
                            lang: comment.lang.clone(),
                            description: comment.description.clone(),
                        },
                    });
                    next_id += 1;
                }
            }
            Content::Lyrics(lyrics) => {
                if let Some((value, encoding, payload)) = decode_json_payload(&lyrics.text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: format!("USLT:{}:{}", lyrics.lang, lyrics.description),
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::Lyrics {
                            lang: lyrics.lang.clone(),
                            description: lyrics.description.clone(),
                        },
                    });
                    next_id += 1;
                }
            }
            _ => {}
        }
    }

    Ok(matches)
}

fn mp3_tag_has_embedded_json(tag: &id3::Tag) -> bool {
    for frame in tag.frames() {
        match frame.content() {
            Content::Text(text) => {
                if decode_json_payload(text).is_some() {
                    return true;
                }
            }
            Content::ExtendedText(ext) => {
                if decode_json_payload(&ext.value).is_some() {
                    return true;
                }
            }
            Content::Comment(comment) => {
                if decode_json_payload(&comment.text).is_some() {
                    return true;
                }
            }
            Content::Lyrics(lyrics) => {
                if decode_json_payload(&lyrics.text).is_some() {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn parse_png_chunks(bytes: &[u8]) -> Result<Vec<PngChunk>, String> {
    const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if bytes.len() < 8 || bytes[0..8] != PNG_SIGNATURE {
        return Err("Not a valid PNG file".to_string());
    }

    let mut chunks = Vec::new();
    let mut offset = 8usize;

    while offset + 12 <= bytes.len() {
        let len = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        offset += 4;

        if offset + 4 + len + 4 > bytes.len() {
            return Err("PNG chunk exceeds file bounds".to_string());
        }

        let chunk_type = [
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ];
        offset += 4;

        let data = bytes[offset..offset + len].to_vec();
        offset += len;

        // Skip CRC from source, we'll recalculate when writing.
        offset += 4;

        let is_iend = &chunk_type == b"IEND";
        chunks.push(PngChunk { chunk_type, data });
        if is_iend {
            break;
        }
    }

    Ok(chunks)
}

fn build_png_bytes(chunks: &[PngChunk]) -> Vec<u8> {
    const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    let mut out = Vec::with_capacity(8 + chunks.len() * 32);
    out.extend_from_slice(&PNG_SIGNATURE);

    for chunk in chunks {
        let len = chunk.data.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&chunk.chunk_type);
        out.extend_from_slice(&chunk.data);

        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&chunk.chunk_type);
        hasher.update(&chunk.data);
        let crc = hasher.finalize();
        out.extend_from_slice(&crc.to_be_bytes());
    }

    out
}

fn find_embedded_json_matches(chunks: &[PngChunk]) -> Result<Vec<EmbeddedJsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let chunk_type = String::from_utf8_lossy(&chunk.chunk_type).to_string();

        if &chunk.chunk_type == b"tEXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                if let Ok(text) = str::from_utf8(&chunk.data[zero_pos + 1..]) {
                    if let Some((value, encoding, payload)) = decode_json_payload(text) {
                        matches.push(EmbeddedJsonMatch {
                            id: next_id,
                            chunk_index,
                            data_start: zero_pos + 1,
                            data_end: chunk.data.len(),
                            chunk_type: chunk_type.clone(),
                            label: keyword,
                            payload,
                            decoded_json: value,
                            encoding,
                        });
                        next_id += 1;
                    }
                }
            }
            continue;
        }

        if &chunk.chunk_type == b"iTXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                let mut idx = zero_pos + 1;
                if idx + 2 > chunk.data.len() {
                    continue;
                }

                let compression_flag = chunk.data[idx];
                idx += 2;

                if let Some(lang_end_rel) = chunk.data[idx..].iter().position(|b| *b == 0) {
                    idx += lang_end_rel + 1;
                } else {
                    continue;
                }

                if let Some(trans_end_rel) = chunk.data[idx..].iter().position(|b| *b == 0) {
                    idx += trans_end_rel + 1;
                } else {
                    continue;
                }

                if compression_flag == 0 && idx <= chunk.data.len() {
                    if let Ok(text) = str::from_utf8(&chunk.data[idx..]) {
                        if let Some((value, encoding, payload)) = decode_json_payload(text) {
                            matches.push(EmbeddedJsonMatch {
                                id: next_id,
                                chunk_index,
                                data_start: idx,
                                data_end: chunk.data.len(),
                                chunk_type: chunk_type.clone(),
                                label: keyword,
                                payload,
                                decoded_json: value,
                                encoding,
                            });
                            next_id += 1;
                        }
                    }
                }
            }
            continue;
        }

        if &chunk.chunk_type == b"zTXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                let compression_index = zero_pos + 1;
                if compression_index >= chunk.data.len() {
                    continue;
                }

                let compression_method = chunk.data[compression_index];
                let compressed_start = compression_index + 1;
                if compression_method != 0 || compressed_start > chunk.data.len() {
                    continue;
                }

                let compressed_bytes = &chunk.data[compressed_start..];
                let mut decoder = flate2::read::ZlibDecoder::new(compressed_bytes);
                let mut text = String::new();
                if decoder.read_to_string(&mut text).is_ok() {
                    if let Some((value, _encoding, payload)) = decode_json_payload(&text) {
                        matches.push(EmbeddedJsonMatch {
                            id: next_id,
                            chunk_index,
                            data_start: compressed_start,
                            data_end: chunk.data.len(),
                            chunk_type: chunk_type.clone(),
                            label: keyword,
                            payload,
                            decoded_json: value,
                            encoding: JsonPayloadEncoding::ZtxtCompressed,
                        });
                        next_id += 1;
                    }
                }
            }
            continue;
        }

        if let Ok(text) = str::from_utf8(&chunk.data) {
            if let Some((value, encoding, payload)) = decode_json_payload(text) {
                matches.push(EmbeddedJsonMatch {
                    id: next_id,
                    chunk_index,
                    data_start: 0,
                    data_end: chunk.data.len(),
                    chunk_type,
                    label: "raw chunk data".to_string(),
                    payload,
                    decoded_json: value,
                    encoding,
                });
                next_id += 1;
            }
        }
    }

    Ok(matches)
}

fn png_has_embedded_json(chunks: &[PngChunk]) -> Result<bool, String> {
    for chunk in chunks {
        if &chunk.chunk_type == b"tEXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                if let Ok(text) = str::from_utf8(&chunk.data[zero_pos + 1..]) {
                    if decode_json_payload(text).is_some() {
                        return Ok(true);
                    }
                }
            }
            continue;
        }

        if &chunk.chunk_type == b"iTXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let mut idx = zero_pos + 1;
                if idx + 2 > chunk.data.len() {
                    continue;
                }

                let compression_flag = chunk.data[idx];
                idx += 2;

                if let Some(lang_end_rel) = chunk.data[idx..].iter().position(|b| *b == 0) {
                    idx += lang_end_rel + 1;
                } else {
                    continue;
                }

                if let Some(trans_end_rel) = chunk.data[idx..].iter().position(|b| *b == 0) {
                    idx += trans_end_rel + 1;
                } else {
                    continue;
                }

                if compression_flag == 0 && idx <= chunk.data.len() {
                    if let Ok(text) = str::from_utf8(&chunk.data[idx..]) {
                        if decode_json_payload(text).is_some() {
                            return Ok(true);
                        }
                    }
                }
            }
            continue;
        }

        if &chunk.chunk_type == b"zTXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let compression_index = zero_pos + 1;
                if compression_index >= chunk.data.len() {
                    continue;
                }

                let compression_method = chunk.data[compression_index];
                let compressed_start = compression_index + 1;
                if compression_method != 0 || compressed_start > chunk.data.len() {
                    continue;
                }

                let compressed_bytes = &chunk.data[compressed_start..];
                let mut decoder = flate2::read::ZlibDecoder::new(compressed_bytes);
                let mut text = String::new();
                if decoder.read_to_string(&mut text).is_ok() && decode_json_payload(&text).is_some() {
                    return Ok(true);
                }
            }
            continue;
        }

        if let Ok(text) = str::from_utf8(&chunk.data) {
            if decode_json_payload(text).is_some() {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

fn decode_json_payload(input: &str) -> Option<(serde_json::Value, JsonPayloadEncoding, String)> {
    let trimmed = input.trim().trim_matches('\u{0}').trim();
    if trimmed.is_empty() {
        return None;
    }

    let trimmed = trimmed.trim_start_matches('\u{feff}').trim_matches('\u{0}').trim();

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Some((value, JsonPayloadEncoding::PlainText, trimmed.to_string()));
    }

    decode_base64_json(trimmed).map(|(v, enc)| {
        (
            v,
            JsonPayloadEncoding::Base64(enc),
            trimmed.chars().filter(|c| !c.is_whitespace()).collect(),
        )
    })
}

fn decode_base64_json(input: &str) -> Option<(serde_json::Value, Base64Encoding)> {
    use base64::Engine;

    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return None;
    }

    let candidates = [
        (Base64Encoding::Standard, base64::engine::general_purpose::STANDARD),
        (Base64Encoding::StandardNoPad, base64::engine::general_purpose::STANDARD_NO_PAD),
        (Base64Encoding::UrlSafe, base64::engine::general_purpose::URL_SAFE),
        (Base64Encoding::UrlSafeNoPad, base64::engine::general_purpose::URL_SAFE_NO_PAD),
    ];

    for (encoding, engine) in candidates {
        let decoded = match engine.decode(compact.as_bytes()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = match String::from_utf8(decoded) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let json: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        return Some((json, encoding));
    }

    None
}

fn encode_base64_with_encoding(text: &str, encoding: Base64Encoding) -> String {
    use base64::Engine;
    match encoding {
        Base64Encoding::Standard => base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
        Base64Encoding::StandardNoPad => {
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(text.as_bytes())
        }
        Base64Encoding::UrlSafe => base64::engine::general_purpose::URL_SAFE.encode(text.as_bytes()),
        Base64Encoding::UrlSafeNoPad => {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes())
        }
    }
}

fn encode_payload_with_encoding(text: &str, encoding: &JsonPayloadEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        JsonPayloadEncoding::PlainText => Ok(text.as_bytes().to_vec()),
        JsonPayloadEncoding::Base64(base64_encoding) => {
            Ok(encode_base64_with_encoding(text, *base64_encoding).into_bytes())
        }
        JsonPayloadEncoding::ZtxtCompressed => {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;

            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder
                .write_all(text.as_bytes())
                .map_err(|e| format!("zTXt write failed: {}", e))?;
            encoder
                .finish()
                .map_err(|e| format!("zTXt finish failed: {}", e))
        }
    }
}

fn payload_format_name(encoding: &JsonPayloadEncoding) -> &'static str {
    match encoding {
        JsonPayloadEncoding::PlainText => "plaintext",
        JsonPayloadEncoding::Base64(_) => "base64",
        JsonPayloadEncoding::ZtxtCompressed => "zTXt-compressed",
    }
}

fn find_mp3_json_matches_from_raw_id3(bytes: &[u8]) -> Result<Vec<Mp3JsonMatch>, String> {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return Ok(Vec::new());
    }

    let version = bytes[3];
    if version != 3 && version != 4 {
        return Ok(Vec::new());
    }

    let tag_size = synchsafe_to_u32(&bytes[6..10]) as usize;
    let tag_end = 10usize.saturating_add(tag_size).min(bytes.len());
    let mut offset = 10usize;
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    while offset + 10 <= tag_end {
        let header = &bytes[offset..offset + 10];
        if header.iter().all(|b| *b == 0) {
            break;
        }

        let frame_id = String::from_utf8_lossy(&header[0..4]).to_string();
        if !frame_id.chars().all(|c| c.is_ascii_alphanumeric()) {
            break;
        }

        let frame_size = if version == 4 {
            synchsafe_to_u32(&header[4..8]) as usize
        } else {
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize
        };

        offset += 10;
        if frame_size == 0 || offset + frame_size > tag_end {
            break;
        }

        let data = &bytes[offset..offset + frame_size];
        offset += frame_size;

        if frame_id == "TXXX" {
            if let Some((description, text)) = parse_txxx_value(data) {
                if let Some((value, encoding, payload)) = decode_json_payload(&text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: if description.is_empty() {
                            "TXXX".to_string()
                        } else {
                            format!("TXXX:{}", description)
                        },
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::ExtendedText {
                            description,
                        },
                    });
                    next_id += 1;
                }
            }
            continue;
        }

        if frame_id.starts_with('T') && frame_id != "TXXX" {
            if let Some(text) = parse_text_frame_value(data) {
                if let Some((value, encoding, payload)) = decode_json_payload(&text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: format!("{}:raw-fallback", frame_id),
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::Text {
                            frame_id: frame_id.clone(),
                        },
                    });
                    next_id += 1;
                }
            }
        }
    }

    Ok(matches)
}

fn mp3_raw_has_embedded_json(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return Ok(false);
    }

    let version = bytes[3];
    if version != 3 && version != 4 {
        return Ok(false);
    }

    let tag_size = synchsafe_to_u32(&bytes[6..10]) as usize;
    let tag_end = 10usize.saturating_add(tag_size).min(bytes.len());
    let mut offset = 10usize;

    while offset + 10 <= tag_end {
        let header = &bytes[offset..offset + 10];
        if header.iter().all(|b| *b == 0) {
            break;
        }

        let frame_id = String::from_utf8_lossy(&header[0..4]).to_string();
        if !frame_id.chars().all(|c| c.is_ascii_alphanumeric()) {
            break;
        }

        let frame_size = if version == 4 {
            synchsafe_to_u32(&header[4..8]) as usize
        } else {
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize
        };

        offset += 10;
        if frame_size == 0 || offset + frame_size > tag_end {
            break;
        }

        let data = &bytes[offset..offset + frame_size];
        offset += frame_size;

        if frame_id == "TXXX" {
            if let Some((_description, text)) = parse_txxx_value(data) {
                if decode_json_payload(&text).is_some() {
                    return Ok(true);
                }
            }
            continue;
        }

        if frame_id.starts_with('T') && frame_id != "TXXX" {
            if let Some(text) = parse_text_frame_value(data) {
                if decode_json_payload(&text).is_some() {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}

fn find_video_embedded_json_matches(bytes: &[u8]) -> Result<Vec<VideoJsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for (start, end) in find_json_object_spans(bytes) {
        if let Ok(text) = str::from_utf8(&bytes[start..end]) {
            if let Some((value, encoding, payload)) = decode_json_payload(text) {
                if matches!(encoding, JsonPayloadEncoding::PlainText) {
                    matches.push(VideoJsonMatch {
                        id: next_id,
                        start,
                        end,
                        label: format!("json@{}", start),
                        payload,
                        decoded_json: value,
                        encoding,
                        atom_path: Vec::new(),
                    });
                    next_id += 1;
                }
            }
        }
    }

    for (start, end) in find_base64_candidate_spans(bytes) {
        let token = match str::from_utf8(&bytes[start..end]) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let Some((value, encoding, payload)) = decode_json_payload(token) else {
            continue;
        };

        if !matches!(encoding, JsonPayloadEncoding::Base64(_)) {
            continue;
        }

        if matches.iter().any(|m| !(end <= m.start || start >= m.end)) {
            continue;
        }

        matches.push(VideoJsonMatch {
            id: next_id,
            start,
            end,
            label: format!("base64@{}", start),
            payload,
            decoded_json: value,
            encoding,
            atom_path: Vec::new(),
        });
        next_id += 1;
    }

    Ok(matches)
}

fn find_json_object_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }

        if let Some(end) = parse_json_object_span(bytes, i) {
            spans.push((i, end));
            i = end;
        } else {
            i += 1;
        }
    }

    spans
}

fn parse_json_object_span(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start).copied()? != b'{' {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaping = false;

    for (idx, b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaping {
                escaping = false;
                continue;
            }

            if *b == b'\\' {
                escaping = true;
                continue;
            }

            if *b == b'"' {
                in_string = false;
            }
            continue;
        }

        match *b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                if depth == 0 {
                    return Some(idx + 1);
                }
            }
            _ => {}
        }
    }

    None
}

fn find_base64_candidate_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
    const MIN_BASE64_TOKEN_LEN: usize = 24;
    let mut spans = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if !is_base64_char(bytes[i]) {
            i += 1;
            continue;
        }

        let start = i;
        while i < bytes.len() && is_base64_char(bytes[i]) {
            i += 1;
        }

        if i.saturating_sub(start) >= MIN_BASE64_TOKEN_LEN {
            spans.push((start, i));
        }
    }

    spans
}

fn is_base64_char(byte: u8) -> bool {
    matches!(byte,
        b'A'..=b'Z'
        | b'a'..=b'z'
        | b'0'..=b'9'
        | b'+'
        | b'/'
        | b'='
        | b'-'
        | b'_'
    )
}

fn find_mp4_embedded_json_matches(bytes: &[u8]) -> Result<Vec<VideoJsonMatch>, String> {
    let (_atoms, matches) = find_mp4_embedded_json_matches_with_atoms(bytes)?;
    Ok(matches)
}

fn find_mp4_embedded_json_matches_with_atoms(bytes: &[u8]) -> Result<(Vec<Mp4Atom>, Vec<VideoJsonMatch>), String> {
    let mut atoms = Vec::new();
    parse_mp4_atoms(bytes, 0, bytes.len(), None, &mut atoms)?;

    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for (idx, atom) in atoms.iter().enumerate() {
        if atom.data_start >= atom.end {
            continue;
        }

        if !mp4_atom_is_json_candidate(atom, &atoms) {
            continue;
        }

        let payload_start = if atom.atom_type == *b"data" {
            atom.data_start.saturating_add(8).min(atom.end)
        } else {
            atom.data_start
        };

        if payload_start >= atom.end {
            continue;
        }

        let atom_bytes = &bytes[payload_start..atom.end];

        for (rel_start, rel_end) in find_json_object_spans(atom_bytes) {
            if let Ok(text) = str::from_utf8(&atom_bytes[rel_start..rel_end]) {
                if let Some((value, encoding, payload)) = decode_json_payload(text) {
                    matches.push(VideoJsonMatch {
                        id: next_id,
                        start: payload_start + rel_start,
                        end: payload_start + rel_end,
                        label: format!("{}@{}", atom_type_label(atom.atom_type), payload_start + rel_start),
                        payload,
                        decoded_json: value,
                        encoding,
                        atom_path: collect_mp4_atom_path(idx, &atoms),
                    });
                    next_id += 1;
                }
            }
        }

        for (rel_start, rel_end) in find_base64_candidate_spans(atom_bytes) {
            let token = match str::from_utf8(&atom_bytes[rel_start..rel_end]) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let Some((value, encoding, payload)) = decode_json_payload(token) else {
                continue;
            };

            if !matches!(encoding, JsonPayloadEncoding::Base64(_)) {
                continue;
            }

            let abs_start = payload_start + rel_start;
            let abs_end = payload_start + rel_end;

            if matches.iter().any(|m| !(abs_end <= m.start || abs_start >= m.end)) {
                continue;
            }

            matches.push(VideoJsonMatch {
                id: next_id,
                start: abs_start,
                end: abs_end,
                label: format!("{}@{}", atom_type_label(atom.atom_type), abs_start),
                payload,
                decoded_json: value,
                encoding,
                atom_path: collect_mp4_atom_path(idx, &atoms),
            });
            next_id += 1;
        }
    }

    Ok((atoms, matches))
}

fn parse_mp4_atoms(
    bytes: &[u8],
    start: usize,
    end: usize,
    parent: Option<usize>,
    out: &mut Vec<Mp4Atom>,
) -> Result<(), String> {
    let mut offset = start;

    while offset + 8 <= end && offset + 8 <= bytes.len() {
        let size32 = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);

        let atom_type = [
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ];

        let (atom_size, header_size, size_kind) = if size32 == 0 {
            (end.saturating_sub(offset), 8usize, Mp4AtomSizeKind::ToEof)
        } else if size32 == 1 {
            if offset + 16 > end || offset + 16 > bytes.len() {
                break;
            }
            let size64 = u64::from_be_bytes([
                bytes[offset + 8],
                bytes[offset + 9],
                bytes[offset + 10],
                bytes[offset + 11],
                bytes[offset + 12],
                bytes[offset + 13],
                bytes[offset + 14],
                bytes[offset + 15],
            ]);
            if size64 < 16 {
                break;
            }
            let size = usize::try_from(size64).map_err(|_| "MP4 atom size is too large".to_string())?;
            (size, 16usize, Mp4AtomSizeKind::Extended64(size64))
        } else {
            if size32 < 8 {
                break;
            }
            (size32 as usize, 8usize, Mp4AtomSizeKind::Fixed32(size32))
        };

        if atom_size == 0 {
            break;
        }

        let atom_end = offset.saturating_add(atom_size);
        if atom_end > end || atom_end > bytes.len() {
            break;
        }

        let data_start = offset + header_size;
        let idx = out.len();
        out.push(Mp4Atom {
            start: offset,
            end: atom_end,
            data_start,
            atom_type,
            size_kind,
            parent,
        });

        if mp4_atom_is_container(atom_type) {
            let mut child_start = data_start;
            if atom_type == *b"meta" {
                child_start = child_start.saturating_add(4).min(atom_end);
            }
            if child_start < atom_end {
                parse_mp4_atoms(bytes, child_start, atom_end, Some(idx), out)?;
            }
        }

        if matches!(size_kind, Mp4AtomSizeKind::ToEof) {
            break;
        }

        offset = atom_end;
    }

    Ok(())
}

fn mp4_atom_is_container(atom_type: [u8; 4]) -> bool {
    matches!(
        &atom_type,
        b"moov"
            | b"udta"
            | b"meta"
            | b"ilst"
            | b"trak"
            | b"mdia"
            | b"minf"
            | b"stbl"
            | b"edts"
            | b"dinf"
            | b"mvex"
            | b"moof"
            | b"traf"
            | b"mfra"
    )
}

fn mp4_atom_is_json_candidate(atom: &Mp4Atom, atoms: &[Mp4Atom]) -> bool {
    if atom.end.saturating_sub(atom.data_start) > 8 * 1024 * 1024 {
        return false;
    }

    if atom.atom_type == *b"data"
        || atom.atom_type == *b"----"
        || atom.atom_type == *b"desc"
        || atom.atom_type == *b"ldes"
        || atom.atom_type == *b"cmt "
    {
        return true;
    }

    has_mp4_ancestor_type(atom, atoms, *b"ilst") || has_mp4_ancestor_type(atom, atoms, *b"udta")
}

fn has_mp4_ancestor_type(atom: &Mp4Atom, atoms: &[Mp4Atom], wanted: [u8; 4]) -> bool {
    let mut current = atom.parent;
    while let Some(idx) = current {
        let Some(parent) = atoms.get(idx) else {
            return false;
        };
        if parent.atom_type == wanted {
            return true;
        }
        current = parent.parent;
    }
    false
}

fn collect_mp4_atom_path(mut atom_idx: usize, atoms: &[Mp4Atom]) -> Vec<usize> {
    let mut path = Vec::new();
    loop {
        path.push(atom_idx);
        let Some(atom) = atoms.get(atom_idx) else {
            break;
        };
        let Some(parent_idx) = atom.parent else {
            break;
        };
        atom_idx = parent_idx;
    }
    path
}

fn apply_mp4_atom_size_delta(bytes: &mut [u8], atom: &Mp4Atom, delta: isize) -> Result<(), String> {
    match atom.size_kind {
        Mp4AtomSizeKind::Fixed32(old_size) => {
            let new_size = old_size as isize + delta;
            if new_size < 8 {
                return Err("MP4 atom size underflow during rewrite".to_string());
            }
            let new_u32 = u32::try_from(new_size)
                .map_err(|_| "MP4 atom exceeded 32-bit size while rewriting".to_string())?;
            if atom.start + 4 > bytes.len() {
                return Err("Invalid MP4 size write offset".to_string());
            }
            bytes[atom.start..atom.start + 4].copy_from_slice(&new_u32.to_be_bytes());
            Ok(())
        }
        Mp4AtomSizeKind::Extended64(old_size) => {
            let new_size = old_size as i128 + delta as i128;
            if new_size < 16 {
                return Err("MP4 extended atom size underflow during rewrite".to_string());
            }
            let new_u64 = u64::try_from(new_size)
                .map_err(|_| "MP4 extended atom size overflow during rewrite".to_string())?;
            if atom.start + 16 > bytes.len() {
                return Err("Invalid MP4 extended-size write offset".to_string());
            }
            bytes[atom.start..atom.start + 4].copy_from_slice(&1u32.to_be_bytes());
            bytes[atom.start + 8..atom.start + 16].copy_from_slice(&new_u64.to_be_bytes());
            Ok(())
        }
        Mp4AtomSizeKind::ToEof => Ok(()),
    }
}

fn atom_type_label(atom_type: [u8; 4]) -> String {
    if atom_type.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        String::from_utf8_lossy(&atom_type).to_string()
    } else {
        format!(
            "0x{:02X}{:02X}{:02X}{:02X}",
            atom_type[0], atom_type[1], atom_type[2], atom_type[3]
        )
    }
}

fn synchsafe_to_u32(bytes: &[u8]) -> u32 {
    if bytes.len() < 4 {
        return 0;
    }

    ((bytes[0] as u32) << 21)
        | ((bytes[1] as u32) << 14)
        | ((bytes[2] as u32) << 7)
        | (bytes[3] as u32)
}

fn parse_text_frame_value(data: &[u8]) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    decode_id3_text(data[0], &data[1..])
}

fn parse_txxx_value(data: &[u8]) -> Option<(String, String)> {
    if data.is_empty() {
        return None;
    }

    let enc = data[0];
    let rest = &data[1..];
    let (description_bytes, value_bytes) = if enc == 0 || enc == 3 {
        if let Some(pos) = rest.iter().position(|b| *b == 0) {
            (&rest[..pos], &rest[pos + 1..])
        } else if let Some(pos) = rest.iter().position(|b| *b == b'{') {
            (&rest[..pos], &rest[pos..])
        } else {
            return None;
        }
    } else {
        let mut idx = None;
        for i in 0..rest.len().saturating_sub(1) {
            if rest[i] == 0 && rest[i + 1] == 0 {
                idx = Some(i + 2);
                break;
            }
        }
        if let Some(start) = idx {
            (&rest[..start.saturating_sub(2)], &rest[start..])
        } else {
            return None;
        }
    };

    let description = decode_id3_text(enc, description_bytes)
        .unwrap_or_default()
        .trim_matches('\u{0}')
        .trim()
        .to_string();
    let value = decode_id3_text(enc, value_bytes)?;

    Some((description, value))
}

fn build_backup_path(path: &Path) -> std::path::PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut backup = path.to_path_buf();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bak");
    backup.set_extension(format!("{}.charbrowser.{}.bak", ext, ts));
    backup
}

fn write_with_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let backup_path = build_backup_path(path);
    fs::copy(path, &backup_path)
        .map_err(|e| format!("Failed to create backup before write: {}", e))?;

    if let Err(e) = fs::write(path, bytes) {
        let _ = fs::copy(&backup_path, path);
        let _ = fs::remove_file(&backup_path);
        return Err(format!("Write failed: {}", e));
    }

    let _ = fs::remove_file(&backup_path);
    Ok(())
}

fn decode_id3_text(enc: u8, bytes: &[u8]) -> Option<String> {
    match enc {
        0 | 3 => Some(String::from_utf8_lossy(bytes).to_string()),
        1 => {
            if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
                let units = bytes[2..]
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>();
                String::from_utf16(&units).ok()
            } else {
                let start = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE { 2 } else { 0 };
                let units = bytes[start..]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>();
                String::from_utf16(&units).ok()
            }
        }
        2 => {
            let units = bytes
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect::<Vec<_>>();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_fixture_path(file_name: &str) -> Option<std::path::PathBuf> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("media")
            .join(file_name);
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    #[test]
    fn mp4_roundtrip_embedded_json_update_keeps_file_parseable() {
        let Some(source_path) = media_fixture_path("ComfyUI_00008_.mp4") else {
            return;
        };

        let temp_path = std::env::temp_dir().join(format!(
            "charbrowser-mp4-roundtrip-{}.mp4",
            std::process::id()
        ));

        fs::copy(&source_path, &temp_path).expect("failed to copy fixture MP4");

        let entries_before = list_embedded_base64_json_entries(
            temp_path.to_str().expect("temp path must be valid UTF-8"),
        )
        .expect("failed to list MP4 embedded entries before update");

        assert!(
            !entries_before.is_empty(),
            "fixture MP4 should contain at least one embedded JSON payload"
        );

        let target = &entries_before[0];
        let mut parsed: serde_json::Value = serde_json::from_str(&target.decoded_json)
            .expect("fixture embedded JSON should parse");
        if let Some(obj) = parsed.as_object_mut() {
            obj.insert(
                "charbrowser_roundtrip_test".to_string(),
                serde_json::json!("ok"),
            );
        }

        let updated_text = serde_json::to_string_pretty(&parsed).expect("failed to serialize test JSON");
        update_embedded_base64_json(
            temp_path.to_str().expect("temp path must be valid UTF-8"),
            target.id,
            &updated_text,
        )
        .expect("failed to update MP4 embedded JSON");

        let bytes_after = fs::read(&temp_path).expect("failed to read updated MP4");
        parse_mp4_atoms(&bytes_after, 0, bytes_after.len(), None, &mut Vec::new())
            .expect("updated MP4 atoms should remain parseable");

        let entries_after = list_embedded_base64_json_entries(
            temp_path.to_str().expect("temp path must be valid UTF-8"),
        )
        .expect("failed to list MP4 embedded entries after update");

        assert!(
            !entries_after.is_empty(),
            "updated MP4 should still expose embedded JSON entries"
        );
        assert!(
            entries_after
                .iter()
                .any(|e| e.decoded_json.contains("charbrowser_roundtrip_test")),
            "updated JSON marker should be present after rewrite"
        );

        let _ = fs::remove_file(&temp_path);
    }
}
