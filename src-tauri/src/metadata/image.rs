use crate::metadata::types::{EmbeddedJsonMatch, FileMetadata, TextEntry, PngChunk};
use image::GenericImageView;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::str;

pub struct FlacBlock<'a> {
    pub block_type: u8,
    pub data: &'a [u8],
}

pub struct FlacBlockIterator<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Iterator for FlacBlockIterator<'a> {
    type Item = FlacBlock<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos + 4 > self.bytes.len() {
            return None;
        }
        let block_header = &self.bytes[self.pos..self.pos + 4];
        let block_type = block_header[0] & 0x7F;
        let block_len = crate::metadata::utils::synchsafe_24_to_u32(&block_header[1..4]) as usize;

        let data_start = self.pos + 4;
        let data_end = data_start + block_len;

        if data_end > self.bytes.len() {
            return None;
        }

        let data = &self.bytes[data_start..data_end];
        self.pos = data_end;

        Some(FlacBlock { block_type, data })
    }
}

pub fn iter_flac_blocks<'a>(bytes: &'a [u8], start_offset: usize) -> FlacBlockIterator<'a> {
    FlacBlockIterator { bytes, pos: start_offset }
}

/// Extracts image metadata and optional format-specific blocks (EXIF/PNG chunks).
pub fn extract_image_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let img = image::open(path).map_err(|e| format!("Failed to open image: {}", e))?;

    let (width, height) = img.dimensions();
    let color_type = format!("{:?}", img.color());

    let mut format_specific = serde_json::Map::new();
    format_specific.insert("color_type".to_string(), serde_json::json!(color_type));

    if let Some(exif_data) = extract_exif_metadata(path) {
        format_specific.insert("exif".to_string(), exif_data);
    }

    let is_png = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
        || {
            std::fs::read(path)
                .ok()
                .map(|b| b.len() >= 4 && b.starts_with(&[0x89, 0x50, 0x4E, 0x47]))
                .unwrap_or(false)
        };

    if is_png {
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

pub fn extract_exif_metadata(path: &Path) -> Option<serde_json::Value> {
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

pub fn extract_png_chunks(path: &Path) -> Result<serde_json::Value, String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open PNG file: {}", e))?;

    let decoder = png::Decoder::new(file);
    let reader = decoder
        .read_info()
        .map_err(|e| format!("Failed to read PNG info: {}", e))?;

    let info = reader.info();

    let mut chunks = serde_json::Map::new();
    chunks.insert("bit_depth".to_string(), serde_json::json!(info.bit_depth as u8));
    chunks.insert("color_type".to_string(), serde_json::json!(format!("{:?}", info.color_type)));
    chunks.insert("compression".to_string(), serde_json::json!(format!("{:?}", info.compression)));
    chunks.insert("interlaced".to_string(), serde_json::json!(format!("{:?}", info.interlaced)));

    Ok(serde_json::Value::Object(chunks))
}

/// Generates a PNG thumbnail data URL for one image file.
pub fn generate_thumbnail(file_path: &str, max_size: u32) -> Result<String, String> {
    let path = Path::new(file_path);

    // Try to open the image - the image crate will handle format detection
    let img = image::open(path).map_err(|e| format!("Failed to open image: {}", e))?;

    let thumbnail = img.thumbnail(max_size, max_size);

    let mut buffer = Vec::new();
    thumbnail
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;

    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buffer)
    ))
}

pub fn parse_png_chunks(bytes: &[u8]) -> Result<Vec<PngChunk>, String> {
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

        offset += 4;

        let is_iend = &chunk_type == b"IEND";
        chunks.push(PngChunk { chunk_type, data });
        if is_iend {
            break;
        }
    }

    Ok(chunks)
}

pub fn build_png_bytes(chunks: &[PngChunk]) -> Vec<u8> {
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

pub fn find_embedded_json_matches(chunks: &[PngChunk]) -> Result<Vec<EmbeddedJsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let chunk_type = String::from_utf8_lossy(&chunk.chunk_type).to_string();

        if &chunk.chunk_type == b"tEXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                if let Ok(text) = str::from_utf8(&chunk.data[zero_pos + 1..]) {
                    if let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(text) {
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
                        if let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(text) {
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
                    if let Some((value, _encoding, payload)) = crate::metadata::embedded::decode_json_payload(&text) {
                        matches.push(EmbeddedJsonMatch {
                            id: next_id,
                            chunk_index,
                            data_start: compressed_start,
                            data_end: chunk.data.len(),
                            chunk_type: chunk_type.clone(),
                            label: keyword,
                            payload,
                            decoded_json: value,
                            encoding: crate::metadata::types::JsonPayloadEncoding::ZtxtCompressed,
                        });
                        next_id += 1;
                    }
                }
            }
            continue;
        }

        if let Ok(text) = str::from_utf8(&chunk.data) {
            if let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(text) {
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

pub fn png_has_embedded_json(chunks: &[PngChunk]) -> Result<bool, String> {
    for chunk in chunks {
        if &chunk.chunk_type == b"tEXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                if let Ok(text) = str::from_utf8(&chunk.data[zero_pos + 1..]) {
                    if crate::metadata::embedded::decode_json_payload(text).is_some() {
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
                        if crate::metadata::embedded::decode_json_payload(text).is_some() {
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
                if decoder.read_to_string(&mut text).is_ok()
                    && crate::metadata::embedded::decode_json_payload(&text).is_some()
                {
                    return Ok(true);
                }
            }
            continue;
        }

        if let Ok(text) = str::from_utf8(&chunk.data) {
            if crate::metadata::embedded::decode_json_payload(text).is_some() {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

pub fn find_plaintext_entries(chunks: &[PngChunk]) -> Vec<TextEntry> {
    let mut entries = Vec::new();
    let mut next_id = 0usize;

    for (_chunk_index, chunk) in chunks.iter().enumerate() {
        let chunk_type = String::from_utf8_lossy(&chunk.chunk_type).to_string();

        if &chunk.chunk_type == b"tEXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                if let Ok(text) = str::from_utf8(&chunk.data[zero_pos + 1..]) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('{') && !trimmed.starts_with('[') {
                        entries.push(TextEntry {
                            id: next_id,
                            chunk_type: chunk_type.clone(),
                            label: keyword,
                            text: trimmed.to_string(),
                        });
                        next_id += 1;
                    }
                }
            }
        } else if &chunk.chunk_type == b"iTXt" {
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
                if compression_flag == 0 && idx < chunk.data.len() {
                    if let Ok(text) = str::from_utf8(&chunk.data[idx..]) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            entries.push(TextEntry {
                                id: next_id,
                                chunk_type: chunk_type.clone(),
                                label: keyword,
                                text: trimmed.to_string(),
                            });
                            next_id += 1;
                        }
                    }
                }
            }
        } else if &chunk.chunk_type == b"zTXt" {
            if let Some(zero_pos) = chunk.data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&chunk.data[..zero_pos]).to_string();
                let comp_index = zero_pos + 1;
                if comp_index >= chunk.data.len() {
                    continue;
                }
                let comp_method = chunk.data[comp_index];
                let comp_start = comp_index + 1;
                if comp_method != 0 || comp_start > chunk.data.len() {
                    continue;
                }
                let compressed_bytes = &chunk.data[comp_start..];
                let mut decoder = flate2::read::ZlibDecoder::new(compressed_bytes);
                let mut text = String::new();
                if decoder.read_to_string(&mut text).is_ok() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('{') && !trimmed.starts_with('[') {
                        entries.push(TextEntry {
                            id: next_id,
                            chunk_type: chunk_type.clone(),
                            label: keyword,
                            text: trimmed.to_string(),
                        });
                        next_id += 1;
                    }
                }
            }
        }
    }

    entries
}
