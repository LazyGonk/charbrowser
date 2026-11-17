//! Lossless EXIF stripping for JPEG, PNG, and WebP containers.
//!
//! Every function here works on the original container bytes: it walks the
//! format's segment/chunk table, removes only the entries that carry an EXIF
//! payload, and copies everything else byte for byte. Pixels are never decoded
//! or re-encoded.
//!
//! Planning and rewriting share [`strip_exif`], so a reviewed plan and the bytes
//! written by apply are produced by the same code path.

use crate::metadata::image::{build_png_bytes, parse_png_chunks};
use crate::metadata::types::PngChunk;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SOI: [u8; 2] = [0xFF, 0xD8];
const RIFF_SIGNATURE: [u8; 4] = *b"RIFF";
const WEBP_SIGNATURE: [u8; 4] = *b"WEBP";
/// `Exif` + two NULs, the JPEG APP1 payload prefix.
const EXIF_APP1_PREFIX: [u8; 6] = *b"Exif\0\0";
/// VP8X feature flags live in the first payload byte.
const VP8X_EXIF_FLAG: u8 = 0x08;

/// One container entry that will be removed.
///
/// `summary` is deliberately a short description (type, size, offset) so plan
/// review never has to ship a multi-megabyte binary payload to the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExifEntry {
    pub locator: String,
    pub summary: String,
}

/// Result of scanning and rewriting one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExifStrip {
    /// Entries removed from the container, in file order.
    pub entries: Vec<ExifEntry>,
    /// Container bytes without those entries. `None` when there was nothing to
    /// remove, which is a planned no-op rather than an error.
    pub stripped: Option<Vec<u8>>,
}

impl ExifStrip {
    fn empty() -> Self {
        Self {
            entries: Vec::new(),
            stripped: None,
        }
    }
}

/// Strips EXIF from a JPEG, PNG, or WebP container, detected by magic bytes.
pub fn strip_exif(bytes: &[u8]) -> Result<ExifStrip, String> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        return strip_png(bytes);
    }
    if bytes.starts_with(&JPEG_SOI) {
        return strip_jpeg(bytes);
    }
    if bytes.len() >= 12 && &bytes[0..4] == RIFF_SIGNATURE && &bytes[8..12] == WEBP_SIGNATURE {
        return strip_webp(bytes);
    }
    Err(
        "EXIF stripping supports JPEG, PNG, and WebP containers only; the file contents are none of those."
            .to_string(),
    )
}

/// Layout of one JPEG segment: `start..end` is copied verbatim, `exif_payload_len`
/// marks an APP1 segment whose payload starts with `Exif\0\0`.
struct JpegSegment {
    start: usize,
    end: usize,
    exif_payload_len: Option<usize>,
}

/// Segment table ahead of the scan data.
///
/// Walks every marker before SOS, validating lengths. A malformed file is
/// rejected before anything is copied.
fn scan_jpeg(bytes: &[u8]) -> Result<Vec<JpegSegment>, String> {
    let mut segments = Vec::new();
    let mut pos = 2usize;

    loop {
        if pos >= bytes.len() {
            return Err(
                "Malformed JPEG: file ends before the scan data (no SOS marker).".to_string(),
            );
        }
        if bytes[pos] != 0xFF {
            return Err(format!(
                "Malformed JPEG: expected a segment marker at offset {}, found 0x{:02X}.",
                pos, bytes[pos]
            ));
        }

        // Multiple 0xFF bytes before a marker are legal fill bytes; they belong
        // to the segment range that is copied verbatim.
        let start = pos;
        let mut marker_pos = pos;
        while marker_pos < bytes.len() && bytes[marker_pos] == 0xFF {
            marker_pos += 1;
        }
        if marker_pos >= bytes.len() {
            return Err("Malformed JPEG: file ends inside a marker.".to_string());
        }

        match bytes[marker_pos] {
            0x00 => {
                return Err(format!(
                    "Malformed JPEG: stuffed byte outside the scan data at offset {}.",
                    marker_pos
                ))
            }
            0xD8 => {
                return Err(format!(
                    "Malformed JPEG: unexpected start-of-image marker at offset {}.",
                    marker_pos
                ))
            }
            0xD9 => {
                return Err(
                    "Malformed JPEG: end-of-image marker before scan data (no SOS marker)."
                        .to_string(),
                )
            }
            0xDA => return Ok(segments),
            0x01 | 0xD0..=0xD7 => {
                // Standalone markers carry no length field.
                let end = marker_pos + 1;
                segments.push(JpegSegment {
                    start,
                    end,
                    exif_payload_len: None,
                });
                pos = end;
            }
            marker => {
                if marker_pos + 3 > bytes.len() {
                    return Err(format!(
                        "Malformed JPEG: truncated segment length at offset {}.",
                        start
                    ));
                }
                let len = u16::from_be_bytes([bytes[marker_pos + 1], bytes[marker_pos + 2]]) as usize;
                if len < 2 {
                    return Err(format!(
                        "Malformed JPEG: segment at offset {} declares length {}.",
                        start, len
                    ));
                }
                let end = marker_pos + 1 + len;
                if end > bytes.len() {
                    return Err(format!(
                        "Malformed JPEG: segment at offset {} declares {} bytes, beyond the end of the file.",
                        start, len
                    ));
                }
                let payload = &bytes[marker_pos + 3..end];
                let exif_payload_len = if marker == 0xE1 && payload.starts_with(&EXIF_APP1_PREFIX) {
                    Some(payload.len())
                } else {
                    None
                };
                segments.push(JpegSegment {
                    start,
                    end,
                    exif_payload_len,
                });
                pos = end;
            }
        }
    }
}

fn strip_jpeg(bytes: &[u8]) -> Result<ExifStrip, String> {
    let segments = scan_jpeg(bytes)?;
    let mut entries = Vec::new();

    for segment in &segments {
        if let Some(payload_len) = segment.exif_payload_len {
            entries.push(ExifEntry {
                locator: format!("APP1@{}", segment.start),
                summary: format!(
                    "EXIF APP1 segment at offset {}, {} bytes",
                    segment.start, payload_len
                ),
            });
        }
    }

    if entries.is_empty() {
        return Ok(ExifStrip::empty());
    }

    let mut out = Vec::with_capacity(bytes.len());
    let mut cursor = 0usize;
    for segment in &segments {
        if segment.exif_payload_len.is_some() {
            out.extend_from_slice(&bytes[cursor..segment.start]);
            cursor = segment.end;
        }
    }
    // SOS, scan data, and everything after it (including EOI) are untouched.
    out.extend_from_slice(&bytes[cursor..]);

    Ok(ExifStrip {
        entries,
        stripped: Some(out),
    })
}

fn strip_png(bytes: &[u8]) -> Result<ExifStrip, String> {
    let mut chunks = parse_png_chunks(bytes)?;

    if chunks.last().map(|chunk| &chunk.chunk_type) != Some(b"IEND") {
        return Err("Malformed PNG: chunk stream has no IEND terminator.".to_string());
    }

    // parse_png_chunks stops at IEND; anything after it is preserved verbatim.
    let consumed: usize = 8 + chunks.iter().map(|chunk| 12 + chunk.data.len()).sum::<usize>();
    let trailing = if consumed < bytes.len() {
        &bytes[consumed..]
    } else {
        &[]
    };

    let mut entries = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        if chunk.chunk_type == *b"eXIf" {
            entries.push(ExifEntry {
                locator: format!("eXIf[{}]", index),
                summary: format!(
                    "PNG eXIf chunk at index {}, {} bytes",
                    index,
                    chunk.data.len()
                ),
            });
        }
    }

    if entries.is_empty() {
        return Ok(ExifStrip::empty());
    }

    chunks.retain(|chunk| chunk.chunk_type != *b"eXIf");
    let kept: Vec<PngChunk> = chunks;
    let mut out = build_png_bytes(&kept);
    out.extend_from_slice(trailing);

    Ok(ExifStrip {
        entries,
        stripped: Some(out),
    })
}

/// One RIFF chunk range: `padded_end` includes the odd-size padding byte.
struct WebpChunk {
    fourcc: [u8; 4],
    start: usize,
    data_start: usize,
    data_end: usize,
    padded_end: usize,
}

fn strip_webp(bytes: &[u8]) -> Result<ExifStrip, String> {
    let declared = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let actual = bytes.len() - 8;
    if declared != actual {
        return Err(format!(
            "Malformed WebP: RIFF size field says {} bytes but the file holds {}.",
            declared, actual
        ));
    }

    let mut chunks = Vec::new();
    let mut pos = 12usize;
    while pos < bytes.len() {
        if pos + 8 > bytes.len() {
            return Err(format!(
                "Malformed WebP: truncated chunk header at offset {}.",
                pos
            ));
        }
        let fourcc = [bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]];
        let size =
            u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]])
                as usize;
        let data_start = pos + 8;
        let data_end = data_start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| {
                format!(
                    "Malformed WebP: chunk {:?} at offset {} declares {} bytes, beyond the end of the file.",
                    String::from_utf8_lossy(&fourcc),
                    pos,
                    size
                )
            })?;
        let padded_end = data_end + (size & 1);
        if padded_end > bytes.len() {
            return Err(format!(
                "Malformed WebP: chunk {:?} at offset {} is missing its padding byte.",
                String::from_utf8_lossy(&fourcc),
                pos
            ));
        }

        chunks.push(WebpChunk {
            fourcc,
            start: pos,
            data_start,
            data_end,
            padded_end,
        });
        pos = padded_end;
    }

    let vp8x_has_exif_flag =
        |chunk: &WebpChunk| -> bool {
            chunk.fourcc == *b"VP8X"
                && chunk.data_end > chunk.data_start
                && bytes[chunk.data_start] & VP8X_EXIF_FLAG != 0
        };

    let mut entries = Vec::new();
    let has_exif_chunk = chunks.iter().any(|chunk| chunk.fourcc == *b"EXIF");
    for chunk in &chunks {
        let name = String::from_utf8_lossy(&chunk.fourcc).into_owned();
        if chunk.fourcc == *b"EXIF" {
            entries.push(ExifEntry {
                locator: format!("{}@{}", name, chunk.start),
                summary: format!(
                    "WebP EXIF chunk at offset {}, {} bytes",
                    chunk.start,
                    chunk.data_end - chunk.data_start
                ),
            });
        } else if has_exif_chunk && vp8x_has_exif_flag(chunk) {
            entries.push(ExifEntry {
                locator: format!("VP8X.exif-flag@{}", chunk.start),
                summary: format!("VP8X EXIF flag set at offset {}", chunk.start),
            });
        }
    }

    if entries.is_empty() {
        return Ok(ExifStrip::empty());
    }

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[0..12]);
    for chunk in &chunks {
        if chunk.fourcc == *b"EXIF" {
            continue;
        }

        if has_exif_chunk && vp8x_has_exif_flag(chunk) {
            out.extend_from_slice(&bytes[chunk.start..chunk.data_start]);
            out.push(bytes[chunk.data_start] & !VP8X_EXIF_FLAG);
            out.extend_from_slice(&bytes[chunk.data_start + 1..chunk.padded_end]);
        } else {
            out.extend_from_slice(&bytes[chunk.start..chunk.padded_end]);
        }
    }

    let new_size = out.len() - 8;
    let new_size = u32::try_from(new_size)
        .map_err(|_| "EXIF stripping produced a WebP larger than 4 GiB.".to_string())?;
    out[4..8].copy_from_slice(&new_size.to_le_bytes());

    Ok(ExifStrip {
        entries,
        stripped: Some(out),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bulk_edit::test_support::{cleanup_dir, unique_dir, write_binary};
    use crate::bulk_edit::{
        apply_plan, default_registry, plan_request, BulkPlanRequest, FsWriter, MemoryJournal,
        OperationKind, OperationParams, PlanFileStatus,
    };
    use std::fs;

    fn png_chunk(chunk_type: &[u8; 4], data: &[u8]) -> PngChunk {
        PngChunk {
            chunk_type: *chunk_type,
            data: data.to_vec(),
        }
    }

    fn sample_tiff_payload() -> Vec<u8> {
        let mut payload = EXIF_APP1_PREFIX.to_vec();
        // Little-endian TIFF header plus an empty first IFD.
        payload.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        payload
    }

    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let len = u16::try_from(payload.len() + 2).expect("fixture segment fits");
        let mut segment = vec![0xFF, marker];
        segment.extend_from_slice(&len.to_be_bytes());
        segment.extend_from_slice(payload);
        segment
    }

    /// SOI + APP0 + EXIF APP1 + XMP APP1 + SOS + scan + EOI.
    fn jpeg_fixture() -> Vec<u8> {
        let mut bytes = JPEG_SOI.to_vec();
        bytes.extend_from_slice(&jpeg_segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
        bytes.extend_from_slice(&jpeg_segment(0xE1, &sample_tiff_payload()));
        bytes.extend_from_slice(&jpeg_segment(
            0xE1,
            b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>",
        ));
        bytes.extend_from_slice(&jpeg_segment(0xDA, &[0x01, 0x02, 0x03]));
        bytes.extend_from_slice(&[0x12, 0x34, 0x56, 0x78]);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        bytes
    }

    fn webp_chunk(fourcc: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = fourcc.to_vec();
        chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
        chunk.extend_from_slice(data);
        if data.len() % 2 == 1 {
            chunk.push(0);
        }
        chunk
    }

    fn webp_fixture(include_vp8x: bool, with_exif: bool) -> Vec<u8> {
        let mut body = Vec::new();
        if include_vp8x {
            let mut vp8x = vec![VP8X_EXIF_FLAG | 0x04];
            vp8x.extend_from_slice(&[0, 0, 0]);
            vp8x.extend_from_slice(&[0x0F, 0, 0]);
            vp8x.extend_from_slice(&[0x0F, 0, 0]);
            body.extend_from_slice(&webp_chunk(b"VP8X", &vp8x));
        }
        if with_exif {
            // Odd payload exercises the padding byte.
            body.extend_from_slice(&webp_chunk(b"EXIF", &sample_tiff_payload()[..13]));
        }
        body.extend_from_slice(&webp_chunk(b"XMP ", b"<x:xmpmeta/>!"));
        body.extend_from_slice(&webp_chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]));
        body.extend_from_slice(&webp_chunk(b"VP8 ", &[0x9D, 0x01, 0x2A, 0x01, 0x00]));

        let mut out = RIFF_SIGNATURE.to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(&WEBP_SIGNATURE);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn jpeg_removes_only_exif_app1_and_preserves_everything_else() {
        let original = jpeg_fixture();
        let strip = strip_exif(&original).expect("jpeg strip should succeed");

        assert_eq!(strip.entries.len(), 1);
        assert!(strip.entries[0].locator.starts_with("APP1@"));
        assert!(strip.entries[0].summary.contains("EXIF APP1 segment"));
        assert!(!strip.entries[0].summary.contains('\0'));

        let stripped = strip.stripped.expect("EXIF APP1 present");
        assert!(!stripped
            .windows(EXIF_APP1_PREFIX.len())
            .any(|window| window == EXIF_APP1_PREFIX));
        assert_eq!(&stripped[0..2], &JPEG_SOI);
        assert!(stripped.ends_with(&[0xFF, 0xD9]));

        // The XMP APP1 segment survives byte for byte, as does the scan data.
        let xmp = jpeg_segment(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>");
        assert!(stripped
            .windows(xmp.len())
            .any(|window| window == xmp.as_slice()));
        assert!(stripped
            .windows(4)
            .any(|window| window == [0x12, 0x34, 0x56, 0x78]));
        assert!(stripped.len() < original.len());
    }

    #[test]
    fn jpeg_without_exif_is_a_noop() {
        let mut bytes = JPEG_SOI.to_vec();
        bytes.extend_from_slice(&jpeg_segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
        bytes.extend_from_slice(&jpeg_segment(0xDA, &[0x01]));
        bytes.extend_from_slice(&[0xFF, 0xD9]);

        let strip = strip_exif(&bytes).expect("jpeg strip should succeed");
        assert!(strip.entries.is_empty());
        assert!(strip.stripped.is_none());
    }

    #[test]
    fn jpeg_rejects_truncated_segment_lengths() {
        let mut bytes = JPEG_SOI.to_vec();
        bytes.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x40, 0x01, 0x02]);

        let error = strip_exif(&bytes).expect_err("truncated segment must be rejected");
        assert!(
            error.contains("beyond the end of the file"),
            "unexpected error: {}",
            error
        );

        let overlong = [JPEG_SOI.as_slice(), &[0xFF, 0xE1, 0x00, 0x01]].concat();
        let error = strip_exif(&overlong).expect_err("length below 2 must be rejected");
        assert!(
            error.contains("declares length"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn jpeg_rejects_missing_scan_data() {
        let mut bytes = JPEG_SOI.to_vec();
        bytes.extend_from_slice(&jpeg_segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));

        let error = strip_exif(&bytes).expect_err("no SOS must be rejected");
        assert!(error.contains("no SOS marker"), "unexpected error: {}", error);
    }

    #[test]
    fn png_removes_only_exif_chunk_and_keeps_order_and_crcs() {
        let chunks = vec![
            png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
            png_chunk(b"tEXt", b"Comment\0hello"),
            png_chunk(b"eXIf", &sample_tiff_payload()),
            png_chunk(b"IDAT", &[0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01]),
            png_chunk(b"IEND", &[]),
        ];
        let original = build_png_bytes(&chunks);

        let strip = strip_exif(&original).expect("png strip should succeed");
        assert_eq!(strip.entries.len(), 1);
        assert_eq!(strip.entries[0].locator, "eXIf[2]");
        assert!(strip.entries[0].summary.contains("bytes"));
        assert!(!strip.entries[0].summary.contains("Comment"));

        let stripped = strip.stripped.expect("eXIf chunk present");
        let reparsed = parse_png_chunks(&stripped).expect("stripped png must parse");
        let types: Vec<[u8; 4]> = reparsed.iter().map(|chunk| chunk.chunk_type).collect();
        assert_eq!(
            types,
            vec![*b"IHDR", *b"tEXt", *b"IDAT", *b"IEND"],
            "only the eXIf chunk may be removed and order must not change"
        );
        // build_png_bytes recomputes CRCs, so a rebuilt file is byte-identical.
        assert_eq!(build_png_bytes(&reparsed), stripped);
    }

    #[test]
    fn png_without_exif_is_a_noop_and_trailing_bytes_are_preserved() {
        let chunks = vec![
            png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
            png_chunk(b"eXIf", &sample_tiff_payload()),
            png_chunk(b"IDAT", &[0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01]),
            png_chunk(b"IEND", &[]),
        ];
        let mut original = build_png_bytes(&chunks);
        original.extend_from_slice(b"trailer");

        let strip = strip_exif(&original).expect("png strip should succeed");
        let stripped = strip.stripped.expect("eXIf chunk present");
        assert!(stripped.ends_with(b"trailer"));

        let clean = build_png_bytes(&chunks[2..]);
        let strip = strip_exif(&clean).expect("png strip should succeed");
        assert!(strip.entries.is_empty());
        assert!(strip.stripped.is_none());
    }

    #[test]
    fn png_rejects_missing_iend() {
        let bytes = build_png_bytes(&[png_chunk(
            b"IDAT",
            &[0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01],
        )]);

        let error = strip_exif(&bytes).expect_err("missing IEND must be rejected");
        assert!(error.contains("IEND"), "unexpected error: {}", error);
    }

    #[test]
    fn webp_removes_exif_updates_riff_size_and_clears_vp8x_flag() {
        let original = webp_fixture(true, true);
        let strip = strip_exif(&original).expect("webp strip should succeed");

        let locators: Vec<&str> = strip
            .entries
            .iter()
            .map(|entry| entry.locator.as_str())
            .collect();
        assert_eq!(locators.len(), 2);
        assert!(locators[0].starts_with("VP8X.exif-flag@"));
        assert!(locators[1].starts_with("EXIF@"));

        let stripped = strip.stripped.expect("EXIF chunk present");
        let declared = u32::from_le_bytes([stripped[4], stripped[5], stripped[6], stripped[7]]);
        assert_eq!(declared as usize, stripped.len() - 8);
        assert!(!stripped.windows(4).any(|window| window == b"EXIF"));

        // VP8X keeps the XMP flag but loses the EXIF flag.
        let vp8x_index = stripped
            .windows(4)
            .position(|window| window == b"VP8X")
            .expect("VP8X survives");
        let flags = stripped[vp8x_index + 8];
        assert_eq!(flags & VP8X_EXIF_FLAG, 0);
        assert_eq!(flags & 0x04, 0x04);

        // Animation and image payloads survive; odd XMP chunk keeps its padding.
        assert!(stripped.windows(4).any(|window| window == b"ANIM"));
        assert!(stripped.windows(4).any(|window| window == b"VP8 "));
        let xmp_index = stripped
            .windows(4)
            .position(|window| window == b"XMP ")
            .expect("XMP survives");
        let xmp_size = u32::from_le_bytes([
            stripped[xmp_index + 4],
            stripped[xmp_index + 5],
            stripped[xmp_index + 6],
            stripped[xmp_index + 7],
        ]) as usize;
        assert_eq!(xmp_size, b"<x:xmpmeta/>!".len());
        assert_eq!(
            stripped[xmp_index + 8 + xmp_size],
            0,
            "odd chunk padding byte must survive"
        );
    }

    #[test]
    fn webp_without_vp8x_removes_exif_and_resizes_only() {
        let original = webp_fixture(false, true);
        let strip = strip_exif(&original).expect("webp strip should succeed");
        assert_eq!(strip.entries.len(), 1);
        assert!(strip.entries[0].locator.starts_with("EXIF@"));

        let stripped = strip.stripped.expect("EXIF chunk present");
        let declared = u32::from_le_bytes([stripped[4], stripped[5], stripped[6], stripped[7]]);
        assert_eq!(declared as usize, stripped.len() - 8);
        assert!(stripped.len() < original.len());
    }

    #[test]
    fn webp_without_exif_is_a_noop() {
        let original = webp_fixture(true, false);
        let strip = strip_exif(&original).expect("webp strip should succeed");
        assert!(strip.entries.is_empty());
        assert!(strip.stripped.is_none());
    }

    #[test]
    fn webp_rejects_inconsistent_sizes_and_truncated_chunks() {
        let mut bad_size = webp_fixture(false, true);
        let declared = u32::from_le_bytes([bad_size[4], bad_size[5], bad_size[6], bad_size[7]]);
        bad_size[4..8].copy_from_slice(&(declared + 2).to_le_bytes());
        let error = strip_exif(&bad_size).expect_err("inconsistent RIFF size must be rejected");
        assert!(error.contains("RIFF size"), "unexpected error: {}", error);

        let mut truncated = webp_fixture(false, true);
        truncated.truncate(truncated.len() - 3);
        let size = (truncated.len() - 8) as u32;
        truncated[4..8].copy_from_slice(&size.to_le_bytes());
        let error = strip_exif(&truncated).expect_err("truncated chunk must be rejected");
        assert!(
            error.contains("beyond the end of the file") || error.contains("padding"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn unknown_container_is_rejected() {
        let error = strip_exif(b"not an image").expect_err("unknown container must be rejected");
        assert!(
            error.contains("JPEG, PNG, and WebP"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn exif_strip_plans_and_applies_mixed_containers() {
        let dir = unique_dir("exif-strip-e2e");
        let jpeg = write_binary(&dir, "photo.jpg", &jpeg_fixture());
        let png = write_binary(
            &dir,
            "card.png",
            &build_png_bytes(&[
                png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
                png_chunk(b"eXIf", &sample_tiff_payload()),
                png_chunk(b"IDAT", &[0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01]),
                png_chunk(b"IEND", &[]),
            ]),
        );
        let webp = write_binary(&dir, "anim.webp", &webp_fixture(true, true));

        let registry = default_registry();
        let request = BulkPlanRequest {
            paths: vec![jpeg.clone(), png.clone(), webp.clone()],
            params: OperationParams {
                operation: OperationKind::ExifStrip,
                locator: String::new(),
                value: String::new(),
            },
        };

        let plan = plan_request(&request, &registry).expect("strip plan should succeed");
        assert_eq!(plan.files.len(), 3);
        for file in &plan.files {
            assert_eq!(
                file.status,
                PlanFileStatus::Changed,
                "{}: {:?}",
                file.file,
                file.reason
            );
            assert!(!file.changes.is_empty());
            assert!(file.changes.iter().all(|change| change.new_value.is_none()));
            // Review rows describe the removed entry, never its payload.
            assert!(file.changes.iter().all(|change| change
                .old_value
                .as_deref()
                .map(|value| value.len() < 80)
                .unwrap_or(false)));
        }
        let webp_row = plan
            .files
            .iter()
            .find(|file| file.file == webp)
            .expect("webp row");
        assert_eq!(
            webp_row.changes.len(),
            2,
            "EXIF chunk plus the VP8X flag are both reported"
        );

        let mut journal = MemoryJournal::new();
        let result =
            apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply should succeed");
        assert_eq!(
            (result.applied, result.skipped, result.failed),
            (3, 0, 0)
        );
        assert_eq!(journal.entries().len(), 3);
        assert!(journal
            .entries()
            .iter()
            .all(|entry| entry.operation == "exif_strip"));

        let jpeg_after = fs::read(&jpeg).expect("jpeg readable");
        assert!(!jpeg_after
            .windows(EXIF_APP1_PREFIX.len())
            .any(|window| window == EXIF_APP1_PREFIX));
        assert!(jpeg_after.windows(4).any(|window| window == b"JFIF"));
        assert!(jpeg_after.ends_with(&[0xFF, 0xD9]));
        assert!(jpeg_after
            .windows(4)
            .any(|window| window == [0x12, 0x34, 0x56, 0x78]));

        let png_after = fs::read(&png).expect("png readable");
        let types: Vec<[u8; 4]> = parse_png_chunks(&png_after)
            .expect("stripped png parses")
            .iter()
            .map(|chunk| chunk.chunk_type)
            .collect();
        assert_eq!(types, vec![*b"IHDR", *b"IDAT", *b"IEND"]);

        let webp_after = fs::read(&webp).expect("webp readable");
        assert!(!webp_after.windows(4).any(|window| window == b"EXIF"));
        let declared =
            u32::from_le_bytes([webp_after[4], webp_after[5], webp_after[6], webp_after[7]]);
        assert_eq!(declared as usize, webp_after.len() - 8);

        // A second plan over the now EXIF-free files is a planned no-op.
        let replanned = plan_request(&request, &registry).expect("replan should succeed");
        assert!(
            replanned
                .files
                .iter()
                .all(|file| file.status == PlanFileStatus::Noop),
            "clean files must plan as no-ops: {:?}",
            replanned.files
        );
        let before = fs::read(&jpeg).expect("jpeg readable");
        let mut journal = MemoryJournal::new();
        let result =
            apply_plan(&replanned, &registry, &FsWriter, &mut journal).expect("apply succeeds");
        assert_eq!(result.applied, 0);
        assert!(journal.entries().is_empty());
        assert_eq!(fs::read(&jpeg).expect("jpeg readable"), before);

        cleanup_dir(&dir);
    }

    /// Minimal little-endian TIFF block with one Software tag, usable as the
    /// payload of a JPEG APP1 segment or a PNG/WebP EXIF chunk.
    fn exif_tiff_payload() -> Vec<u8> {
        let mut tiff = vec![b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0131u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&4u32.to_le_bytes());
        tiff.extend_from_slice(b"tst\0");
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff
    }

    fn encode_png() -> Vec<u8> {
        use ::image::ImageEncoder;
        let img = ::image::RgbaImage::from_fn(7, 5, |x, y| {
            ::image::Rgba([(x * 30) as u8, (y * 40) as u8, ((x + y) * 10) as u8, 255])
        });
        let mut out = Vec::new();
        ::image::codecs::png::PngEncoder::new(&mut out)
            .write_image(img.as_raw(), 7, 5, ::image::ExtendedColorType::Rgba8)
            .expect("png fixture encodes");
        out
    }

    fn encode_jpeg() -> Vec<u8> {
        use ::image::ImageEncoder;
        let img = ::image::RgbImage::from_fn(16, 12, |x, y| {
            ::image::Rgb([(x * 12) as u8, (y * 18) as u8, ((x + y) * 7) as u8])
        });
        let mut out = Vec::new();
        ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .write_image(img.as_raw(), 16, 12, ::image::ExtendedColorType::Rgb8)
            .expect("jpeg fixture encodes");
        out
    }

    fn encode_webp() -> Vec<u8> {
        use ::image::ImageEncoder;
        let img = ::image::RgbaImage::from_fn(9, 6, |x, y| {
            ::image::Rgba([(x * 20) as u8, (y * 30) as u8, ((x * y) * 5) as u8, 255])
        });
        let mut out = Vec::new();
        ::image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .write_image(img.as_raw(), 9, 6, ::image::ExtendedColorType::Rgba8)
            .expect("webp fixture encodes");
        out
    }

    fn inject_jpeg_exif(jpeg: &[u8], tiff: &[u8]) -> Vec<u8> {
        let mut payload = EXIF_APP1_PREFIX.to_vec();
        payload.extend_from_slice(tiff);
        let mut out = jpeg[0..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    fn inject_png_exif(png: &[u8], tiff: &[u8]) -> Vec<u8> {
        let mut chunks = parse_png_chunks(png).expect("encoded png parses");
        assert_eq!(chunks[0].chunk_type, *b"IHDR");
        chunks.insert(1, png_chunk(b"eXIf", tiff));
        build_png_bytes(&chunks)
    }

    fn inject_webp_exif(webp: &[u8], tiff: &[u8], width: u32, height: u32) -> Vec<u8> {
        // Convert the simple lossless file into the extended (VP8X) layout so
        // the EXIF chunk sits in a spec-valid position.
        let mut vp8x = vec![VP8X_EXIF_FLAG];
        vp8x.extend_from_slice(&[0, 0, 0]);
        vp8x.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        vp8x.extend_from_slice(&(height - 1).to_le_bytes()[..3]);

        let mut body = webp_chunk(b"VP8X", &vp8x);
        body.extend_from_slice(&webp_chunk(b"EXIF", tiff));
        body.extend_from_slice(&webp[12..]);

        let mut out = RIFF_SIGNATURE.to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(&WEBP_SIGNATURE);
        out.extend_from_slice(&body);
        out
    }

    fn decoded_rgba(path: &str) -> (u32, u32, Vec<u8>) {
        let img = ::image::open(path).expect("fixture image decodes");
        (img.width(), img.height(), img.to_rgba8().into_raw())
    }

    #[test]
    fn exif_strip_preserves_decoded_pixels_and_clears_reported_exif() {
        let dir = unique_dir("exif-strip-pixels");
        let tiff = exif_tiff_payload();

        let jpeg = write_binary(&dir, "photo.jpg", &inject_jpeg_exif(&encode_jpeg(), &tiff));
        let png = write_binary(&dir, "card.png", &inject_png_exif(&encode_png(), &tiff));
        let webp = write_binary(
            &dir,
            "anim.webp",
            &inject_webp_exif(&encode_webp(), &tiff, 9, 6),
        );

        let before = [
            decoded_rgba(&jpeg),
            decoded_rgba(&png),
            decoded_rgba(&webp),
        ];
        for file in [&jpeg, &png, &webp] {
            assert!(
                crate::metadata::image::extract_exif_metadata(std::path::Path::new(file)).is_some(),
                "fixture {file} should report EXIF before stripping"
            );
        }

        let registry = default_registry();
        let request = BulkPlanRequest {
            paths: vec![jpeg.clone(), png.clone(), webp.clone()],
            params: OperationParams {
                operation: OperationKind::ExifStrip,
                locator: String::new(),
                value: String::new(),
            },
        };
        let plan = plan_request(&request, &registry).expect("plan should succeed");
        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply succeeds");
        assert_eq!((result.applied, result.skipped, result.failed), (3, 0, 0));

        let after = [
            decoded_rgba(&jpeg),
            decoded_rgba(&png),
            decoded_rgba(&webp),
        ];
        assert_eq!(before, after, "decoded pixels and dimensions must be unchanged");

        for file in [&jpeg, &png, &webp] {
            assert!(
                crate::metadata::image::extract_exif_metadata(std::path::Path::new(file)).is_none(),
                "EXIF must be absent from {file} after stripping"
            );
        }

        let replanned = plan_request(&request, &registry).expect("replan should succeed");
        assert!(replanned
            .files
            .iter()
            .all(|file| file.status == PlanFileStatus::Noop));

        cleanup_dir(&dir);
    }
}
