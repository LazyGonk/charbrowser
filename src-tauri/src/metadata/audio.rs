use crate::metadata::embedded::{decode_json_payload, encode_payload_with_encoding};
use crate::metadata::types::FileMetadata;
use crate::metadata::types::{FlacJsonMatch, FlacVorbisComment, Mp3FrameKind, Mp3JsonMatch};
use crate::metadata::utils::build_backup_path;
use crate::metadata::utils::{synchsafe_to_u32, u32_to_synchsafe};
use crate::metadata::utils::{
    write_with_backup, FLAC_BLOCK_TYPE_PICTURE, FLAC_BLOCK_TYPE_VORBIS_COMMENT,
};
use base64::Engine;
use id3::frame::{Comment, Content, ExtendedText, Frame, Lyrics};
use id3::TagLike;
use std::fs;
use std::path::Path;

fn read_m4a_duration(path: &Path) -> Option<f64> {
    let bytes = std::fs::read(path).ok()?;
    let mut atoms = Vec::new();
    crate::metadata::video::parse_mp4_atoms(&bytes, 0, bytes.len(), None, &mut atoms).ok()?;

    let mvhd = atoms.iter().find(|atom| atom.atom_type == *b"mvhd")?;
    if mvhd.end > bytes.len() || mvhd.data_start + 4 > mvhd.end {
        return None;
    }

    let mvhd_data = &bytes[mvhd.data_start..mvhd.end];
    let version = mvhd_data[0];

    let (timescale, duration) = if version == 1 {
        if mvhd_data.len() < 32 {
            return None;
        }
        let timescale = u32::from_be_bytes(mvhd_data[20..24].try_into().ok()?);
        let duration = u64::from_be_bytes(mvhd_data[24..32].try_into().ok()?);
        (timescale, duration)
    } else {
        if mvhd_data.len() < 20 {
            return None;
        }
        let timescale = u32::from_be_bytes(mvhd_data[12..16].try_into().ok()?);
        let duration = u32::from_be_bytes(mvhd_data[16..20].try_into().ok()?) as u64;
        (timescale, duration)
    };

    if timescale == 0 {
        return None;
    }

    Some(duration as f64 / timescale as f64)
}

fn parse_flac_streaminfo(bytes: &[u8]) -> Option<(u32, u16, u64)> {
    if bytes.len() < 4 || &bytes[0..4] != b"fLaC" {
        return None;
    }

    for block in crate::metadata::image::iter_flac_blocks(bytes, 4) {
        if block.block_type != 0 {
            continue;
        }

        if block.data.len() < 18 {
            return None;
        }

        let packed = u64::from_be_bytes(block.data[10..18].try_into().ok()?);
        let sample_rate = ((packed >> 44) & 0x000F_FFFF) as u32;
        let channels = (((packed >> 41) & 0x0000_0007) as u16) + 1;
        let total_samples = packed & 0x0000_01FF_FFFF_FFFF;

        if sample_rate == 0 {
            return None;
        }

        return Some((sample_rate, channels, total_samples));
    }

    None
}

/// Extracts baseline audio metadata and common tag fields.
pub fn extract_audio_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    if ext == "m4a" {
        format_specific.insert("format".to_string(), serde_json::json!("M4A"));
    }

    if ext == "mp3" {
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
                if let Some(track) = tag.track() {
                    format_specific.insert("track".to_string(), serde_json::json!(track));
                }
                if let Some(album_artist) = tag.album_artist() {
                    format_specific
                        .insert("album_artist".to_string(), serde_json::json!(album_artist));
                }
                if let Some(comment) = tag.comments().next() {
                    format_specific.insert(
                        "comment".to_string(),
                        serde_json::json!(comment.text.clone()),
                    );
                }

                // Extract plain text lyrics (not JSON-encoded)
                for frame in tag.frames() {
                    if let id3::Content::Lyrics(lyrics) = frame.content() {
                        if !lyrics.text.trim().is_empty()
                            && decode_json_payload(&lyrics.text).is_none()
                        {
                            format_specific.insert(
                                "lyrics".to_string(),
                                serde_json::json!(lyrics.text.clone()),
                            );
                            break; // Only first lyrics frame
                        }
                    }
                }

                for frame in tag.frames() {
                    let id = frame.id().to_lowercase();
                    if format_specific.contains_key(&id) {
                        continue;
                    }
                    if let Some(text) = frame.content().text() {
                        format_specific.insert(id, serde_json::json!(text));
                        continue;
                    }
                    if let Some(val) = frame.content().extended_text() {
                        format_specific.insert(id, serde_json::json!(val.value.clone()));
                        continue;
                    }
                    if let Some(val) = frame.content().comment() {
                        format_specific.insert(id, serde_json::json!(val.text.clone()));
                        continue;
                    }
                }

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

    if ext == "m4a" {
        return Ok(FileMetadata {
            file_name,
            file_path,
            file_size,
            modified_timestamp,
            file_type: "Audio".to_string(),
            width: None,
            height: None,
            duration: read_m4a_duration(path),
            bit_rate: None,
            sample_rate: None,
            channels: None,
            format_specific: serde_json::Value::Object(format_specific),
        });
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

/// Updates editable MP3 ID3 fields using the existing id3 crate write path.
pub fn update_mp3_metadata_fields(
    path: &Path,
    updates: &std::collections::HashMap<String, String>,
) -> Result<usize, String> {
    let mut tag =
        id3::Tag::read_from_path(path).map_err(|e| format!("Failed to read ID3 tag: {}", e))?;

    let mut applied = 0usize;
    for (raw_key, raw_value) in updates {
        let key = raw_key.trim().to_lowercase();
        let value = raw_value.trim().to_string();

        match key.as_str() {
            "title" => {
                tag.set_title(value);
                applied += 1;
            }
            "artist" => {
                tag.set_artist(value);
                applied += 1;
            }
            "album" => {
                tag.set_album(value);
                applied += 1;
            }
            "album_artist" => {
                tag.set_album_artist(value);
                applied += 1;
            }
            "genre" => {
                tag.set_genre(value);
                applied += 1;
            }
            "track" => {
                let parsed = value
                    .parse::<u32>()
                    .map_err(|_| format!("Invalid numeric track value: {}", raw_value))?;
                tag.set_track(parsed);
                applied += 1;
            }
            "year" => {
                let parsed = value
                    .parse::<i32>()
                    .map_err(|_| format!("Invalid numeric year value: {}", raw_value))?;
                tag.set_year(parsed);
                applied += 1;
            }
            "comment" => {
                tag.add_frame(Frame::with_content(
                    "COMM",
                    Content::Comment(Comment {
                        lang: "eng".to_string(),
                        description: "".to_string(),
                        text: value,
                    }),
                ));
                applied += 1;
            }
            _ => {
                // Allow direct edit for plain text frame IDs shown in the metadata list.
                let frame_id = raw_key.trim().to_uppercase();
                if frame_id.len() == 4 && frame_id.chars().all(|c| c.is_ascii_alphanumeric()) {
                    tag.add_frame(Frame::with_content(frame_id, Content::Text(value)));
                    applied += 1;
                }
            }
        }
    }

    if applied == 0 {
        return Err("No supported MP3 metadata fields were provided.".to_string());
    }

    let backup_path = build_backup_path(path);
    fs::copy(path, &backup_path)
        .map_err(|e| format!("Failed to create backup before write: {}", e))?;

    if let Err(e) = tag.write_to_path(path, id3::Version::Id3v24) {
        let _ = fs::copy(&backup_path, path);
        let _ = fs::remove_file(&backup_path);
        return Err(format!("Failed to write ID3 tag: {}", e));
    }

    let _ = fs::remove_file(&backup_path);
    Ok(applied)
}

/// Updates editable FLAC Vorbis comments using in-file metadata block rewrite.
pub fn update_flac_vorbis_fields(
    path: &Path,
    updates: &std::collections::HashMap<String, String>,
) -> Result<usize, String> {
    let mut bytes = std::fs::read(path).map_err(|e| format!("Failed to read FLAC file: {}", e))?;
    if bytes.len() < 4 || &bytes[0..4] != b"fLaC" {
        return Err("Not a valid FLAC file".to_string());
    }

    let mut block_pos = 4usize;
    let mut vorbis_header_pos = None;
    let mut vorbis_data_start = 0usize;
    let mut vorbis_data_end = 0usize;

    while block_pos + 4 <= bytes.len() {
        let header = bytes[block_pos];
        let block_type = header & 0x7F;
        let block_len =
            crate::metadata::utils::synchsafe_24_to_u32(&bytes[block_pos + 1..block_pos + 4])
                as usize;
        let data_start = block_pos + 4;
        let data_end = data_start + block_len;

        if data_end > bytes.len() {
            return Err("FLAC metadata block exceeds file bounds".to_string());
        }

        if block_type == FLAC_BLOCK_TYPE_VORBIS_COMMENT {
            vorbis_header_pos = Some(block_pos);
            vorbis_data_start = data_start;
            vorbis_data_end = data_end;
            break;
        }

        if (header & 0x80) != 0 {
            break;
        }
        block_pos = data_end;
    }

    let Some(vorbis_header_pos) = vorbis_header_pos else {
        return Err("No FLAC Vorbis comment block found".to_string());
    };

    let (vendor, mut comments) =
        parse_flac_vorbis_block_raw(&bytes[vorbis_data_start..vorbis_data_end])?;

    let mut applied = 0usize;
    for (raw_key, raw_value) in updates {
        let key = raw_key.trim().to_uppercase();
        if key.is_empty()
            || key == "FORMAT"
            || key == "COVER_ART"
            || key == "METADATA_BLOCK_PICTURE"
        {
            continue;
        }

        let value = raw_value.trim().to_string();
        if let Some(existing) = comments
            .iter_mut()
            .find(|(name, _)| name.eq_ignore_ascii_case(&key))
        {
            if existing.1 != value {
                existing.1 = value;
                applied += 1;
            }
        } else {
            comments.push((key, value));
            applied += 1;
        }
    }

    if applied == 0 {
        return Err("No supported FLAC metadata fields were provided.".to_string());
    }

    let rebuilt = build_flac_vorbis_block_raw(&vendor, &comments)?;
    if rebuilt.len() > 0x00FF_FFFF {
        return Err(
            "Updated Vorbis comment block exceeds FLAC metadata block size limit".to_string(),
        );
    }

    bytes.splice(vorbis_data_start..vorbis_data_end, rebuilt.iter().copied());

    let new_len = rebuilt.len() as u32;
    bytes[vorbis_header_pos + 1] = ((new_len >> 16) & 0xFF) as u8;
    bytes[vorbis_header_pos + 2] = ((new_len >> 8) & 0xFF) as u8;
    bytes[vorbis_header_pos + 3] = (new_len & 0xFF) as u8;

    write_with_backup(path, &bytes)?;
    Ok(applied)
}

/// Parses raw FLAC Vorbis comment payload preserving vendor string.
fn parse_flac_vorbis_block_raw(data: &[u8]) -> Result<(Vec<u8>, Vec<(String, String)>), String> {
    let mut pos = 0usize;
    if pos + 4 > data.len() {
        return Err("Vorbis block missing vendor length".to_string());
    }

    let vendor_len = u32::from_le_bytes(
        data[pos..pos + 4]
            .try_into()
            .map_err(|_| "Failed to parse vendor length".to_string())?,
    ) as usize;
    pos += 4;

    if pos + vendor_len > data.len() {
        return Err("Vorbis block vendor exceeds bounds".to_string());
    }
    let vendor = data[pos..pos + vendor_len].to_vec();
    pos += vendor_len;

    if pos + 4 > data.len() {
        return Err("Vorbis block missing comment count".to_string());
    }
    let count = u32::from_le_bytes(
        data[pos..pos + 4]
            .try_into()
            .map_err(|_| "Failed to parse comment count".to_string())?,
    ) as usize;
    pos += 4;

    let mut comments = Vec::new();
    for _ in 0..count {
        if pos + 4 > data.len() {
            return Err("Vorbis block missing comment length".to_string());
        }

        let len = u32::from_le_bytes(
            data[pos..pos + 4]
                .try_into()
                .map_err(|_| "Failed to parse comment length".to_string())?,
        ) as usize;
        pos += 4;

        if pos + len > data.len() {
            return Err("Vorbis comment exceeds bounds".to_string());
        }

        let entry = String::from_utf8_lossy(&data[pos..pos + len]).to_string();
        pos += len;

        if let Some(eq_pos) = entry.find('=') {
            comments.push((
                entry[..eq_pos].to_uppercase(),
                entry[eq_pos + 1..].to_string(),
            ));
        }
    }

    Ok((vendor, comments))
}

/// Builds raw FLAC Vorbis comment payload from vendor and comments.
fn build_flac_vorbis_block_raw(
    vendor: &[u8],
    comments: &[(String, String)],
) -> Result<Vec<u8>, String> {
    if vendor.len() > u32::MAX as usize || comments.len() > u32::MAX as usize {
        return Err("Vorbis metadata exceeds supported length".to_string());
    }

    let mut out = Vec::new();
    out.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    out.extend_from_slice(vendor);
    out.extend_from_slice(&(comments.len() as u32).to_le_bytes());

    for (name, value) in comments {
        let line = format!("{}={}", name, value);
        if line.len() > u32::MAX as usize {
            return Err("Vorbis comment line exceeds supported length".to_string());
        }

        out.extend_from_slice(&(line.len() as u32).to_le_bytes());
        out.extend_from_slice(line.as_bytes());
    }

    Ok(out)
}

/// Extracts baseline WAV container metadata.
pub fn extract_wav_metadata(
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

/// Extracts FLAC Vorbis comment metadata and optional embedded artwork.
pub fn extract_flac_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();
    format_specific.insert("format".to_string(), serde_json::json!("FLAC"));

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read FLAC file: {}", e))?;
    let vorbis_comments = parse_flac_vorbis_comments(&bytes);

    if let Some(comments) = vorbis_comments {
        for comment in comments {
            let key = comment.name.clone();
            if key == "METADATA_BLOCK_PICTURE" {
                if let Some(picture_payload) = decode_metadata_block_picture_value(&comment.value) {
                    if let Ok(picture_data) = parse_ogg_picture_raw(&picture_payload) {
                        use base64::Engine;
                        format_specific.insert(
                            "cover_art".to_string(),
                            serde_json::json!(
                                base64::engine::general_purpose::STANDARD.encode(&picture_data)
                            ),
                        );
                    }
                }
            } else if key == "UNSYNCEDLYRICS" {
                let value = String::from_utf8_lossy(&comment.value).to_string();
                format_specific.insert("lyrics".to_string(), serde_json::json!(value));
            } else {
                let value = String::from_utf8_lossy(&comment.value).to_string();
                format_specific.insert(key, serde_json::json!(value));
            }
        }
    }

    let (sample_rate, channels, total_samples) = parse_flac_streaminfo(&bytes)
        .map(|(rate, channel_count, samples)| (Some(rate), Some(channel_count), Some(samples)))
        .unwrap_or((None, None, None));
    let duration = match (sample_rate, total_samples) {
        (Some(rate), Some(samples)) if rate > 0 => Some(samples as f64 / rate as f64),
        _ => None,
    };

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "Audio".to_string(),
        width: None,
        height: None,
        duration,
        bit_rate: None,
        sample_rate,
        channels,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

/// Extracts OGG Vorbis comments and optional embedded artwork.
pub fn extract_ogg_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();
    format_specific.insert("format".to_string(), serde_json::json!("OGG"));

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read OGG file: {}", e))?;

    // Parse Vorbis comments from OGG file
    if let Ok(comments) = parse_ogg_vorbis_comments_internal(&bytes) {
        for comment in comments {
            let key = comment.name.to_lowercase();
            if key != "metadata_block_picture" {
                let value = String::from_utf8_lossy(&comment.value).to_string();
                format_specific.insert(key, serde_json::json!(value));
            }
        }
    }

    // Try to extract cover art
    if let Ok(picture_data) = extract_ogg_picture(path) {
        use base64::Engine;
        format_specific.insert(
            "cover_art".to_string(),
            serde_json::json!(base64::engine::general_purpose::STANDARD.encode(&picture_data)),
        );
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

fn parse_ogg_vorbis_comments_internal(bytes: &[u8]) -> Result<Vec<FlacVorbisComment>, String> {
    let search_pattern = b"\x03vorbis";
    let packet_pos = bytes
        .windows(search_pattern.len())
        .position(|w| w == search_pattern)
        .ok_or_else(|| "No vorbis comment packet found".to_string())?;

    let mut offset = packet_pos + 7;
    let mut comments = Vec::new();

    if offset + 4 > bytes.len() {
        return Err("Insufficient data for vendor length".to_string());
    }

    let vendor_len = u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse vendor length".to_string())?,
    ) as usize;
    offset += 4 + vendor_len;

    if offset + 4 > bytes.len() {
        return Err("Insufficient data for comment count".to_string());
    }

    let num_comments = u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse comment count".to_string())?,
    ) as usize;
    offset += 4;

    for _ in 0..num_comments {
        if offset + 4 > bytes.len() {
            break;
        }

        let comment_len = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "Failed to parse comment length".to_string())?,
        ) as usize;
        offset += 4;

        if offset + comment_len > bytes.len() {
            break;
        }

        let comment_bytes = &bytes[offset..offset + comment_len];
        offset += comment_len;

        if let Ok(comment_str) = std::str::from_utf8(comment_bytes) {
            if let Some(eq_pos) = comment_str.find('=') {
                let name = comment_str[..eq_pos].to_uppercase();
                let value = comment_str[eq_pos + 1..].as_bytes().to_vec();
                comments.push(FlacVorbisComment { name, value });
            }
        }
    }

    Ok(comments)
}

pub fn parse_flac_vorbis_comments(bytes: &[u8]) -> Option<Vec<FlacVorbisComment>> {
    if bytes.len() < 4 || &bytes[0..4] != b"fLaC" {
        return None;
    }

    for block in crate::metadata::image::iter_flac_blocks(bytes, 4) {
        if block.block_type == FLAC_BLOCK_TYPE_VORBIS_COMMENT {
            return parse_vorbis_comment_block(block.data);
        }
    }

    None
}

pub fn parse_vorbis_comment_block(bytes: &[u8]) -> Option<Vec<FlacVorbisComment>> {
    let mut comments = Vec::new();
    let mut pos = 0;

    if pos + 4 > bytes.len() {
        return None;
    }
    let vendor_len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().ok()?) as usize;
    pos += 4 + vendor_len;

    if pos + 4 > bytes.len() {
        return None;
    }
    let num_comments = u32::from_le_bytes(bytes[pos..pos + 4].try_into().ok()?) as usize;
    pos += 4;

    for _ in 0..num_comments {
        if pos + 4 > bytes.len() {
            break;
        }
        let comment_len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().ok()?) as usize;
        pos += 4;
        if pos + comment_len > bytes.len() {
            break;
        }
        let comment_str = String::from_utf8_lossy(&bytes[pos..pos + comment_len]).to_string();
        pos += comment_len;

        if let Some(eq_pos) = comment_str.find('=') {
            let name = comment_str[..eq_pos].to_string();
            let value = comment_str[eq_pos + 1..].as_bytes().to_vec();
            comments.push(FlacVorbisComment { name, value });
        }
    }

    Some(comments)
}

pub fn find_flac_embedded_json_matches(bytes: &[u8]) -> Result<Vec<FlacJsonMatch>, String> {
    let comments = parse_flac_vorbis_comments(bytes)
        .ok_or_else(|| "Failed to parse FLAC Vorbis comments".to_string())?;

    let mut matches = Vec::new();
    let mut next_id = 0usize;
    for comment in comments {
        if let Some((value, encoding, payload)) =
            decode_json_payload(&String::from_utf8_lossy(&comment.value))
        {
            matches.push(FlacJsonMatch {
                id: next_id,
                label: comment.name.clone(),
                payload,
                decoded_json: value,
                encoding,
            });
            next_id += 1;
        }
    }
    Ok(matches)
}

pub fn flac_has_embedded_json(bytes: &[u8]) -> Result<bool, String> {
    let comments = parse_flac_vorbis_comments(bytes)
        .ok_or_else(|| "Failed to parse FLAC Vorbis comments".to_string())?;

    for comment in comments {
        if decode_json_payload(&String::from_utf8_lossy(&comment.value)).is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn update_flac_embedded_json(
    path: &Path,
    entry_id: usize,
    json_text: &str,
) -> Result<(), String> {
    let mut bytes = std::fs::read(path).map_err(|e| format!("Failed to read FLAC file: {}", e))?;
    let mut pos = 4;
    while pos + 4 <= bytes.len() {
        let block_header = &bytes[pos..pos + 4];
        let block_type = (block_header[0] as u32) >> 6;
        let block_len = synchsafe_to_u32(&block_header[1..5]).max(1);

        if block_type == FLAC_BLOCK_TYPE_VORBIS_COMMENT as u32 {
            break;
        }
        pos += 4 + block_len as usize;
    }

    if pos + 4 > bytes.len() {
        return Err("No Vorbis comment block found".to_string());
    }

    let block_len = synchsafe_to_u32(&bytes[pos..pos + 4]).max(1) as usize;
    let vorbis_data_start = pos + 4;
    let vorbis_block_end = vorbis_data_start + block_len;

    if vorbis_block_end > bytes.len() {
        return Err("Vorbis comment block extends beyond file".to_string());
    }

    let comments = parse_vorbis_comment_block(&bytes[vorbis_data_start..vorbis_block_end])
        .ok_or_else(|| "Failed to parse Vorbis comment block".to_string())?;

    if entry_id >= comments.len() {
        return Err(format!(
            "Entry ID {} out of range (0-{})",
            entry_id,
            comments.len() - 1
        ));
    }

    let target_comment = &comments[entry_id];

    let encoded_payload = crate::metadata::embedded::encode_json_payload(json_text)?;

    let mut vorbis_data: Vec<u8> = bytes[vorbis_data_start..vorbis_block_end].to_vec();
    let mut comment_pos = 0;

    // vendor
    let vendor_len = u32::from_le_bytes(
        vorbis_data[comment_pos..comment_pos + 4]
            .try_into()
            .map_err(|_| "Failed to parse vendor length".to_string())?,
    ) as usize;
    comment_pos += 4 + vendor_len;

    let num_comments = u32::from_le_bytes(
        vorbis_data[comment_pos..comment_pos + 4]
            .try_into()
            .map_err(|_| "Failed to parse comment count".to_string())?,
    );
    comment_pos += 4;

    for i in 0..num_comments {
        let comment_len = u32::from_le_bytes(
            vorbis_data[comment_pos..comment_pos + 4]
                .try_into()
                .map_err(|_| "Failed to parse comment length".to_string())?,
        ) as usize;
        comment_pos += 4;

        if i == entry_id as u32 {
            let new_value_str = String::from_utf8_lossy(&encoded_payload);
            let new_comment = format!("{}={}", target_comment.name, new_value_str);
            let new_comment_bytes = new_comment.as_bytes();

            let comment_end = comment_pos + comment_len;
            vorbis_data.splice(comment_pos..comment_end, new_comment_bytes.iter().copied());

            bytes.splice(
                vorbis_data_start..vorbis_block_end,
                vorbis_data.iter().copied(),
            );

            let old_block_len = synchsafe_to_u32(&bytes[pos..pos + 4]);
            let new_block_len =
                old_block_len + (new_comment_bytes.len() as isize - comment_len as isize) as u32;
            bytes[pos + 1..pos + 5].copy_from_slice(&u32_to_synchsafe(new_block_len));

            write_with_backup(path, &bytes)?;
            return Ok(());
        }

        comment_pos += comment_len;
    }

    Err(format!("Entry ID {} not found in comments", entry_id))
}

pub fn extract_mp3_cover(path: &Path) -> Result<Vec<u8>, String> {
    let tag =
        id3::Tag::read_from_path(path).map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
    let picture = tag
        .pictures()
        .next()
        .ok_or_else(|| "No embedded cover art found".to_string())?;
    Ok(picture.data.to_vec())
}

pub fn extract_flac_picture(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    if bytes.len() < 4 || &bytes[0..4] != b"fLaC" {
        return Err("Not a valid FLAC file".to_string());
    }

    for block in crate::metadata::image::iter_flac_blocks(&bytes, 4) {
        if block.block_type == FLAC_BLOCK_TYPE_PICTURE {
            return parse_flac_picture_block(block.data);
        }
    }
    Err("No embedded cover art found".to_string())
}

pub fn parse_flac_picture_block(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut pos = 0;
    pos += 4;
    let mime_len = u32::from_be_bytes(
        data[pos..pos + 4]
            .try_into()
            .map_err(|_| "Failed to read mime length")?,
    ) as usize;
    pos += 4 + mime_len;

    let desc_len = u32::from_be_bytes(
        data[pos..pos + 4]
            .try_into()
            .map_err(|_| "Failed to read desc length")?,
    ) as usize;
    pos += 4 + desc_len;

    pos += 16;
    let data_len = u32::from_be_bytes(
        data[pos..pos + 4]
            .try_into()
            .map_err(|_| "Failed to read picture data length")?,
    ) as usize;
    pos += 4;

    if pos + data_len > data.len() {
        return Err("FLAC picture data extends beyond block".to_string());
    }
    Ok(data[pos..pos + data_len].to_vec())
}

pub fn extract_ogg_picture(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Find vorbis comment packet (03 followed by 'vorbis')
    let search_pattern = b"\x03vorbis";
    let packet_pos = bytes
        .windows(search_pattern.len())
        .position(|w| w == search_pattern)
        .ok_or_else(|| "No vorbis comment packet found".to_string())?;

    let mut offset = packet_pos + 7; // skip \x03vorbis

    if offset + 4 > bytes.len() {
        return Err("Insufficient data for vendor length".to_string());
    }

    // vendor length (little-endian)
    let vendor_len = u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse vendor length".to_string())?,
    ) as usize;
    offset += 4 + vendor_len;

    if offset + 4 > bytes.len() {
        return Err("Insufficient data for comment count".to_string());
    }

    // num comments (little-endian)
    let num_comments = u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse comment count".to_string())?,
    ) as usize;
    offset += 4;

    // Parse comments looking for METADATA_BLOCK_PICTURE
    for _ in 0..num_comments {
        if offset + 4 > bytes.len() {
            break;
        }

        let comment_len = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "Failed to parse comment length".to_string())?,
        ) as usize;
        offset += 4;

        if offset + comment_len > bytes.len() {
            break;
        }

        let comment_bytes = &bytes[offset..offset + comment_len];
        offset += comment_len;

        // Look for METADATA_BLOCK_PICTURE= pattern
        if comment_bytes.len() >= 23 {
            // Try to find the = sign
            for eq_idx in 22..comment_bytes.len() {
                if comment_bytes[eq_idx] == b'='
                    && &comment_bytes[..eq_idx] == b"METADATA_BLOCK_PICTURE"
                {
                    // Found it! Extract the value part
                    let value_bytes = &comment_bytes[eq_idx + 1..];

                    // Convert to string and clean it up
                    if let Ok(value_str) = std::str::from_utf8(value_bytes) {
                        let cleaned = value_str
                            .chars()
                            .filter(|c| c.is_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
                            .collect::<String>();

                        if !cleaned.is_empty() {
                            if let Ok(pic_bytes) =
                                base64::engine::general_purpose::STANDARD.decode(cleaned)
                            {
                                if let Ok(pic_data) =
                                    try_extract_picture_from_flac_block(&pic_bytes)
                                {
                                    return Ok(pic_data);
                                }
                            }
                        }
                    }

                    // Fallback: try raw bytes as FLAC block
                    if value_bytes.len() >= 32 {
                        if let Ok(pic_data) = try_extract_picture_from_flac_block(value_bytes) {
                            return Ok(pic_data);
                        }
                    }

                    // Continue to next comment if all attempts failed
                    continue;
                }
            }
        }
    }

    Err("No embedded cover art found in OGG".to_string())
}

fn try_extract_picture_from_flac_block(pic_bytes: &[u8]) -> Result<Vec<u8>, String> {
    if pic_bytes.len() < 32 {
        return Err("Picture block too short".to_string());
    }

    let _picture_type = u32::from_be_bytes(
        pic_bytes[0..4]
            .try_into()
            .map_err(|_| "Failed to parse picture type".to_string())?,
    );

    let mime_len = u32::from_be_bytes(
        pic_bytes[4..8]
            .try_into()
            .map_err(|_| "Failed to parse mime length".to_string())?,
    ) as usize;

    let mut pic_offset = 8 + mime_len;

    if pic_offset + 4 > pic_bytes.len() {
        return Err("Insufficient data for description length".to_string());
    }

    let desc_len = u32::from_be_bytes(
        pic_bytes[pic_offset..pic_offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse description length".to_string())?,
    ) as usize;
    pic_offset += 4 + desc_len;

    // Skip width, height, depth, colors (4 bytes each)
    pic_offset += 16;

    if pic_offset + 4 > pic_bytes.len() {
        return Err("Insufficient data for picture data length".to_string());
    }

    let pic_data_len = u32::from_be_bytes(
        pic_bytes[pic_offset..pic_offset + 4]
            .try_into()
            .map_err(|_| "Failed to parse picture data length".to_string())?,
    ) as usize;
    pic_offset += 4;

    if pic_offset + pic_data_len > pic_bytes.len() {
        return Err("Picture data extends beyond block".to_string());
    }

    Ok(pic_bytes[pic_offset..pic_offset + pic_data_len].to_vec())
}

fn decode_metadata_block_picture_value(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.is_empty() {
        return None;
    }
    if let Ok(text) = std::str::from_utf8(raw) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(trimmed) {
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            }
        }
    }
    if raw.len() >= 32 {
        Some(raw.to_vec())
    } else {
        None
    }
}

pub fn parse_ogg_picture_raw(comment_value: &[u8]) -> Result<Vec<u8>, String> {
    let mut pos = 0;
    if pos + 4 > comment_value.len() {
        return Err("Too short for picture type".into());
    }
    pos += 4;

    if pos + 4 > comment_value.len() {
        return Err("Too short for mime len".into());
    }
    let mime_len = u32::from_be_bytes(
        comment_value[pos..pos + 4]
            .try_into()
            .map_err(|_| "Too short for mime len")?,
    ) as usize;
    pos += 4 + mime_len;

    if pos + 4 > comment_value.len() {
        return Err("Too short for desc len".into());
    }
    let desc_len = u32::from_be_bytes(
        comment_value[pos..pos + 4]
            .try_into()
            .map_err(|_| "Too short for desc len")?,
    ) as usize;
    pos += 4 + desc_len;

    if pos + 16 > comment_value.len() {
        return Err("Too short for dimensions".into());
    }
    pos += 16;

    if pos + 4 > comment_value.len() {
        return Err("Too short for data len".into());
    }
    let data_len = u32::from_be_bytes(
        comment_value[pos..pos + 4]
            .try_into()
            .map_err(|_| "Too short for data len")?,
    ) as usize;
    pos += 4;

    if pos + data_len > comment_value.len() {
        return Err(format!(
            "Incomplete picture data: need {}, have {}",
            data_len,
            comment_value.len() - pos
        ));
    }

    Ok(comment_value[pos..pos + data_len].to_vec())
}

/// Generates a bounded-size cover thumbnail for audio formats that embed artwork.
pub fn generate_audio_cover(file_path: &str, max_size: u32) -> Result<String, String> {
    let path = Path::new(file_path);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let image_data = match extension.as_str() {
        "mp3" => extract_mp3_cover(path),
        "flac" => extract_flac_picture(path),
        "ogg" => extract_ogg_picture(path),
        _ => return Err(format!("Cover extraction not supported for {}", extension)),
    }?;

    let image = image::load_from_memory(&image_data)
        .map_err(|e| format!("Failed to decode embedded cover art: {}", e))?;

    let thumbnail = image.thumbnail(max_size, max_size);
    let mut buffer = Vec::new();
    thumbnail
        .write_to(
            &mut std::io::Cursor::new(&mut buffer),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("Failed to encode cover thumbnail: {}", e))?;

    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buffer)
    ))
}

/// Returns one in-memory audio data URL for frontend preview playback.
pub fn get_audio_data_url(file_path: &str, max_bytes: usize) -> Result<String, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => return Err("Audio preview not supported for this extension".to_string()),
    };

    let metadata =
        fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size = metadata.len() as usize;

    if file_size == 0 {
        return Err("Audio file is empty".to_string());
    }

    let max_allowed = max_bytes.min(crate::metadata::utils::VIDEO_PREVIEW_MAX_SIZE);
    if file_size > max_allowed {
        return Err(format!(
            "Audio is too large for in-app preview ({} MB > {} MB)",
            file_size / (1024 * 1024),
            max_allowed / (1024 * 1024)
        ));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read audio file: {}", e))?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

pub fn find_mp3_embedded_json_matches(tag: &id3::Tag) -> Result<Vec<Mp3JsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for frame in tag.frames() {
        let frame_id = frame.id().to_string();
        match frame.content() {
            id3::Content::Text(text) => {
                if let Some((value, encoding, payload)) = decode_json_payload(text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: frame_id.clone(),
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
            id3::Content::ExtendedText(ext) => {
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
            id3::Content::Comment(comment) => {
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
            id3::Content::Lyrics(lyrics) => {
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

pub fn mp3_tag_has_embedded_json(tag: &id3::Tag) -> bool {
    for frame in tag.frames() {
        match frame.content() {
            id3::Content::Text(text) => {
                if decode_json_payload(text).is_some() {
                    return true;
                }
            }
            id3::Content::ExtendedText(ext) => {
                if decode_json_payload(&ext.value).is_some() {
                    return true;
                }
            }
            id3::Content::Comment(comment) => {
                if decode_json_payload(&comment.text).is_some() {
                    return true;
                }
            }
            id3::Content::Lyrics(lyrics) => {
                if decode_json_payload(&lyrics.text).is_some() {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

pub fn find_mp3_json_matches_from_raw_id3(bytes: &[u8]) -> Result<Vec<Mp3JsonMatch>, String> {
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
            if let Some((_description, text)) = parse_txxx_value(data) {
                if let Some((value, encoding, payload)) = decode_json_payload(&text) {
                    matches.push(Mp3JsonMatch {
                        id: next_id,
                        label: if _description.is_empty() {
                            "TXXX".to_string()
                        } else {
                            format!("TXXX:{}", _description)
                        },
                        payload,
                        decoded_json: value,
                        encoding,
                        frame_kind: Mp3FrameKind::ExtendedText {
                            description: _description,
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

pub fn mp3_raw_has_embedded_json(bytes: &[u8]) -> Result<bool, String> {
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

pub fn update_mp3_embedded_json(
    path: &Path,
    entry_id: usize,
    json_text: &str,
) -> Result<(), String> {
    let new_json_value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let new_json_compact = serde_json::to_string(&new_json_value)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    let mut tag =
        id3::Tag::read_from_path(path).map_err(|e| format!("Failed to read ID3 tag: {}", e))?;
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
                let start = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
                    2
                } else {
                    0
                };
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
