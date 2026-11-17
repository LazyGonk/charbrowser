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

fn pretty_json_or_empty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|e| {
        eprintln!("Failed to serialize embedded JSON for preview: {}", e);
        "{}".to_string()
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
                decoded_json: pretty_json_or_empty(&m.decoded_json),
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
                decoded_json: pretty_json_or_empty(&m.decoded_json),
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
                decoded_json: pretty_json_or_empty(&m.decoded_json),
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
                decoded_json: pretty_json_or_empty(&m.decoded_json),
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
                decoded_json: pretty_json_or_empty(&m.decoded_json),
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

/// Validates and compacts card JSON for PNG card storage.
/// Returns compact JSON text plus whether schema is chara_card_v3.
fn compact_card_json_payload(json_text: &str) -> Result<(String, bool), String> {
    let value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let compact = serde_json::to_string(&value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    let is_v3 = value
        .get("spec")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("chara_card_v3"))
        .unwrap_or(false)
        || value
            .get("spec_version")
            .and_then(|v| v.as_str())
            .map(|s| s.starts_with('3'))
            .unwrap_or(false);

    Ok((compact, is_v3))
}

/// Builds a tEXt PNG chunk containing keyword + uncompressed text payload.
fn build_text_chunk(keyword: &str, payload_text: &str) -> crate::metadata::types::PngChunk {
    let mut data = Vec::new();
    data.extend_from_slice(keyword.as_bytes());
    data.push(0); // keyword terminator
    data.extend_from_slice(payload_text.as_bytes());

    crate::metadata::types::PngChunk {
        chunk_type: *b"tEXt",
        data,
    }
}

/// Upserts one character-card payload into parsed PNG chunks.
/// If a `chara`/`character` JSON entry exists, it is updated in place.
/// Otherwise, a new `tEXt` chunk is inserted right before `IEND`.
fn upsert_card_chunk(
    chunks: &mut Vec<crate::metadata::types::PngChunk>,
    keyword: &str,
    compact_json_text: &str,
) -> Result<(), String> {
    let matches = find_embedded_json_matches(chunks)?;
    let target = matches
        .iter()
        .find(|m| {
            let label = m.label.to_ascii_lowercase();
            let key = keyword.to_ascii_lowercase();
            if key == "chara" {
                label == "chara" || label == "character"
            } else {
                label == key
            }
        })
        .map(|m| (m.chunk_index, m.data_start, m.data_end, &m.encoding));

    if let Some((chunk_index, data_start, data_end, encoding)) = target {
        let replacement = encode_payload_with_encoding(compact_json_text, encoding)
            .map_err(|e| format!("Failed to encode payload: {}", e))?;

        let chunk = chunks
            .get_mut(chunk_index)
            .ok_or_else(|| "Invalid chunk reference".to_string())?;
        chunk.data.splice(data_start..data_end, replacement.iter().copied());
        return Ok(());
    }

    let insert_index = chunks
        .iter()
        .position(|chunk| &chunk.chunk_type == b"IEND")
        .unwrap_or(chunks.len());
    let encoded = encode_base64_with_encoding(
        compact_json_text,
        crate::metadata::types::Base64Encoding::Standard,
    );
    chunks.insert(insert_index, build_text_chunk(keyword, &encoded));
    Ok(())
}

/// Removes all embedded JSON chunks matching one card keyword.
/// For `chara`, both `chara` and `character` labels are treated as matches.
fn remove_card_chunks(
    chunks: &mut Vec<crate::metadata::types::PngChunk>,
    keyword: &str,
) -> Result<(), String> {
    let mut indices: Vec<usize> = find_embedded_json_matches(chunks)?
        .into_iter()
        .filter(|m| {
            let label = m.label.to_ascii_lowercase();
            let key = keyword.to_ascii_lowercase();
            if key == "chara" {
                label == "chara" || label == "character"
            } else {
                label == key
            }
        })
        .map(|m| m.chunk_index)
        .collect();

    indices.sort_unstable();
    indices.dedup();
    for index in indices.into_iter().rev() {
        chunks.remove(index);
    }

    Ok(())
}

/// Updates or inserts a PNG card payload into an existing PNG file.
/// This command preserves non-card chunks and writes with backup safety.
pub fn upsert_png_character_card(file_path: &str, json_text: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "png" {
        return Err("Only PNG files are supported for card upsert".to_string());
    }

    let (compact_json_text, is_v3) = compact_card_json_payload(json_text)?;
    let bytes = fs::read(path).map_err(|e| format!("Failed to read PNG file: {}", e))?;
    let mut chunks = parse_png_chunks(&bytes)?;
    upsert_card_chunk(&mut chunks, "chara", &compact_json_text)?;
    if is_v3 {
        upsert_card_chunk(&mut chunks, "ccv3", &compact_json_text)?;
    } else {
        // Prevent stale v3 payloads from surviving a v2 save.
        remove_card_chunks(&mut chunks, "ccv3")?;
    }

    let updated_png = crate::metadata::image::build_png_bytes(&chunks);
    crate::metadata::utils::write_with_backup(path, &updated_png)
        .map_err(|e| format!("Failed to write PNG file: {}", e))
}

/// Character-card schema versions the bulk writer understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardSchema {
    V1,
    V2,
    V3,
    Unknown,
}

/// Detects a card schema from the `spec`/`spec_version` markers.
pub fn detect_card_schema(card: &serde_json::Value) -> CardSchema {
    let spec = card
        .get("spec")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let version = card
        .get("spec_version")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();

    if spec.starts_with("chara_card_v3") || version.starts_with('3') {
        CardSchema::V3
    } else if spec.starts_with("chara_card_v2") || version.starts_with('2') {
        CardSchema::V2
    } else if spec.starts_with("chara_card_v1") || version.starts_with('1') {
        CardSchema::V1
    } else {
        CardSchema::Unknown
    }
}

/// Why a character-card JSON edit could not be planned or applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardJsonEditError {
    /// The payload is not a v2/v3 character card; no write is attempted.
    Unsupported(String),
    /// The pointer, the JSON, or the card structure rejected the edit.
    Invalid(String),
}

impl CardJsonEditError {
    pub fn message(&self) -> &str {
        match self {
            CardJsonEditError::Unsupported(message) | CardJsonEditError::Invalid(message) => {
                message
            }
        }
    }
}

/// One reviewed payload change inside a card file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardJsonChange {
    /// Payload identifier: the PNG chunk keyword (`chara`, `character`,
    /// `ccv3`) or `json` for a standalone `.json` card.
    pub payload: String,
    /// Previous value as text. `None` means the pointer did not exist.
    pub old_value: Option<String>,
}

/// Rewritten container bytes plus the payload changes they represent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardJsonEdit {
    pub bytes: Vec<u8>,
    pub changes: Vec<CardJsonChange>,
}

/// Payload keywords that carry a character card. `character` is the legacy
/// alias of `chara`; `ccv3` is the v3 companion payload.
fn card_payload_label(label: &str) -> Option<&'static str> {
    match label.to_ascii_lowercase().as_str() {
        "chara" => Some("chara"),
        "character" => Some("character"),
        "ccv3" => Some("ccv3"),
        _ => None,
    }
}

fn ensure_supported_card_schema(
    card: &serde_json::Value,
    payload: &str,
) -> Result<(), CardJsonEditError> {
    match detect_card_schema(card) {
        CardSchema::V2 | CardSchema::V3 => Ok(()),
        CardSchema::V1 => Err(CardJsonEditError::Unsupported(format!(
            "{} payload uses the v1 character-card schema; bulk editing supports only chara_card_v2/v3 cards.",
            payload
        ))),
        CardSchema::Unknown => Err(CardJsonEditError::Unsupported(format!(
            "{} payload is not a chara_card_v2/v3 character card; bulk editing requires one.",
            payload
        ))),
    }
}

/// Text form of a JSON value for the review table. Strings are shown as-is;
/// every other scalar or structure is shown as compact JSON.
fn card_value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

fn is_unchanged_string(old: Option<&serde_json::Value>, value: &str) -> bool {
    matches!(old, Some(serde_json::Value::String(current)) if current == value)
}

/// Escapes one reference token per RFC 6901 (`~` -> `~0`, `/` -> `~1`).
fn escape_json_pointer_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// Recursively collects scalar leaves as `(pointer, text)` pairs.
///
/// Objects emit `/key`, arrays emit `/index`, and only `String`, `Number`,
/// `Bool`, and `Null` leaves are emitted, so every pointer is a scalar the
/// `json_set_path` writer can replace. Empty objects and arrays contribute no
/// pointer.
fn collect_card_json_pointers(
    value: &serde_json::Value,
    pointer: &mut String,
    out: &mut Vec<(String, String)>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let start = pointer.len();
                pointer.push('/');
                pointer.push_str(&escape_json_pointer_token(key));
                collect_card_json_pointers(child, pointer, out);
                pointer.truncate(start);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let start = pointer.len();
                pointer.push('/');
                pointer.push_str(&index.to_string());
                collect_card_json_pointers(child, pointer, out);
                pointer.truncate(start);
            }
        }
        serde_json::Value::String(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::Bool(_)
        | serde_json::Value::Null => out.push((pointer.clone(), card_value_text(value))),
    }
}

/// Drops repeated pointers while keeping first-seen order.
///
/// A v3 PNG carries the same card twice (`chara` and `ccv3`), so the discovery
/// list must show each pointer once.
fn dedup_card_json_pointers(fields: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    fields
        .into_iter()
        .filter(|(pointer, _)| seen.insert(pointer.clone()))
        .collect()
}

/// Lists every character-card JSON Pointer present in a PNG's card payloads.
///
/// Read-only: chunk parsing and JSON decoding only. `chara`/`character`/`ccv3`
/// payloads are all walked and pointers are deduplicated across them, so the
/// caller sees each path once. Every payload must validate as a v2/v3 card, and
/// a PNG without a decodable card payload is an error.
pub fn read_png_card_json_pointers(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let chunks = parse_png_chunks(bytes)?;
    let matches = find_embedded_json_matches(&chunks)?;

    let card_matches: Vec<_> = matches
        .into_iter()
        .filter(|m| card_payload_label(&m.label).is_some())
        .collect();

    if card_matches.is_empty() {
        return Err(
            "No decodable character-card JSON payload (chara, character, or ccv3) was found in this PNG."
                .to_string(),
        );
    }

    for m in &card_matches {
        ensure_supported_card_schema(&m.decoded_json, &m.label)
            .map_err(|error| error.message().to_string())?;
    }

    let mut fields = Vec::new();
    let mut pointer = String::new();
    for m in card_matches {
        collect_card_json_pointers(&m.decoded_json, &mut pointer, &mut fields);
    }
    Ok(dedup_card_json_pointers(fields))
}

/// Lists every character-card JSON Pointer present in a standalone `.json` card.
///
/// Read-only and schema-checked exactly like the PNG reader.
pub fn read_json_card_json_pointers(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Standalone character-card JSON must be valid UTF-8.".to_string())?;
    let card: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| format!("Invalid JSON: {}", error))?;
    ensure_supported_card_schema(&card, "Standalone").map_err(|error| error.message().to_string())?;

    let mut fields = Vec::new();
    let mut pointer = String::new();
    collect_card_json_pointers(&card, &mut pointer, &mut fields);
    Ok(fields)
}

/// Applies one JSON Pointer string set to every character-card payload in a PNG.
///
/// Each payload keeps its own schema and payload encoding (`tEXt`, `iTXt`, or
/// `zTXt`; plain text or Base64), and non-card chunks are not touched. A v3
/// card's `chara` and `ccv3` aliases are both updated, so they stay consistent.
/// Payloads that already hold the requested string are left byte-identical.
pub fn set_png_card_json_pointer(
    bytes: &[u8],
    pointer: &str,
    value: &str,
) -> Result<CardJsonEdit, CardJsonEditError> {
    let tokens = crate::metadata::json_pointer::parse_json_pointer(pointer)
        .map_err(CardJsonEditError::Invalid)?;
    let mut chunks = parse_png_chunks(bytes).map_err(CardJsonEditError::Invalid)?;
    let matches = find_embedded_json_matches(&chunks).map_err(CardJsonEditError::Invalid)?;

    let card_matches: Vec<_> = matches
        .into_iter()
        .filter(|m| card_payload_label(&m.label).is_some())
        .collect();

    if card_matches.is_empty() {
        return Err(CardJsonEditError::Invalid(
            "No decodable character-card JSON payload (chara, character, or ccv3) was found in this PNG."
                .to_string(),
        ));
    }

    // Validate every payload before mutating any chunk, so a mixed-schema file
    // is rejected as a whole.
    for m in &card_matches {
        ensure_supported_card_schema(&m.decoded_json, &m.label)?;
    }

    let mut changes = Vec::with_capacity(card_matches.len());
    for m in card_matches {
        let mut card = m.decoded_json.clone();
        let old = crate::metadata::json_pointer::set_json_pointer_string(&mut card, &tokens, value)
            .map_err(|error| {
                CardJsonEditError::Invalid(format!("{} payload: {}", m.label, error))
            })?;
        let old_value = old.as_ref().map(card_value_text);

        if !is_unchanged_string(old.as_ref(), value) {
            let compact = serde_json::to_string(&card).map_err(|error| {
                CardJsonEditError::Invalid(format!(
                    "{} payload: failed to serialize JSON: {}",
                    m.label, error
                ))
            })?;
            let replacement =
                encode_payload_with_encoding(&compact, &m.encoding).map_err(|error| {
                    CardJsonEditError::Invalid(format!("{} payload: {}", m.label, error))
                })?;
            let chunk = chunks.get_mut(m.chunk_index).ok_or_else(|| {
                CardJsonEditError::Invalid(format!(
                    "{} payload references a missing PNG chunk.",
                    m.label
                ))
            })?;
            chunk
                .data
                .splice(m.data_start..m.data_end, replacement.iter().copied());
        }

        changes.push(CardJsonChange {
            payload: m.label,
            old_value,
        });
    }

    Ok(CardJsonEdit {
        bytes: crate::metadata::image::build_png_bytes(&chunks),
        changes,
    })
}

/// Applies one JSON Pointer string set to a standalone character-card `.json`.
///
/// Parsing and serialization both happen on bytes; the caller writes through
/// the bulk engine's atomic writer. Existing formatting (compact vs indented,
/// trailing newline) is preserved, and an already-equal value leaves the file
/// byte-identical.
pub fn set_json_card_json_pointer(
    bytes: &[u8],
    pointer: &str,
    value: &str,
) -> Result<CardJsonEdit, CardJsonEditError> {
    let tokens = crate::metadata::json_pointer::parse_json_pointer(pointer)
        .map_err(CardJsonEditError::Invalid)?;
    let text = std::str::from_utf8(bytes).map_err(|_| {
        CardJsonEditError::Invalid(
            "Standalone character-card JSON must be valid UTF-8.".to_string(),
        )
    })?;
    let mut card: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| CardJsonEditError::Invalid(format!("Invalid JSON: {}", error)))?;
    ensure_supported_card_schema(&card, "Standalone")?;

    let old = crate::metadata::json_pointer::set_json_pointer_string(&mut card, &tokens, value)
        .map_err(CardJsonEditError::Invalid)?;
    let old_value = old.as_ref().map(card_value_text);

    let rewritten = if is_unchanged_string(old.as_ref(), value) {
        bytes.to_vec()
    } else {
        let indented = text.contains('\n');
        let serialized = if indented {
            serde_json::to_string_pretty(&card)
        } else {
            serde_json::to_string(&card)
        }
        .map_err(|error| {
            CardJsonEditError::Invalid(format!("Failed to serialize JSON: {}", error))
        })?;
        let mut out = serialized.into_bytes();
        if text.ends_with('\n') && !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        out
    };

    Ok(CardJsonEdit {
        bytes: rewritten,
        changes: vec![CardJsonChange {
            payload: "json".to_string(),
            old_value,
        }],
    })
}

/// Creates a new PNG character card by combining image data URL and card JSON.
/// The image must be a PNG data URL, typically produced by frontend canvas export.
pub fn create_png_character_card(file_path: &str, image_data_url: &str, json_text: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "png" {
        return Err("Output file must use .png extension".to_string());
    }

    let (compact_json_text, is_v3) = compact_card_json_payload(json_text)?;
    let data_url_prefix = "data:image/png;base64,";
    if !image_data_url.starts_with(data_url_prefix) {
        return Err("Image data must be a PNG data URL".to_string());
    }

    let encoded_png = &image_data_url[data_url_prefix.len()..];
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_png.as_bytes())
        .map_err(|e| format!("Failed to decode PNG data: {}", e))?;

    let mut chunks = parse_png_chunks(&png_bytes)?;
    upsert_card_chunk(&mut chunks, "chara", &compact_json_text)?;
    if is_v3 {
        upsert_card_chunk(&mut chunks, "ccv3", &compact_json_text)?;
    }
    let output_png = crate::metadata::image::build_png_bytes(&chunks);

    if path.exists() {
        crate::metadata::utils::write_with_backup(path, &output_png)
            .map_err(|e| format!("Failed to overwrite PNG file: {}", e))
    } else {
        fs::write(path, output_png).map_err(|e| format!("Failed to write PNG file: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::image::build_png_bytes;
    use crate::metadata::types::{Base64Encoding, JsonPayloadEncoding, PngChunk};

    fn make_text_chunk(keyword: &str, payload: &str) -> PngChunk {
        let mut data = Vec::new();
        data.extend_from_slice(keyword.as_bytes());
        data.push(0);
        data.extend_from_slice(payload.as_bytes());
        PngChunk {
            chunk_type: *b"tEXt",
            data,
        }
    }

    fn make_itxt_chunk(keyword: &str, text: &str) -> PngChunk {
        let mut data = Vec::new();
        data.extend_from_slice(keyword.as_bytes());
        data.push(0);
        data.push(0); // uncompressed
        data.push(0); // compression method 0
        data.push(0); // language tag
        data.push(0); // translated keyword
        data.extend_from_slice(text.as_bytes());
        PngChunk {
            chunk_type: *b"iTXt",
            data,
        }
    }

    fn make_ztxt_chunk(keyword: &str, text: &str) -> PngChunk {
        use std::io::Write;
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(text.as_bytes())
            .expect("zlib write should succeed");
        let compressed = encoder.finish().expect("zlib finish should succeed");

        let mut data = Vec::new();
        data.extend_from_slice(keyword.as_bytes());
        data.push(0);
        data.push(0); // compression method 0
        data.extend_from_slice(&compressed);
        PngChunk {
            chunk_type: *b"zTXt",
            data,
        }
    }

    fn png_from_chunks(mut body: Vec<PngChunk>) -> Vec<u8> {
        let mut chunks = vec![PngChunk {
            chunk_type: *b"IHDR",
            data: vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
        }];
        chunks.append(&mut body);
        chunks.push(PngChunk {
            chunk_type: *b"IDAT",
            data: vec![0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01],
        });
        chunks.push(PngChunk {
            chunk_type: *b"IEND",
            data: vec![],
        });
        build_png_bytes(&chunks)
    }

    fn itxt_text(chunk: &PngChunk) -> String {
        let zero = chunk
            .data
            .iter()
            .position(|byte| *byte == 0)
            .expect("iTXt should have a keyword separator");
        let mut idx = zero + 1;
        idx += 2; // compression flag + method
        for _ in 0..2 {
            idx += chunk.data[idx..]
                .iter()
                .position(|byte| *byte == 0)
                .expect("iTXt should have language and translated fields")
                + 1;
        }
        String::from_utf8(chunk.data[idx..].to_vec()).expect("iTXt text should be UTF-8")
    }

    fn ztxt_text(chunk: &PngChunk) -> String {
        let zero = chunk
            .data
            .iter()
            .position(|byte| *byte == 0)
            .expect("zTXt should have a keyword separator");
        use std::io::Read;
        let mut decoded = String::new();
        flate2::read::ZlibDecoder::new(&chunk.data[zero + 2..])
            .read_to_string(&mut decoded)
            .expect("zTXt payload should decompress");
        decoded
    }

    #[test]
    fn decode_json_payload_accepts_plaintext_structured_json() {
        let input = r#" {"a": 1, "b": [1,2]} "#;
        let decoded = decode_json_payload(input).expect("plaintext JSON should decode");
        assert!(decoded.0.is_object());
        assert!(matches!(decoded.1, JsonPayloadEncoding::PlainText));
        assert_eq!(decoded.2, "{\"a\": 1, \"b\": [1,2]}");
    }

    #[test]
    fn decode_base64_json_accepts_standard_and_urlsafe_encodings() {
        let source = r#"{"name":"tester"}"#;
        let standard = encode_base64_with_encoding(source, Base64Encoding::Standard);
        let urlsafe = encode_base64_with_encoding(source, Base64Encoding::UrlSafeNoPad);

        let standard_decoded = decode_base64_json(&standard).expect("standard base64 should decode");
        let urlsafe_decoded = decode_base64_json(&urlsafe).expect("urlsafe base64 should decode");

        assert!(standard_decoded.0.is_object());
        assert!(urlsafe_decoded.0.is_object());
    }

    #[test]
    fn decode_json_payload_rejects_scalar_json() {
        assert!(decode_json_payload("42").is_none());
        assert!(decode_json_payload("\"hello\"").is_none());
    }

    #[test]
    fn compact_card_json_payload_detects_v3_spec_and_compacts() {
        let (compact, is_v3) = compact_card_json_payload("{\n  \"spec\": \"chara_card_v3\", \"x\": 1\n}")
            .expect("valid card JSON should compact");

        assert_eq!(compact, "{\"spec\":\"chara_card_v3\",\"x\":1}");
        assert!(is_v3);
    }

    #[test]
    fn compact_card_json_payload_detects_v3_from_spec_version_prefix() {
        let (_compact, is_v3) = compact_card_json_payload("{\"spec_version\":\"3.1\"}")
            .expect("valid card JSON should parse");
        assert!(is_v3);
    }

    #[test]
    fn upsert_card_chunk_inserts_before_iend_when_missing() {
        let mut chunks = vec![
            PngChunk {
                chunk_type: *b"IHDR",
                data: vec![1, 2, 3],
            },
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ];

        upsert_card_chunk(&mut chunks, "chara", r#"{"name":"new"}"#)
            .expect("upsert should insert chara chunk");

        assert_eq!(chunks.len(), 3);
        assert_eq!(&chunks[1].chunk_type, b"tEXt");
        assert_eq!(&chunks[2].chunk_type, b"IEND");
    }

    #[test]
    fn upsert_card_chunk_updates_existing_payload_with_original_encoding() {
        let old_json = r#"{"name":"old"}"#;
        let old_payload = encode_base64_with_encoding(old_json, Base64Encoding::StandardNoPad);
        let mut chunks = vec![
            make_text_chunk("chara", &old_payload),
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ];

        upsert_card_chunk(&mut chunks, "chara", r#"{"name":"new"}"#)
            .expect("upsert should update payload");

        let text = String::from_utf8(chunks[0].data.clone()).expect("chunk data should be utf-8 text");
        let payload = text.split_once('\0').map(|(_, p)| p).unwrap_or("");
        let (value, encoding) = decode_base64_json(payload).expect("updated payload should decode");
        assert!(matches!(encoding, Base64Encoding::StandardNoPad));
        assert_eq!(value["name"], "new");
    }

    #[test]
    fn remove_card_chunks_removes_chara_and_character_aliases() {
        let json = encode_base64_with_encoding(r#"{"k":1}"#, Base64Encoding::Standard);
        let mut chunks = vec![
            make_text_chunk("character", &json),
            make_text_chunk("chara", &json),
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ];

        remove_card_chunks(&mut chunks, "chara").expect("remove should succeed");

        assert_eq!(chunks.len(), 1);
        assert_eq!(&chunks[0].chunk_type, b"IEND");
    }

    #[test]
    fn payload_format_name_maps_variants() {
        assert_eq!(payload_format_name(&JsonPayloadEncoding::PlainText), "plaintext");
        assert_eq!(
            payload_format_name(&JsonPayloadEncoding::Base64(Base64Encoding::Standard)),
            "base64"
        );
        assert_eq!(payload_format_name(&JsonPayloadEncoding::ZtxtCompressed), "zTXt-compressed");
    }
    fn v2_card(creator: &str) -> serde_json::Value {
        serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": { "name": "Card", "creator": creator, "tags": ["a", "b"] },
            "extensions": { "keep": true }
        })
    }

    fn v3_card(creator: &str) -> serde_json::Value {
        serde_json::json!({
            "spec": "chara_card_v3",
            "spec_version": "3.0",
            "data": { "name": "Card", "creator": creator, "tags": ["a", "b"] },
            "extensions": { "keep": true }
        })
    }

    fn png_with_cards(
        cards: &[(&str, &serde_json::Value, Base64Encoding)],
        extras: &[(&str, &str)],
    ) -> Vec<u8> {
        let mut chunks = vec![PngChunk {
            chunk_type: *b"IHDR",
            data: vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
        }];
        for (keyword, card, encoding) in cards {
            let text = serde_json::to_string(card).expect("card should serialize");
            let payload = encode_base64_with_encoding(&text, *encoding);
            chunks.push(make_text_chunk(keyword, &payload));
        }
        for (keyword, text) in extras {
            chunks.push(make_text_chunk(keyword, text));
        }
        chunks.push(PngChunk {
            chunk_type: *b"IDAT",
            data: vec![0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01],
        });
        chunks.push(PngChunk {
            chunk_type: *b"IEND",
            data: vec![],
        });
        build_png_bytes(&chunks)
    }

    fn raw_card_payload(bytes: &[u8], keyword: &str) -> String {
        let chunks = parse_png_chunks(bytes).expect("png should parse");
        let chunk = chunks
            .iter()
            .find(|chunk| {
                chunk.data.starts_with(format!("{}\0", keyword).as_bytes())
                    && (chunk.chunk_type == *b"tEXt" || chunk.chunk_type == *b"iTXt")
            })
            .expect("card chunk should exist");
        let zero = chunk
            .data
            .iter()
            .position(|byte| *byte == 0)
            .expect("chunk should have a keyword separator");
        let text =
            String::from_utf8(chunk.data[zero + 1..].to_vec()).expect("payload should be UTF-8");
        // iTXt has compression/language/translated fields before the text.
        if chunk.chunk_type == *b"iTXt" {
            let mut idx = 0;
            idx += 2;
            idx += text[idx..].find('\0').map(|pos| pos + 1).unwrap_or(0);
            idx += text[idx..].find('\0').map(|pos| pos + 1).unwrap_or(0);
            return text[idx..].to_string();
        }
        text
    }

    fn decode_card_chunk(bytes: &[u8], keyword: &str) -> (serde_json::Value, JsonPayloadEncoding) {
        let chunks = parse_png_chunks(bytes).expect("png should parse");
        let matches = find_embedded_json_matches(&chunks).expect("embedded JSON should parse");
        let found = matches
            .iter()
            .find(|m| m.label.eq_ignore_ascii_case(keyword))
            .expect("card payload should exist");
        let encoding = match &found.encoding {
            JsonPayloadEncoding::PlainText => JsonPayloadEncoding::PlainText,
            JsonPayloadEncoding::Base64(encoding) => JsonPayloadEncoding::Base64(*encoding),
            JsonPayloadEncoding::ZtxtCompressed => JsonPayloadEncoding::ZtxtCompressed,
        };
        (found.decoded_json.clone(), encoding)
    }

    #[test]
    fn json_path_updates_v2_png_author_and_preserves_encoding_and_other_chunks() {
        let original = png_with_cards(
            &[("chara", &v2_card("Old"), Base64Encoding::UrlSafeNoPad)],
            &[("Comment", "keep me")],
        );

        let edit = set_png_card_json_pointer(&original, "/data/creator", "New")
            .expect("author update should succeed");

        assert_eq!(edit.changes.len(), 1);
        assert_eq!(edit.changes[0].payload, "chara");
        assert_eq!(edit.changes[0].old_value.as_deref(), Some("Old"));

        let (card, _encoding) = decode_card_chunk(&edit.bytes, "chara");
        assert_eq!(card["data"]["creator"], "New");
        assert_eq!(card["data"]["name"], "Card");
        assert_eq!(card["data"]["tags"], serde_json::json!(["a", "b"]));
        assert_eq!(card["extensions"]["keep"], true);
        // The writer re-encodes with the encoding it read, so the raw payload
        // must still be URL-safe/no-pad base64 of the updated card. (The reader
        // cannot tell URL-safe from standard when the alphabet does not differ,
        // so compare bytes rather than the inferred variant.)
        assert_eq!(
            raw_card_payload(&edit.bytes, "chara"),
            encode_base64_with_encoding(
                &serde_json::to_string(&card).expect("card should serialize"),
                Base64Encoding::UrlSafeNoPad
            )
        );

        let original_chunks = parse_png_chunks(&original).expect("original png should parse");
        let updated_chunks = parse_png_chunks(&edit.bytes).expect("updated png should parse");
        let types = |chunks: &[PngChunk]| -> Vec<[u8; 4]> {
            chunks.iter().map(|chunk| chunk.chunk_type).collect()
        };
        assert_eq!(types(&updated_chunks), types(&original_chunks));
        let comment = |chunks: &[PngChunk]| -> Vec<u8> {
            chunks
                .iter()
                .find(|chunk| chunk.data.starts_with(b"Comment\0"))
                .expect("Comment chunk should exist")
                .data
                .clone()
        };
        assert_eq!(comment(&updated_chunks), comment(&original_chunks));
    }

    #[test]
    fn json_path_preserves_plaintext_itxt_and_ztxt_payloads() {
        let original_json = serde_json::to_string(&v2_card("Old")).expect("card should serialize");

        let plain = png_from_chunks(vec![make_itxt_chunk("chara", &original_json)]);
        let edit = set_png_card_json_pointer(&plain, "/data/creator", "New")
            .expect("iTXt update should succeed");
        let (card, encoding) = decode_card_chunk(&edit.bytes, "chara");
        assert_eq!(card["data"]["creator"], "New");
        assert!(matches!(encoding, JsonPayloadEncoding::PlainText));
        let chunks = parse_png_chunks(&edit.bytes).expect("updated png should parse");
        let itxt = chunks
            .iter()
            .find(|chunk| chunk.chunk_type == *b"iTXt")
            .expect("iTXt chunk should survive");
        let updated: serde_json::Value = serde_json::from_str(&itxt_text(itxt))
            .expect("iTXt must stay plaintext JSON, not base64");
        assert_eq!(updated["data"]["creator"], "New");
        assert_eq!(updated["data"]["name"], "Card");

        let compressed = png_from_chunks(vec![make_ztxt_chunk("chara", &original_json)]);
        let edit = set_png_card_json_pointer(&compressed, "/data/creator", "New")
            .expect("zTXt update should succeed");
        let (card, encoding) = decode_card_chunk(&edit.bytes, "chara");
        assert_eq!(card["data"]["creator"], "New");
        assert!(matches!(encoding, JsonPayloadEncoding::ZtxtCompressed));
        let chunks = parse_png_chunks(&edit.bytes).expect("updated png should parse");
        let ztxt = chunks
            .iter()
            .find(|chunk| chunk.chunk_type == *b"zTXt")
            .expect("zTXt chunk should survive");
        let updated: serde_json::Value =
            serde_json::from_str(&ztxt_text(ztxt)).expect("zTXt payload should still be JSON");
        assert_eq!(updated["data"]["creator"], "New");
    }

    #[test]
    fn json_path_updates_v3_chara_and_ccv3_consistently() {
        let original = png_with_cards(
            &[
                ("chara", &v3_card("Old"), Base64Encoding::UrlSafeNoPad),
                ("ccv3", &v3_card("Old"), Base64Encoding::Standard),
            ],
            &[],
        );

        let edit = set_png_card_json_pointer(&original, "/data/creator", "New")
            .expect("v3 author update should succeed");

        let payloads: Vec<&str> = edit
            .changes
            .iter()
            .map(|change| change.payload.as_str())
            .collect();
        assert_eq!(payloads, vec!["chara", "ccv3"]);
        assert!(edit
            .changes
            .iter()
            .all(|change| change.old_value.as_deref() == Some("Old")));

        let (chara, _chara_encoding) = decode_card_chunk(&edit.bytes, "chara");
        let (ccv3, ccv3_encoding) = decode_card_chunk(&edit.bytes, "ccv3");
        assert_eq!(chara["data"]["creator"], "New");
        assert_eq!(ccv3["data"]["creator"], "New");
        assert_eq!(chara["spec"], "chara_card_v3");
        assert_eq!(ccv3["spec"], "chara_card_v3");
        // Each payload keeps its own encoding: chara stays URL-safe/no-pad,
        // ccv3 stays padded standard (padding makes the reader's inference exact).
        assert_eq!(
            raw_card_payload(&edit.bytes, "chara"),
            encode_base64_with_encoding(
                &serde_json::to_string(&chara).expect("card should serialize"),
                Base64Encoding::UrlSafeNoPad
            )
        );
        assert!(matches!(
            ccv3_encoding,
            JsonPayloadEncoding::Base64(Base64Encoding::Standard)
        ));
        assert_eq!(
            raw_card_payload(&edit.bytes, "ccv3"),
            encode_base64_with_encoding(
                &serde_json::to_string(&ccv3).expect("card should serialize"),
                Base64Encoding::Standard
            )
        );

        let noop = set_png_card_json_pointer(&edit.bytes, "/data/creator", "New")
            .expect("second author update should succeed");
        assert!(noop
            .changes
            .iter()
            .all(|change| change.old_value.as_deref() == Some("New")));
        assert_eq!(
            noop.bytes, edit.bytes,
            "an unchanged value must not re-encode payloads"
        );
    }

    #[test]
    fn json_path_rejects_v1_and_non_card_payloads() {
        let v1 = serde_json::json!({
            "spec": "chara_card_v1",
            "name": "Legacy",
            "creator": "Old"
        });
        let original = png_with_cards(&[("chara", &v1, Base64Encoding::Standard)], &[]);
        let error = set_png_card_json_pointer(&original, "/data/creator", "New")
            .expect_err("v1 must be unsupported");
        assert!(matches!(error, CardJsonEditError::Unsupported(_)));
        assert!(
            error.message().contains("v1"),
            "unexpected error: {}",
            error.message()
        );

        let plain = serde_json::json!({ "name": "Not a card" });
        let original = png_with_cards(&[("chara", &plain, Base64Encoding::Standard)], &[]);
        let error = set_png_card_json_pointer(&original, "/data/creator", "New")
            .expect_err("plain JSON must be unsupported");
        assert!(matches!(error, CardJsonEditError::Unsupported(_)));
        assert!(
            error.message().contains("chara_card_v2/v3"),
            "unexpected error: {}",
            error.message()
        );

        let original = build_png_bytes(&[
            PngChunk {
                chunk_type: *b"IHDR",
                data: vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
            },
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ]);
        let error = set_png_card_json_pointer(&original, "/data/creator", "New")
            .expect_err("a PNG without card payloads must be rejected");
        assert!(matches!(error, CardJsonEditError::Invalid(_)));
        assert!(
            error.message().contains("No decodable character-card"),
            "unexpected error: {}",
            error.message()
        );
    }

    #[test]
    fn card_json_pointer_discovery_lists_scalars_and_escapes_tokens() {
        let card = serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "creator": "Old",
                "weird/key": { "tilde~key": "Old" },
                "count": 3,
                "flag": true,
                "nothing": null,
                "tags": ["a", 2],
                "empty": {},
                "gap": []
            }
        });

        let expected = vec![
            ("/data/count".to_string(), "3".to_string()),
            ("/data/creator".to_string(), "Old".to_string()),
            ("/data/flag".to_string(), "true".to_string()),
            ("/data/nothing".to_string(), "null".to_string()),
            ("/data/tags/0".to_string(), "a".to_string()),
            ("/data/tags/1".to_string(), "2".to_string()),
            ("/data/weird~1key/tilde~0key".to_string(), "Old".to_string()),
            ("/spec".to_string(), "chara_card_v2".to_string()),
            ("/spec_version".to_string(), "2.0".to_string()),
        ];

        let text = serde_json::to_string(&card).expect("card should serialize");
        assert_eq!(
            read_json_card_json_pointers(text.as_bytes()).expect("standalone discovery"),
            expected
        );

        let png = png_with_cards(&[("chara", &card, Base64Encoding::Standard)], &[]);
        assert_eq!(
            read_png_card_json_pointers(&png).expect("png discovery"),
            expected
        );

        // Empty objects/arrays and container pointers are not emitted.
        assert!(read_json_card_json_pointers(text.as_bytes())
            .expect("standalone discovery")
            .iter()
            .all(|(pointer, _)| pointer != "/data" && pointer != "/data/empty" && pointer != "/data/gap"));
    }

    #[test]
    fn v3_png_discovery_deduplicates_chara_and_ccv3() {
        let png = png_with_cards(
            &[
                ("chara", &v3_card("Old"), Base64Encoding::UrlSafeNoPad),
                ("ccv3", &v3_card("Old"), Base64Encoding::Standard),
            ],
            &[],
        );

        let fields = read_png_card_json_pointers(&png).expect("v3 discovery should succeed");
        let creator: Vec<&(String, String)> = fields
            .iter()
            .filter(|(pointer, _)| pointer == "/data/creator")
            .collect();
        assert_eq!(creator, vec![&("/data/creator".to_string(), "Old".to_string())]);

        let mut pointers: Vec<&str> = fields.iter().map(|(pointer, _)| pointer.as_str()).collect();
        let unique = pointers.len();
        pointers.sort_unstable();
        pointers.dedup();
        assert_eq!(pointers.len(), unique, "pointers must be deduplicated");
        assert!(pointers.contains(&"/data/creator"));
        assert!(pointers.contains(&"/data/name"));
        assert!(pointers.contains(&"/extensions/keep"));
    }

    #[test]
    fn card_json_pointer_discovery_rejects_unsupported_payloads() {
        let v1 = serde_json::json!({ "spec": "chara_card_v1", "name": "Legacy", "creator": "Old" });
        let v1_text = serde_json::to_string(&v1).expect("v1 card should serialize");
        let error = read_json_card_json_pointers(v1_text.as_bytes())
            .expect_err("v1 standalone JSON must be unsupported");
        assert!(error.contains("v1"), "unexpected error: {}", error);

        let png = png_with_cards(&[("chara", &v1, Base64Encoding::Standard)], &[]);
        let error = read_png_card_json_pointers(&png).expect_err("v1 PNG must be unsupported");
        assert!(error.contains("v1"), "unexpected error: {}", error);

        let plain = serde_json::json!({ "name": "Not a card" });
        let error = read_json_card_json_pointers(
            serde_json::to_string(&plain)
                .expect("json should serialize")
                .as_bytes(),
        )
        .expect_err("unknown schema must be unsupported");
        assert!(
            error.contains("chara_card_v2/v3"),
            "unexpected error: {}",
            error
        );

        let no_card = build_png_bytes(&[
            PngChunk {
                chunk_type: *b"IHDR",
                data: vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
            },
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ]);
        let error = read_png_card_json_pointers(&no_card)
            .expect_err("a PNG without card payloads must be reported");
        assert!(
            error.contains("No decodable character-card"),
            "unexpected error: {}",
            error
        );

        let error = read_json_card_json_pointers(b"{not json").expect_err("invalid JSON must fail");
        assert!(error.contains("Invalid JSON"), "unexpected error: {}", error);
        let error = read_json_card_json_pointers(&[0xff, 0xfe]).expect_err("non-UTF-8 must fail");
        assert!(error.contains("UTF-8"), "unexpected error: {}", error);
    }

    #[test]
    fn json_path_sets_escaped_tokens_and_reports_a_missing_leaf() {
        let card = serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": "Card",
                "weird/key": { "tilde~key": "Old" }
            }
        });
        let text = serde_json::to_string(&card).expect("card should serialize");

        let edit =
            set_json_card_json_pointer(text.as_bytes(), "/data/weird~1key/tilde~0key", "New")
                .expect("escaped pointer should resolve");
        assert_eq!(edit.changes[0].payload, "json");
        assert_eq!(edit.changes[0].old_value.as_deref(), Some("Old"));
        let updated: serde_json::Value =
            serde_json::from_slice(&edit.bytes).expect("rewritten JSON should parse");
        assert_eq!(updated["data"]["weird/key"]["tilde~key"], "New");

        let edit = set_json_card_json_pointer(&edit.bytes, "/data/new_field", "Added")
            .expect("a missing leaf in an existing object should be addable");
        assert_eq!(edit.changes[0].old_value, None);
        let updated: serde_json::Value =
            serde_json::from_slice(&edit.bytes).expect("rewritten JSON should parse");
        assert_eq!(updated["data"]["new_field"], "Added");
    }

    #[test]
    fn json_path_rejects_missing_parents_array_append_and_invalid_json() {
        let card = serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": { "creator": "Old", "tags": ["a"] }
        });
        let text = serde_json::to_string(&card).expect("card should serialize");

        let cases = [
            ("/data/missing/child", "missing parent"),
            ("/data/tags/1", "out of range"),
            ("/data/tags/-", "append"),
            ("/data/tags/01", "leading zeros"),
            ("data/creator", "start with '/'"),
            ("/data/creator~2", "escape"),
        ];
        for (pointer, needle) in cases {
            let error = set_json_card_json_pointer(text.as_bytes(), pointer, "New")
                .expect_err("invalid pointer must be rejected");
            assert!(matches!(error, CardJsonEditError::Invalid(_)));
            assert!(
                error.message().to_lowercase().contains(needle),
                "pointer {:?}: {}",
                pointer,
                error.message()
            );
        }

        let error = set_json_card_json_pointer(b"{not json", "/data/creator", "New")
            .expect_err("invalid JSON must be rejected");
        assert!(matches!(error, CardJsonEditError::Invalid(_)));
        assert!(error.message().contains("Invalid JSON"));

        let v1 = serde_json::json!({ "spec": "chara_card_v1", "creator": "Old" });
        let v1_text = serde_json::to_string(&v1).expect("v1 card should serialize");
        let error = set_json_card_json_pointer(v1_text.as_bytes(), "/data/creator", "New")
            .expect_err("v1 JSON must be unsupported");
        assert!(matches!(error, CardJsonEditError::Unsupported(_)));
    }

    #[test]
    fn json_path_noop_preserves_standalone_formatting() {
        let text = "{\n  \"spec\": \"chara_card_v2\",\n  \"spec_version\": \"2.0\",\n  \"data\": {\n    \"creator\": \"Same\"\n  }\n}\n";

        let noop = set_json_card_json_pointer(text.as_bytes(), "/data/creator", "Same")
            .expect("equal value should plan as a change-free edit");
        assert_eq!(noop.changes[0].old_value.as_deref(), Some("Same"));
        assert_eq!(String::from_utf8(noop.bytes).expect("utf-8"), text);

        let edit = set_json_card_json_pointer(text.as_bytes(), "/data/creator", "New")
            .expect("value change should succeed");
        let rewritten = String::from_utf8(edit.bytes).expect("utf-8");
        assert!(rewritten.ends_with("}\n"), "trailing newline must survive");
        assert!(
            rewritten.contains("\n  "),
            "indented formatting must survive"
        );
        let value: serde_json::Value =
            serde_json::from_str(&rewritten).expect("rewritten JSON should parse");
        assert_eq!(value["data"]["creator"], "New");
    }

    #[test]
    fn card_json_plans_and_applies_mixed_cards_and_json_files() {
        use crate::bulk_edit::test_support::{cleanup_dir, unique_dir, write_binary, write_file};
        use crate::bulk_edit::{
            apply_plan, default_registry, plan_request, BulkPlan, BulkPlanRequest, FsWriter,
            MemoryJournal, OperationKind, OperationParams, PlanFileStatus,
        };

        let dir = unique_dir("card-json-e2e");
        let v2_png = write_binary(
            &dir,
            "v2.png",
            &png_with_cards(&[("chara", &v2_card("Old"), Base64Encoding::Standard)], &[]),
        );
        let v3_png = write_binary(
            &dir,
            "v3.png",
            &png_with_cards(
                &[
                    ("chara", &v3_card("Old"), Base64Encoding::UrlSafeNoPad),
                    ("ccv3", &v3_card("Old"), Base64Encoding::Standard),
                ],
                &[],
            ),
        );
        let standalone = write_file(
            &dir,
            "v2.json",
            &serde_json::to_string_pretty(&v2_card("Old")).expect("card should serialize"),
        );
        let v1_png = write_binary(
            &dir,
            "v1.png",
            &png_with_cards(
                &[(
                    "chara",
                    &serde_json::json!({ "spec": "chara_card_v1", "data": { "creator": "Old" } }),
                    Base64Encoding::Standard,
                )],
                &[],
            ),
        );

        let request = BulkPlanRequest {
            paths: vec![
                v2_png.clone(),
                v3_png.clone(),
                standalone.clone(),
                v1_png.clone(),
            ],
            params: OperationParams {
                operation: OperationKind::JsonSetPath,
                locator: "/data/creator".to_string(),
                value: "New".to_string(),
            },
        };

        let plan = plan_request(&request, &default_registry()).expect("plan should succeed");
        let row = |plan: &BulkPlan, path: &str| {
            plan.files
                .iter()
                .find(|file| file.file == path)
                .expect("plan should contain the file")
                .clone()
        };
        assert_eq!(row(&plan, &v2_png).status, PlanFileStatus::Changed);
        assert_eq!(row(&plan, &v3_png).status, PlanFileStatus::Changed);
        assert_eq!(row(&plan, &standalone).status, PlanFileStatus::Changed);
        assert_eq!(row(&plan, &v1_png).status, PlanFileStatus::Unsupported);
        assert_eq!(
            row(&plan, &v2_png).changes[0].locator,
            "chara:/data/creator"
        );
        assert_eq!(row(&plan, &standalone).changes[0].locator, "/data/creator");
        assert_eq!(row(&plan, &v3_png).changes.len(), 2);

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &default_registry(), &FsWriter, &mut journal)
            .expect("apply should replay the plan");
        assert_eq!(result.applied, 3);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(journal.entries().len(), 3);

        let v2_bytes = fs::read(&v2_png).expect("v2 should be readable");
        assert_eq!(
            decode_card_chunk(&v2_bytes, "chara").0["data"]["creator"],
            "New"
        );
        let v3_bytes = fs::read(&v3_png).expect("v3 should be readable");
        assert_eq!(
            decode_card_chunk(&v3_bytes, "chara").0["data"]["creator"],
            "New"
        );
        assert_eq!(
            decode_card_chunk(&v3_bytes, "ccv3").0["data"]["creator"],
            "New"
        );
        let standalone_value: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&standalone).expect("standalone should be readable"),
        )
        .expect("standalone JSON should parse");
        assert_eq!(standalone_value["data"]["creator"], "New");
        assert_eq!(
            standalone_value["data"]["name"], "Card",
            "unrelated card fields must survive"
        );
        let v1_bytes = fs::read(&v1_png).expect("v1 should be readable");
        assert_eq!(
            decode_card_chunk(&v1_bytes, "chara").0["data"]["creator"],
            "Old",
            "an unsupported v1 card must not be written"
        );

        let second = plan_request(&request, &default_registry()).expect("replan should succeed");
        for path in [&v2_png, &v3_png, &standalone] {
            let planned = row(&second, path);
            assert_eq!(
                planned.status,
                PlanFileStatus::Noop,
                "{} must replan as noop",
                path
            );
            assert!(planned
                .changes
                .iter()
                .all(|change| change.old_value == change.new_value));
        }

        cleanup_dir(&dir);
    }

    #[test]
    fn json_path_errors_and_stale_content_leave_files_unchanged() {
        use crate::bulk_edit::test_support::{cleanup_dir, unique_dir, write_file};
        use crate::bulk_edit::{
            apply_plan, default_registry, plan_request, BulkPlanRequest, FsWriter, MemoryJournal,
            OperationKind, OperationParams, PlanFileStatus,
        };

        let dir = unique_dir("card-json-errors");
        let path = write_file(
            &dir,
            "card.json",
            &serde_json::to_string(&v2_card("Old")).expect("card should serialize"),
        );
        let original = fs::read(&path).expect("file should be readable");

        let bad_pointer = BulkPlanRequest {
            paths: vec![path.clone()],
            params: OperationParams {
                operation: OperationKind::JsonSetPath,
                locator: "/data/missing/child".to_string(),
                value: "New".to_string(),
            },
        };
        let plan = plan_request(&bad_pointer, &default_registry()).expect("plan should succeed");
        assert_eq!(plan.files[0].status, PlanFileStatus::Error);
        assert!(plan.files[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("Missing parent"));

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &default_registry(), &FsWriter, &mut journal)
            .expect("apply should replay the rejected row");
        assert_eq!(result.applied, 0);
        assert_eq!(result.failed, 1);
        assert_eq!(fs::read(&path).expect("file should be readable"), original);
        assert!(journal.entries().is_empty());

        let good = BulkPlanRequest {
            paths: vec![path.clone()],
            params: OperationParams {
                operation: OperationKind::JsonSetPath,
                locator: "/data/creator".to_string(),
                value: "New".to_string(),
            },
        };
        let plan = plan_request(&good, &default_registry()).expect("plan should succeed");
        fs::write(
            &path,
            b"{\"spec\":\"chara_card_v2\",\"data\":{\"creator\":\"Changed\"}}",
        )
        .expect("tamper should succeed");

        let result = apply_plan(&plan, &default_registry(), &FsWriter, &mut journal)
            .expect("apply should replay the stale row");
        assert_eq!(result.applied, 0);
        assert_eq!(result.failed, 1);
        assert!(result.results[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("stale_content"));
        assert_eq!(
            fs::read(&path).expect("file should be readable"),
            b"{\"spec\":\"chara_card_v2\",\"data\":{\"creator\":\"Changed\"}}",
            "stale content must be reported, never overwritten"
        );

        cleanup_dir(&dir);
    }
}
