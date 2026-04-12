use crate::metadata::types::{Mp4Atom, Mp4AtomSizeKind, VideoJsonMatch};
use crate::metadata::utils::{MIN_BASE64_TOKEN_LEN, VIDEO_ATOM_MAX_SIZE, write_with_backup};
use std::path::Path;
use std::str;
use std::fs;

/// Extracts baseline video metadata used by the frontend metadata panel.
pub fn extract_video_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<crate::metadata::types::FileMetadata, String> {
    let mut format_specific = serde_json::Map::new();
    format_specific.insert("codec".to_string(), serde_json::json!("Unknown"));
    format_specific.insert(
        "container".to_string(),
        serde_json::json!(
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("unknown")
        ),
    );

    Ok(crate::metadata::types::FileMetadata {
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

/// Finds embedded JSON/plaintext payloads in raw video bytes for non-MP4 containers.
pub fn find_video_embedded_json_matches(bytes: &[u8]) -> Result<Vec<VideoJsonMatch>, String> {
    let mut matches = Vec::new();
    let mut next_id = 0usize;

    for (start, end) in find_json_object_spans(bytes) {
        if let Ok(text) = str::from_utf8(&bytes[start..end]) {
            if let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(text) {
                if matches!(encoding, crate::metadata::types::JsonPayloadEncoding::PlainText) {
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

        let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(token) else {
            continue;
        };

        if !matches!(encoding, crate::metadata::types::JsonPayloadEncoding::Base64(_)) {
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

/// Finds embedded JSON payloads within MP4/MOV atoms.
pub fn find_mp4_embedded_json_matches(bytes: &[u8]) -> Result<Vec<VideoJsonMatch>, String> {
    let (_atoms, matches) = find_mp4_embedded_json_matches_with_atoms(bytes)?;
    Ok(matches)
}

/// Updates one MP4/MOV embedded JSON payload while preserving atom size integrity.
pub fn update_mp4_embedded_json(path: &Path, entry_id: usize, new_json_compact: &str) -> Result<(), String> {
    let mut bytes = fs::read(path).map_err(|e| format!("Failed to read MP4/MOV file: {}", e))?;
    let (atoms, matches) = find_mp4_embedded_json_matches_with_atoms(&bytes)?;
    let target = matches
        .into_iter()
        .find(|m| m.id == entry_id)
        .ok_or_else(|| "Embedded JSON entry not found".to_string())?;

    let new_payload = crate::metadata::embedded::encode_payload_with_encoding(new_json_compact, &target.encoding)
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

pub fn find_mp4_embedded_json_matches_with_atoms(
    bytes: &[u8],
) -> Result<(Vec<Mp4Atom>, Vec<VideoJsonMatch>), String> {
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
                if let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(text) {
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

            let Some((value, encoding, payload)) = crate::metadata::embedded::decode_json_payload(token) else {
                continue;
            };

            if !matches!(encoding, crate::metadata::types::JsonPayloadEncoding::Base64(_)) {
                continue;
            }

            let abs_start = payload_start + rel_start;
            let abs_end = payload_start + rel_end;

            if matches
                .iter()
                .any(|m| !(abs_end <= m.start || abs_start >= m.end))
            {
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

pub fn parse_mp4_atoms(
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

pub fn mp4_atom_is_container(atom_type: [u8; 4]) -> bool {
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

pub fn mp4_atom_is_json_candidate(atom: &Mp4Atom, atoms: &[Mp4Atom]) -> bool {
    if atom.end.saturating_sub(atom.data_start) > VIDEO_ATOM_MAX_SIZE {
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

pub fn has_mp4_ancestor_type(atom: &Mp4Atom, atoms: &[Mp4Atom], wanted: [u8; 4]) -> bool {
    let mut current = atom.parent;
    while let Some(idx) = current {
        if let Some(parent) = atoms.get(idx) {
            if parent.atom_type == wanted {
                return true;
            }
            current = parent.parent;
        } else {
            return false;
        }
    }
    false
}

pub fn collect_mp4_atom_path(mut atom_idx: usize, atoms: &[Mp4Atom]) -> Vec<usize> {
    let mut path = Vec::new();
    loop {
        path.push(atom_idx);
        if let Some(atom) = atoms.get(atom_idx) {
            if let Some(parent_idx) = atom.parent {
                atom_idx = parent_idx;
                continue;
            }
        }
        break;
    }
    path
}

pub fn apply_mp4_atom_size_delta(bytes: &mut [u8], atom: &Mp4Atom, delta: isize) -> Result<(), String> {
    match atom.size_kind {
        Mp4AtomSizeKind::Fixed32(old_size) => {
            let new_size = old_size as isize + delta;
            if new_size < 8 {
                return Err("MP4 atom size underflow during rewrite".to_string());
            }
            let new_u32 = u32::try_from(new_size).map_err(|_| "MP4 atom exceeded 32-bit size while rewriting".to_string())?;
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
            let new_u64 = u64::try_from(new_size).map_err(|_| "MP4 extended atom size overflow during rewrite".to_string())?;
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

pub fn atom_type_label(atom_type: [u8; 4]) -> String {
    if atom_type.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        String::from_utf8_lossy(&atom_type).to_string()
    } else {
        format!(
            "0x{:02X}{:02X}{:02X}{:02X}",
            atom_type[0], atom_type[1], atom_type[2], atom_type[3]
        )
    }
}

/// Returns bounded video file bytes encoded as a data URL for frontend preview.
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

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size = metadata.len() as usize;

    if file_size == 0 {
        return Err("Video file is empty".to_string());
    }

    let max_allowed = max_bytes.min(crate::metadata::utils::VIDEO_PREVIEW_MAX_SIZE);
    if file_size > max_allowed {
        return Err(format!(
            "Video is too large for in-app preview ({} MB > {} MB)",
            file_size / (1024 * 1024),
            max_allowed / (1024 * 1024)
        ));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

pub fn find_json_object_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
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

pub fn parse_json_object_span(bytes: &[u8], start: usize) -> Option<usize> {
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

pub fn find_base64_candidate_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
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

pub fn is_base64_char(byte: u8) -> bool {
    matches!(byte,
        b'A'..=b'Z'
        | b'a'..=b'z'
        | b'0'..=b'9'
        | b'+'
        | b'/'
        | b'='
        | b'-'
        | b'_' )
}
