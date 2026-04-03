use crate::metadata::audio::{find_flac_embedded_json_matches, flac_has_embedded_json, find_mp3_embedded_json_matches, mp3_tag_has_embedded_json, mp3_raw_has_embedded_json, update_flac_embedded_json, update_mp3_embedded_json};
use crate::metadata::image::{parse_png_chunks, find_embedded_json_matches, png_has_embedded_json};
use crate::metadata::video::{find_mp4_embedded_json_matches, find_video_embedded_json_matches, update_mp4_embedded_json};
use base64::Engine;
use crate::metadata::types::{EmbeddedJsonEntry, JsonPayloadEncoding, TextEntry};
use std::fs;
use std::path::Path;

fn is_structured_json(value: &serde_json::Value) -> bool {
    matches!(value, serde_json::Value::Object(_) | serde_json::Value::Array(_))
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

    if ext == "flac" {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
        return flac_has_embedded_json(&bytes);
    }

    if ext == "mp3" {
        let tag = id3::Tag::read_from_path(path).map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
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
                decoded_json: serde_json::to_string_pretty(&m.decoded_json).unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    if ext == "flac" {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
        let matches = find_flac_embedded_json_matches(&bytes)?;

        return Ok(matches
            .into_iter()
            .map(|m| EmbeddedJsonEntry {
                id: m.id,
                chunk_type: "vorbis-comment".to_string(),
                label: m.label,
                base64: m.payload.clone(),
                payload: m.payload,
                payload_format: payload_format_name(&m.encoding).to_string(),
                decoded_json: serde_json::to_string_pretty(&m.decoded_json).unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    if ext == "mp3" {
        let tag = id3::Tag::read_from_path(path).map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
        let mut matches = find_mp3_embedded_json_matches(&tag)?;

        if matches.is_empty() {
            let bytes = fs::read(path).map_err(|e| format!("Failed to read MP3 file: {}", e))?;
            matches = crate::metadata::audio::find_mp3_json_matches_from_raw_id3(&bytes)?;
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
                decoded_json: serde_json::to_string_pretty(&m.decoded_json).unwrap_or_else(|_| "{}".to_string()),
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
                decoded_json: serde_json::to_string_pretty(&m.decoded_json).unwrap_or_else(|_| "{}".to_string()),
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
                decoded_json: serde_json::to_string_pretty(&m.decoded_json).unwrap_or_else(|_| "{}".to_string()),
            })
            .collect());
    }

    Ok(Vec::new())
}

pub fn list_text_entries(file_path: &str) -> Result<Vec<TextEntry>, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "png" {
        let bytes = fs::read(path).map_err(|e| format!("Failed to read PNG file: {}", e))?;
        let chunks = parse_png_chunks(&bytes)?;
        let entries = crate::metadata::image::find_plaintext_entries(&chunks);
        return Ok(entries);
    }

    Ok(Vec::new())
}

pub fn update_embedded_base64_json(file_path: &str, entry_id: usize, json_text: &str) -> Result<(), String> {
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

    if ext == "flac" {
        return update_flac_embedded_json(path, entry_id, json_text);
    }

    if matches!(ext.as_str(), "mp4" | "mov" | "avi" | "mkv") {
        return update_video_embedded_json(path, &ext, entry_id, json_text);
    }

    Err("Editing embedded JSON is currently supported for PNG, MP3, and common video files".to_string())
}

pub fn update_video_embedded_json(path: &Path, ext: &str, entry_id: usize, json_text: &str) -> Result<(), String> {
    let new_json_value: serde_json::Value = serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    if matches!(ext, "mp4" | "mov") {
        return update_mp4_embedded_json(path, entry_id, &new_json_compact);
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
    let matches = find_video_embedded_json_matches(&bytes)?;
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let new_payload = encode_payload_with_encoding(&new_json_compact, &target.encoding)
        .map_err(|e| format!("Failed to encode payload: {}", e))?;
    let old_len = target.end.saturating_sub(target.start);

    if new_payload.len() != old_len {
        return Err(format!("Edited payload length changed (old {} bytes, new {} bytes). For video files, keep the JSON length unchanged to avoid breaking container offsets.", old_len, new_payload.len()));
    }

    let mut bytes_mut = bytes;
    bytes_mut.splice(target.start..target.end, new_payload.iter().copied());
    crate::metadata::utils::write_with_backup(path, &bytes_mut).map_err(|e| format!("Failed to write updated video file: {}", e))?;
    Ok(())
}

pub fn update_png_embedded_json(path: &Path, entry_id: usize, json_text: &str) -> Result<(), String> {
    let new_json_value: serde_json::Value = serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;

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

    chunk.data.splice(target.data_start..target.data_end, new_payload.iter().copied());

    let updated_png = crate::metadata::image::build_png_bytes(&chunks);
    crate::metadata::utils::write_with_backup(path, &updated_png).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

pub fn payload_format_name(encoding: &JsonPayloadEncoding) -> &'static str {
    match encoding {
        JsonPayloadEncoding::PlainText => "plaintext",
        JsonPayloadEncoding::Base64(_) => "base64",
        JsonPayloadEncoding::ZtxtCompressed => "zTXt-compressed",
    }
}

pub fn decode_json_payload(input: &str) -> Option<(serde_json::Value, JsonPayloadEncoding, String)> {
    let trimmed = input.trim().trim_matches('\u{0}').trim();
    if trimmed.is_empty() {
        return None;
    }

    let trimmed = trimmed
        .trim_start_matches('\u{feff}')
        .trim_matches('\u{0}')
        .trim();

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if is_structured_json(&value) {
            return Some((value, JsonPayloadEncoding::PlainText, trimmed.to_string()));
        }
    }

    decode_base64_json(trimmed).map(|(v, enc)| {
        (
            v,
            JsonPayloadEncoding::Base64(enc),
            trimmed.chars().filter(|c| !c.is_whitespace()).collect(),
        )
    })
}

pub fn decode_base64_json(input: &str) -> Option<(serde_json::Value, crate::metadata::types::Base64Encoding)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return None;
    }

    let candidates = [
        (crate::metadata::types::Base64Encoding::Standard, base64::engine::general_purpose::STANDARD),
        (crate::metadata::types::Base64Encoding::StandardNoPad, base64::engine::general_purpose::STANDARD_NO_PAD),
        (crate::metadata::types::Base64Encoding::UrlSafe, base64::engine::general_purpose::URL_SAFE),
        (crate::metadata::types::Base64Encoding::UrlSafeNoPad, base64::engine::general_purpose::URL_SAFE_NO_PAD),
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

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if is_structured_json(&json) {
                return Some((json, encoding));
            }
        }
    }

    None
}

pub fn encode_json_payload(json_text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(json_text.as_bytes());
    Ok(encoded.into_bytes())
}

pub fn encode_base64_with_encoding(text: &str, encoding: crate::metadata::types::Base64Encoding) -> String {
    use base64::Engine;
    match encoding {
        crate::metadata::types::Base64Encoding::Standard => base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
        crate::metadata::types::Base64Encoding::StandardNoPad => base64::engine::general_purpose::STANDARD_NO_PAD.encode(text.as_bytes()),
        crate::metadata::types::Base64Encoding::UrlSafe => base64::engine::general_purpose::URL_SAFE.encode(text.as_bytes()),
        crate::metadata::types::Base64Encoding::UrlSafeNoPad => base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes()),
    }
}

pub fn encode_payload_with_encoding(text: &str, encoding: &JsonPayloadEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        JsonPayloadEncoding::PlainText => Ok(text.as_bytes().to_vec()),
        JsonPayloadEncoding::Base64(base64_encoding) => Ok(encode_base64_with_encoding(text, *base64_encoding).into_bytes()),
        JsonPayloadEncoding::ZtxtCompressed => {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;

            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(text.as_bytes()).map_err(|e| format!("zTXt write failed: {}", e))?;
            encoder.finish().map_err(|e| format!("zTXt finish failed: {}", e))
        }
    }
}
