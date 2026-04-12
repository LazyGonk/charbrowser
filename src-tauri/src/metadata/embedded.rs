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
}
