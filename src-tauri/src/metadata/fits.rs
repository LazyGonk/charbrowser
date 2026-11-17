use crate::metadata::types::FileMetadata;
use crate::metadata::utils::{FITS_CARD_LENGTH, FITS_KEYWORD_LENGTH, FITS_KEYWORD_VALUE_START};
use crate::metadata::utils::write_with_backup;
use demosaic::{demosaic, Algorithm, CfaPattern};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::collections::HashMap;

const FITS_BLOCK_SIZE: usize = 2880;

/// Bayer color filter array pattern used by One-Shot Color (OSC) cameras.
#[derive(Clone, Copy, Debug)]
enum BayerPattern {
    RGGB,
    GRBG,
    GBRG,
    BGGR,
}

impl BayerPattern {
    fn from_str(s: &str) -> Option<Self> {
        match s.trim() {
            "RGGB" => Some(BayerPattern::RGGB),
            "GRBG" => Some(BayerPattern::GRBG),
            "GBRG" => Some(BayerPattern::GBRG),
            "BGGR" => Some(BayerPattern::BGGR),
            _ => None,
        }
    }

    fn to_cfa(self) -> CfaPattern {
        match self {
            BayerPattern::RGGB => CfaPattern::bayer_rggb(),
            BayerPattern::GRBG => CfaPattern::bayer_grbg(),
            BayerPattern::GBRG => CfaPattern::bayer_gbrg(),
            BayerPattern::BGGR => CfaPattern::bayer_bggr(),
        }
    }
}

fn infer_bayer_from_camera(instrume: &str) -> Option<BayerPattern> {
    if instrume.contains("ZWO") {
        Some(BayerPattern::RGGB)
    } else {
        None
    }
}

/// Converts a single-channel Bayer-pattern grayscale image to full RGB using bilinear interpolation.
fn debayer_to_rgb(gray: &[f64], width: usize, height: usize, pattern: BayerPattern) -> Result<Vec<u8>, String> {
    let total_pixels = width * height;

    // Convert f64 to f32 for demosaic crate
    let gray_f32: Vec<f32> = gray.iter().map(|&v| v as f32).collect();

    // Output buffer: planar CHW format [R plane, G plane, B plane]
    let mut rgb_planar = vec![0.0f32; 3 * total_pixels];

    // Apply bilinear demosaicing
    demosaic(
        &gray_f32,
        width,
        height,
        &pattern.to_cfa(),
        Algorithm::Bilinear,
        &mut rgb_planar,
    )
    .map_err(|e| format!("Demosaic failed: {}", e))?;

    // Convert planar CHW to interleaved RGB
    let r_plane = &rgb_planar[..total_pixels];
    let g_plane = &rgb_planar[total_pixels..2 * total_pixels];
    let b_plane = &rgb_planar[2 * total_pixels..];

    // Normalize each channel to 0-255 using percentile stretch
    let mut r_vals: Vec<f32> = r_plane.to_vec();
    let mut g_vals: Vec<f32> = g_plane.to_vec();
    let mut b_vals: Vec<f32> = b_plane.to_vec();

    r_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    g_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    b_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let low = total_pixels / 100;
    let high = (total_pixels * 99 / 100).min(total_pixels.saturating_sub(1));

    let r_range = (r_vals[high] - r_vals[low]).max(1.0);
    let g_range = (g_vals[high] - g_vals[low]).max(1.0);
    let b_range = (b_vals[high] - b_vals[low]).max(1.0);

    let r_min = r_vals[low];
    let g_min = g_vals[low];
    let b_min = b_vals[low];

    let mut output = vec![0u8; total_pixels * 3];
    for i in 0..total_pixels {
        let r = ((r_plane[i] - r_min) / r_range).clamp(0.0, 1.0) * 255.0;
        let g = ((g_plane[i] - g_min) / g_range).clamp(0.0, 1.0) * 255.0;
        let b = ((b_plane[i] - b_min) / b_range).clamp(0.0, 1.0) * 255.0;
        output[i * 3] = r as u8;
        output[i * 3 + 1] = g as u8;
        output[i * 3 + 2] = b as u8;
    }

    Ok(output)
}

pub fn extract_fits_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    const MAX_HEADER_CARDS: usize = 8192;

    let mut format_specific = serde_json::Map::new();
    format_specific.insert("format".to_string(), serde_json::json!("FITS"));

    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open FITS file: {}", e))?;
    let mut reader = std::io::BufReader::new(file);

    let mut cards: Vec<Vec<u8>> = Vec::new();
    let mut found_end = false;

    while cards.len() < MAX_HEADER_CARDS && !found_end {
        let mut block = vec![0u8; FITS_BLOCK_SIZE];
        let bytes_read = reader
            .read(&mut block)
            .map_err(|e| format!("Failed to read FITS header: {}", e))?;

        if bytes_read == 0 {
            break;
        }

        block.truncate(bytes_read);

        for card in block.chunks(FITS_CARD_LENGTH) {
            if card.len() < FITS_CARD_LENGTH {
                break;
            }

            let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH])
                .trim()
                .to_string();
            cards.push(card.to_vec());

            if keyword == "END" {
                found_end = true;
                break;
            }

            if cards.len() >= MAX_HEADER_CARDS {
                break;
            }
        }

        if bytes_read < FITS_BLOCK_SIZE {
            break;
        }
    }

    if cards.is_empty() {
        return Err("File too small to be a valid FITS file".to_string());
    }

    for card in cards {
        if card.len() < FITS_CARD_LENGTH {
            continue;
        }

        let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH])
            .trim()
            .to_string();
        if keyword.is_empty() {
            continue;
        }

        if keyword == "END" {
            break;
        }

        if card.len() <= FITS_KEYWORD_VALUE_START || card[FITS_KEYWORD_LENGTH] != b'=' {
            continue;
        }

        let value_part = String::from_utf8_lossy(&card[FITS_KEYWORD_VALUE_START..]);
        let value_str = if let Some(comment_pos) = value_part.find('/') {
            value_part[..comment_pos].trim().to_string()
        } else {
            value_part.trim().to_string()
        };

        if value_str.is_empty() {
            continue;
        }

        match keyword.as_str() {
            "SIMPLE" | "EXTEND" | "GROUPS" => {
                let clean_val = value_str.trim_matches('\'').trim();
                let val = clean_val == "T" || clean_val == "t";
                format_specific.insert(keyword.to_lowercase(), serde_json::json!(val));
            }
            "BITPIX" | "NAXIS" | "NAXIS1" | "NAXIS2" | "NAXIS3" | "GCOUNT" | "PCOUNT" => {
                if let Ok(val) = value_str.trim_matches('\'').trim().parse::<i32>() {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(val));
                }
            }
            "BSCALE" | "BZERO" | "EXPTIME" | "EXPOSURE" | "GAIN" | "SATURATE" | "AIRMASS"
            | "FOCUSPOS" | "CRVAL1" | "CRVAL2" | "CRPIX1" | "CRPIX2" | "CDELT1" | "CDELT2"
            | "CROTA1" | "CROTA2" => {
                if let Ok(val) = value_str.trim_matches('\'').trim().parse::<f64>() {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(val));
                }
            }
            "OBJECT" | "TELESCOP" | "INSTRUME" | "OBSERVER" | "FILTER" | "DATE-OBS" | "DATE"
            | "TIME-OBS" | "UT" | "ST" | "RA" | "DEC" | "EPOCH" | "EQUINOX" | "RADECSYS"
            | "CTYPE1" | "CTYPE2" | "CUNIT1" | "CUNIT2" | "BUNIT" => {
                let clean_value = value_str.trim_matches('\'').trim();
                if !clean_value.is_empty() {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(clean_value));
                }
            }
            _ => {
                let clean_value = value_str.trim_matches('\'').trim();
                if clean_value.is_empty() {
                    continue;
                }

                if clean_value.eq_ignore_ascii_case("T") {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(true));
                } else if clean_value.eq_ignore_ascii_case("F") {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(false));
                } else if let Ok(num_val) = clean_value.parse::<f64>() {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(num_val));
                } else {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(clean_value));
                }
            }
        }
    }

    let width = format_specific
        .get("naxis1")
        .and_then(|v| v.as_i64())
        .map(|v| v as u32);
    let height = format_specific
        .get("naxis2")
        .and_then(|v| v.as_i64())
        .map(|v| v as u32);

    Ok(FileMetadata {
        file_name,
        file_path,
        file_size,
        modified_timestamp,
        file_type: "FITS".to_string(),
        width,
        height,
        duration: None,
        bit_rate: None,
        sample_rate: None,
        channels: None,
        format_specific: serde_json::Value::Object(format_specific),
    })
}

/// One requested keyword update. Keywords are matched after trimming and
/// uppercasing, so callers may pass user-typed names verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitsKeywordUpdate {
    pub keyword: String,
    pub value: String,
}

/// Outcome for one requested keyword. The variants are deliberately distinct so
/// a bulk plan can report structural rejection, a missing card, an unchanged
/// value, and a malformed/overlong card without collapsing them into one error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FitsKeywordOutcome {
    /// The card's formatted value differs from the requested one.
    Updated {
        keyword: String,
        offset: usize,
        old_value: String,
        new_value: String,
    },
    /// The card already carries the requested formatted value.
    Unchanged {
        keyword: String,
        offset: usize,
        value: String,
    },
    /// No card with this keyword exists in the primary HDU.
    Missing { keyword: String },
    /// The keyword is structural and protected by `is_read_only_fits_keyword`.
    ReadOnly { keyword: String },
    /// The value cannot be encoded in an 80-column card (or the card is not a
    /// `KEYWORD= value` card at all).
    Malformed {
        keyword: String,
        offset: Option<usize>,
        reason: String,
    },
}

/// Result of a pure header transformation: the rewritten bytes (same length as
/// the input) plus one outcome per requested keyword or matched card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitsKeywordUpdateReport {
    pub bytes: Vec<u8>,
    pub outcomes: Vec<FitsKeywordOutcome>,
    /// Cards whose bytes actually changed. Zero for an all-noop request.
    pub applied: usize,
}

/// Rewrites existing 80-column header cards in place.
///
/// Pure bytes-in/bytes-out: the returned buffer is the same length as the input,
/// so the END card, the header block padding, and every pixel byte keep their
/// offsets. Only cards already present in the primary HDU are touched; new
/// keywords are never inserted, and extension HDUs after the first END card are
/// never read. Comments on the matched cards are preserved.
pub fn update_fits_keyword_cards(
    bytes: &[u8],
    updates: &[FitsKeywordUpdate],
) -> Result<FitsKeywordUpdateReport, String> {
    if bytes.len() < FITS_CARD_LENGTH {
        return Err("File too small to be a valid FITS file".to_string());
    }

    let mut requested: Vec<(String, String)> = Vec::new();
    for update in updates {
        let keyword = update.keyword.trim().to_uppercase();
        let value = update.value.trim().to_string();
        match requested.iter_mut().find(|(existing, _)| *existing == keyword) {
            Some(entry) => entry.1 = value,
            None => requested.push((keyword, value)),
        }
    }

    let mut output = bytes.to_vec();
    let mut outcomes = Vec::new();
    let mut matched = vec![false; requested.len()];
    let mut applied = 0usize;
    let mut offset = 0usize;

    while offset + FITS_CARD_LENGTH <= output.len() {
        let card = &output[offset..offset + FITS_CARD_LENGTH];
        let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH])
            .trim()
            .to_uppercase();

        if keyword == "END" {
            for (index, (requested_keyword, _)) in requested.iter().enumerate() {
                if requested_keyword == "END" {
                    matched[index] = true;
                    outcomes.push(FitsKeywordOutcome::ReadOnly {
                        keyword: "END".to_string(),
                    });
                }
            }
            break;
        }

        if keyword.is_empty() {
            offset += FITS_CARD_LENGTH;
            continue;
        }

        let Some(index) = requested
            .iter()
            .position(|(requested_keyword, _)| *requested_keyword == keyword)
        else {
            offset += FITS_CARD_LENGTH;
            continue;
        };
        matched[index] = true;

        if is_read_only_fits_keyword(&keyword) {
            outcomes.push(FitsKeywordOutcome::ReadOnly {
                keyword: keyword.clone(),
            });
            offset += FITS_CARD_LENGTH;
            continue;
        }

        if card[FITS_KEYWORD_LENGTH] != b'=' {
            outcomes.push(FitsKeywordOutcome::Malformed {
                keyword: keyword.clone(),
                offset: Some(offset),
                reason: format!(
                    "FITS card for {} is not an editable keyword card (no '=' value field).",
                    keyword
                ),
            });
            offset += FITS_CARD_LENGTH;
            continue;
        }

        let old_value = extract_fits_value_token(card);
        let new_value = format_fits_value(&requested[index].1);

        // Semantically equal values never rewrite the card, even when the
        // existing card is not in canonical spacing (idempotent re-plans).
        if old_value == new_value {
            outcomes.push(FitsKeywordOutcome::Unchanged {
                keyword,
                offset,
                value: new_value,
            });
            offset += FITS_CARD_LENGTH;
            continue;
        }

        let comment = extract_fits_comment(card);
        match build_fits_card(&keyword, &requested[index].1, comment.as_deref()) {
            Ok(new_card) => {
                output[offset..offset + FITS_CARD_LENGTH].copy_from_slice(&new_card);
                applied += 1;
                outcomes.push(FitsKeywordOutcome::Updated {
                    keyword,
                    offset,
                    old_value,
                    new_value,
                });
            }
            Err(reason) => outcomes.push(FitsKeywordOutcome::Malformed {
                keyword,
                offset: Some(offset),
                reason,
            }),
        }

        offset += FITS_CARD_LENGTH;
    }

    for (index, (keyword, _)) in requested.iter().enumerate() {
        if !matched[index] {
            outcomes.push(FitsKeywordOutcome::Missing {
                keyword: keyword.clone(),
            });
        }
    }

    Ok(FitsKeywordUpdateReport {
        bytes: output,
        outcomes,
        applied,
    })
}

/// Updates editable FITS header cards in place without shifting data blocks.
///
/// Thin adapter over [`update_fits_keyword_cards`] kept for the single-file
/// command: it preserves the previous error surface (one message, no write when
/// any card cannot be built) while sharing the transformation with bulk edit.
pub fn update_fits_header_fields(
    path: &Path,
    updates: &HashMap<String, String>,
) -> Result<usize, String> {
    if updates.is_empty() {
        return Err("No metadata updates provided.".to_string());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read FITS file: {}", e))?;
    let requested: Vec<FitsKeywordUpdate> = updates
        .iter()
        .map(|(keyword, value)| FitsKeywordUpdate {
            keyword: keyword.clone(),
            value: value.clone(),
        })
        .collect();

    let report = update_fits_keyword_cards(&bytes, &requested)?;

    if let Some(reason) = report.outcomes.iter().find_map(|outcome| match outcome {
        FitsKeywordOutcome::Malformed { reason, .. } => Some(reason.clone()),
        _ => None,
    }) {
        return Err(reason);
    }

    if report.applied == 0 {
        return Err("No editable FITS header fields matched the provided updates.".to_string());
    }

    write_with_backup(path, &report.bytes)?;
    Ok(report.applied)
}

/// Reads the editable keyword cards of a primary FITS header.
///
/// Pure bytes-in/values-out: nothing is written and no temp file is created.
/// Walks 80-column cards up to the first `END`, returning each editable keyword
/// with the formatted value token [`extract_fits_value_token`] would compare
/// against. Structural ([`is_read_only_fits_keyword`]), blank, and
/// comment/history cards (any card whose column 9 is not `=`) are skipped.
///
/// A buffer shorter than one card, or a header with no `END`, is an error: the
/// bytes cannot be treated as a FITS header without guessing where it stops.
pub fn read_fits_keyword_cards(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    if bytes.len() < FITS_CARD_LENGTH {
        return Err("File too small to be a valid FITS file".to_string());
    }

    let mut cards = Vec::new();
    let mut offset = 0usize;
    let mut found_end = false;

    while offset + FITS_CARD_LENGTH <= bytes.len() {
        let card = &bytes[offset..offset + FITS_CARD_LENGTH];
        let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH])
            .trim()
            .to_uppercase();

        if keyword == "END" {
            found_end = true;
            break;
        }
        offset += FITS_CARD_LENGTH;

        if keyword.is_empty() || card[FITS_KEYWORD_LENGTH] != b'=' {
            continue;
        }
        if is_read_only_fits_keyword(&keyword) {
            continue;
        }

        cards.push((keyword, extract_fits_value_token(card)));
    }

    if !found_end {
        return Err(
            "FITS header is truncated: no END card was found in the primary HDU.".to_string(),
        );
    }

    Ok(cards)
}

/// Returns true if FITS keyword is considered structural/read-only.
fn is_read_only_fits_keyword(keyword: &str) -> bool {
    matches!(
        keyword,
        "SIMPLE" | "BITPIX" | "NAXIS" | "NAXIS1" | "NAXIS2" | "NAXIS3" | "EXTEND" | "GCOUNT" | "PCOUNT"
    )
}

/// Splits a card's value field from its comment.
///
/// A `/` inside a quoted string belongs to the value, not the comment; `''` is
/// an escaped quote inside a string. The value runs to the first `/` outside
/// quotes (or the end of the field), and the comment is everything after it.
fn split_fits_value_and_comment(tail: &str) -> (&str, Option<&str>) {
    let bytes = tail.as_bytes();
    let mut in_string = false;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' => {
                if in_string && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2; // escaped quote, still inside the string
                    continue;
                }
                in_string = !in_string;
            }
            b'/' if !in_string => {
                let comment = tail[index + 1..].trim();
                return (
                    &tail[..index],
                    if comment.is_empty() {
                        None
                    } else {
                        Some(comment)
                    },
                );
            }
            _ => {}
        }
        index += 1;
    }

    (tail, None)
}

/// Extracts comment part from a raw FITS card after the value field.
fn extract_fits_comment(card: &[u8]) -> Option<String> {
    if card.len() < FITS_CARD_LENGTH {
        return None;
    }

    let tail = String::from_utf8_lossy(&card[FITS_KEYWORD_VALUE_START..]).to_string();
    split_fits_value_and_comment(&tail).1.map(str::to_string)
}

/// Reads the current formatted value token from a card so review rows show the
/// on-disk representation (quotes included) rather than a parsed value.
///
/// Quoted strings are normalized to `'<content>'` with FITS trailing padding
/// removed, so an already-correct `'M42     '` card compares equal to a newly
/// formatted `'M42'` and plans as unchanged. Slashes inside quotes are part of
/// the value; only a slash outside quotes starts the comment.
fn extract_fits_value_token(card: &[u8]) -> String {
    let tail = String::from_utf8_lossy(&card[FITS_KEYWORD_VALUE_START..]).to_string();
    let value = split_fits_value_and_comment(&tail).0.trim();

    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        let inner = &value[1..value.len() - 1];
        format!("'{}'", inner.trim_end())
    } else {
        value.to_string()
    }
}

/// Builds one 80-column FITS card for an existing keyword.
fn build_fits_card(keyword: &str, value: &str, comment: Option<&str>) -> Result<[u8; FITS_CARD_LENGTH], String> {
    let value_repr = format_fits_value(value);
    let mut card_text = format!("{:<8}= {}", keyword, value_repr);

    if let Some(comment_text) = comment {
        card_text.push_str(" / ");
        card_text.push_str(comment_text);
    }

    if card_text.len() > FITS_CARD_LENGTH {
        return Err(format!(
            "Updated value for {} exceeds {}-character FITS card limit",
            keyword, FITS_CARD_LENGTH
        ));
    }

    let mut out = [b' '; FITS_CARD_LENGTH];
    out[..card_text.len()].copy_from_slice(card_text.as_bytes());
    Ok(out)
}

/// Formats one input value using FITS-friendly scalar encoding.
fn format_fits_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("true") || trimmed.eq_ignore_ascii_case("t") {
        return "T".to_string();
    }
    if trimmed.eq_ignore_ascii_case("false") || trimmed.eq_ignore_ascii_case("f") {
        return "F".to_string();
    }

    if trimmed.parse::<i64>().is_ok() || trimmed.parse::<f64>().is_ok() {
        return trimmed.to_string();
    }

    let escaped = trimmed.replace('"', "").replace('\'', "''");
    format!("'{}'", escaped)
}

/// Header fields needed to render a preview without touching the pixel data.
struct FitsImageHeader {
    naxis1: usize,
    naxis2: usize,
    naxis3: usize,
    bitpix: i32,
    bscale: f64,
    bzero: f64,
    bayer_pattern: Option<BayerPattern>,
    /// Byte offset of the first pixel, i.e. the end of the primary header.
    data_start: u64,
}

/// Streams the primary FITS header from `file`, leaving the cursor just past the
/// last header block. Pixel data is never loaded here.
fn parse_fits_image_header(file: &mut std::fs::File) -> Result<FitsImageHeader, String> {
    let mut naxis1: usize = 0;
    let mut naxis2: usize = 0;
    let mut naxis3: usize = 0;
    let mut bitpix: i32 = 16;
    let mut bscale: f64 = 1.0;
    let mut bzero: f64 = 0.0;
    let mut bayerpat: Option<String> = None;
    let mut instrume: Option<String> = None;
    let mut header_blocks: u64 = 0;
    let mut found_end = false;

    while !found_end {
        let mut block = [0u8; FITS_BLOCK_SIZE];
        file.read_exact(&mut block)
            .map_err(|e| format!("Failed to read FITS header: {}", e))?;
        header_blocks += 1;

        for card in block.chunks(FITS_CARD_LENGTH) {
            let keyword = std::str::from_utf8(&card[..FITS_KEYWORD_LENGTH])
                .unwrap_or("")
                .trim();

            if keyword == "END" {
                found_end = true;
                break;
            }

            // Value cards have '=' at position 8
            if card[FITS_KEYWORD_LENGTH] != b'=' {
                continue;
            }

            let value_str = std::str::from_utf8(&card[FITS_KEYWORD_VALUE_START..])
                .unwrap_or("")
                .trim();
            // Strip inline comment starting with '/'
            let value_str = if let Some(pos) = value_str.find('/') {
                value_str[..pos].trim()
            } else {
                value_str
            };

            match keyword {
                "NAXIS1" => {
                    if let Ok(value) = value_str.parse::<i64>() {
                        naxis1 = value.max(0) as usize;
                    }
                }
                "NAXIS2" => {
                    if let Ok(value) = value_str.parse::<i64>() {
                        naxis2 = value.max(0) as usize;
                    }
                }
                "NAXIS3" => {
                    if let Ok(value) = value_str.parse::<i64>() {
                        naxis3 = value.max(0) as usize;
                    }
                }
                "BITPIX" => bitpix = value_str.parse::<i32>().unwrap_or(16),
                "BSCALE" => bscale = value_str.parse::<f64>().unwrap_or(1.0),
                "BZERO" => bzero = value_str.parse::<f64>().unwrap_or(0.0),
                "BAYERPAT" => bayerpat = Some(value_str.trim_matches('\'').to_string()),
                "INSTRUME" => instrume = Some(value_str.trim_matches('\'').to_string()),
                _ => {}
            }
        }
    }

    let mut bayer_pattern = bayerpat.as_ref().and_then(|s| BayerPattern::from_str(s));
    if bayer_pattern.is_none() {
        if let Some(cam) = &instrume {
            bayer_pattern = infer_bayer_from_camera(cam);
        }
    }

    Ok(FitsImageHeader {
        naxis1,
        naxis2,
        naxis3,
        bitpix,
        bscale,
        bzero,
        bayer_pattern,
        data_start: header_blocks * FITS_BLOCK_SIZE as u64,
    })
}

fn sampled_len(n: usize, stride: usize) -> usize {
    n.saturating_add(stride - 1) / stride
}

/// Decodes one big-endian FITS sample from an already-read row buffer.
fn decode_fits_sample(row: &[u8], pixel_index: usize, bitpix: i32) -> f64 {
    match bitpix {
        8 => row[pixel_index] as f64,
        16 => {
            let i = pixel_index * 2;
            i16::from_be_bytes([row[i], row[i + 1]]) as f64
        }
        32 => {
            let i = pixel_index * 4;
            i32::from_be_bytes([row[i], row[i + 1], row[i + 2], row[i + 3]]) as f64
        }
        -32 => {
            let i = pixel_index * 4;
            f32::from_be_bytes([row[i], row[i + 1], row[i + 2], row[i + 3]]) as f64
        }
        -64 => {
            let i = pixel_index * 8;
            f64::from_be_bytes([
                row[i],
                row[i + 1],
                row[i + 2],
                row[i + 3],
                row[i + 4],
                row[i + 5],
                row[i + 6],
                row[i + 7],
            ])
        }
        _ => f64::NAN,
    }
}

/// Reads a decimated grid from one image plane using seek+read: one full source
/// row per sampled row, then only the sampled columns from that row.
#[allow(clippy::too_many_arguments)]
fn read_sampled_plane(
    file: &mut std::fs::File,
    plane_offset: u64,
    naxis1: usize,
    naxis2: usize,
    stride: usize,
    sample_width: usize,
    sample_height: usize,
    bytes_per_pixel: usize,
    bitpix: i32,
    bscale: f64,
    bzero: f64,
) -> Result<Vec<f64>, String> {
    let row_bytes = naxis1
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| "FITS row size overflows".to_string())?;
    let mut row = vec![0u8; row_bytes];
    let mut samples = vec![0.0f64; sample_width * sample_height];

    for y in 0..sample_height {
        let src_row = y.saturating_mul(stride).min(naxis2 - 1);
        let row_offset = plane_offset + (src_row as u64).saturating_mul(row_bytes as u64);
        file.seek(SeekFrom::Start(row_offset))
            .map_err(|e| format!("Failed to seek in FITS file: {}", e))?;
        file.read_exact(&mut row)
            .map_err(|e| format!("Failed to read FITS pixel row: {}", e))?;

        for x in 0..sample_width {
            let src_col = x.saturating_mul(stride).min(naxis1 - 1);
            samples[y * sample_width + x] =
                decode_fits_sample(&row, src_col, bitpix) * bscale + bzero;
        }
    }

    Ok(samples)
}

/// Generates a thumbnail for a FITS image file.
///
/// FITS images often have very high dynamic range with most signal in a narrow
/// band near black. A plain linear mapping would produce nearly-black thumbnails.
/// This function applies BSCALE/BZERO physical scaling followed by an arcsinh
/// stretch (percentile-clamped at 1%/99%) to produce a visually informative
/// preview. FITS convention stores rows bottom-to-top, so the output is flipped.
///
/// The header is streamed first, then only sampled rows and columns are read
/// with seek+read at a stride derived from `max_size`. The stretch and flip run
/// on that small mosaic, never on a full-resolution buffer.
///
/// # Parameters
/// - `file_path`: Absolute path to the `.fits` / `.fit` file.
/// - `max_size`: Longest thumbnail dimension in pixels.
///
/// # Returns
/// A `data:image/png;base64,...` string ready for the frontend preview panel.
/// Connects to: `mod.rs::generate_thumbnail` dispatcher → `main.rs::get_thumbnail` command.
pub fn generate_fits_thumbnail(file_path: &str, max_size: u32) -> Result<String, String> {
    let mut file =
        std::fs::File::open(file_path).map_err(|e| format!("Failed to open FITS file: {}", e))?;
    let header = parse_fits_image_header(&mut file)?;

    let naxis1 = header.naxis1;
    let naxis2 = header.naxis2;
    let bitpix = header.bitpix;
    let bscale = header.bscale;
    let bzero = header.bzero;

    if naxis1 == 0 || naxis2 == 0 {
        return Err("Invalid or missing FITS image dimensions".to_string());
    }

    // --- Compute decimation stride and sampled dimensions ---
    let max_size = max_size.max(1) as usize;
    let bytes_per_pixel = match bitpix {
        8 => 1,
        16 => 2,
        32 | -32 => 4,
        -64 => 8,
        _ => return Err(format!("Unsupported FITS BITPIX value: {}", bitpix)),
    };

    let total_pixels = naxis1
        .checked_mul(naxis2)
        .ok_or_else(|| "FITS image dimensions overflow".to_string())?;
    let plane_bytes = total_pixels
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| "FITS image dimensions overflow".to_string())?;
    let plane_count = if header.naxis3 == 3 { 3 } else { 1 };
    let required_bytes = plane_bytes
        .checked_mul(plane_count)
        .ok_or_else(|| "FITS image dimensions overflow".to_string())?;

    // Truncation is detected from the file length — the pixel buffer is never loaded.
    let file_len = std::fs::metadata(file_path)
        .map_err(|e| format!("Failed to read FITS file metadata: {}", e))?
        .len();
    let required_end = header
        .data_start
        .checked_add(required_bytes as u64)
        .ok_or_else(|| "FITS image dimensions overflow".to_string())?;
    if file_len < required_end {
        return Err("FITS file truncated: image data shorter than declared size".to_string());
    }

    let mut stride = naxis1.max(naxis2).saturating_add(max_size - 1) / max_size;
    stride = stride.max(1);

    let mut sample_width = sampled_len(naxis1, stride);
    let mut sample_height = sampled_len(naxis2, stride);

    if header.bayer_pattern.is_some() {
        // A CFA mosaic only debayers correctly when the decimation preserves the
        // 2x2 phase anchored at pixel (0, 0): keep the stride and both sampled
        // dimensions even.
        if stride % 2 != 0 {
            stride += 1;
        }
        if naxis1 < 2 || naxis2 < 2 {
            return Err("Bayer FITS image is too small to debayer".to_string());
        }
        sample_width = (sampled_len(naxis1, stride).min(naxis1) & !1)
            .max(2)
            .min(naxis1);
        sample_height = (sampled_len(naxis2, stride).min(naxis2) & !1)
            .max(2)
            .min(naxis2);
    }

    // --- Read only the sampled rows/columns of each plane ---
    let (r_data, g_data, b_data) = if header.naxis3 == 3 {
        // Three-plane RGB cube: every plane is sampled at identical offsets.
        let r = read_sampled_plane(
            &mut file,
            header.data_start,
            naxis1,
            naxis2,
            stride,
            sample_width,
            sample_height,
            bytes_per_pixel,
            bitpix,
            bscale,
            bzero,
        )?;
        let g = read_sampled_plane(
            &mut file,
            header.data_start + plane_bytes as u64,
            naxis1,
            naxis2,
            stride,
            sample_width,
            sample_height,
            bytes_per_pixel,
            bitpix,
            bscale,
            bzero,
        )?;
        let b = read_sampled_plane(
            &mut file,
            header.data_start + 2 * plane_bytes as u64,
            naxis1,
            naxis2,
            stride,
            sample_width,
            sample_height,
            bytes_per_pixel,
            bitpix,
            bscale,
            bzero,
        )?;
        (r, g, b)
    } else if let Some(pattern) = header.bayer_pattern {
        // Debayer the decimated CFA mosaic; stride and sampled dimensions are
        // even, so the CFA phase is still anchored at pixel (0, 0).
        let mosaic = read_sampled_plane(
            &mut file,
            header.data_start,
            naxis1,
            naxis2,
            stride,
            sample_width,
            sample_height,
            bytes_per_pixel,
            bitpix,
            bscale,
            bzero,
        )?;
        let rgb = debayer_to_rgb(&mosaic, sample_width, sample_height, pattern)?;
        let mut r = vec![0.0; sample_width * sample_height];
        let mut g = vec![0.0; sample_width * sample_height];
        let mut b = vec![0.0; sample_width * sample_height];
        for i in 0..(sample_width * sample_height) {
            r[i] = rgb[i * 3] as f64;
            g[i] = rgb[i * 3 + 1] as f64;
            b[i] = rgb[i * 3 + 2] as f64;
        }
        (r, g, b)
    } else {
        // Monochrome - replicate to RGB for consistent output
        let mono = read_sampled_plane(
            &mut file,
            header.data_start,
            naxis1,
            naxis2,
            stride,
            sample_width,
            sample_height,
            bytes_per_pixel,
            bitpix,
            bscale,
            bzero,
        )?;
        (mono.clone(), mono.clone(), mono)
    };

    // Apply arcsinh stretch to each channel and combine to RGB bytes
    let r_stretched = apply_arcsinh_stretch(&r_data);
    let g_stretched = apply_arcsinh_stretch(&g_data);
    let b_stretched = apply_arcsinh_stretch(&b_data);

    let mut rgb_bytes = vec![0u8; sample_width * sample_height * 3];
    for i in 0..(sample_width * sample_height) {
        rgb_bytes[i * 3] = r_stretched[i];
        rgb_bytes[i * 3 + 1] = g_stretched[i];
        rgb_bytes[i * 3 + 2] = b_stretched[i];
    }

    // FITS stores rows bottom-to-top — flip the small decimated mosaic
    let mut flipped = vec![0u8; rgb_bytes.len()];
    for row in 0..sample_height {
        let src_row = sample_height - 1 - row;
        let dst = row * sample_width * 3;
        let src = src_row * sample_width * 3;
        flipped[dst..dst + sample_width * 3]
            .copy_from_slice(&rgb_bytes[src..src + sample_width * 3]);
    }

    // Build RGB image and scale to thumbnail size
    let img = image::RgbImage::from_raw(sample_width as u32, sample_height as u32, flipped)
        .ok_or_else(|| "Failed to extract FITS data into an image buffer".to_string())?;

    let thumb = image::DynamicImage::ImageRgb8(img).thumbnail(max_size as u32, max_size as u32);

    let mut buffer = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut buffer),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("Failed to encode FITS thumbnail: {}", e))?;

    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buffer)
    ))
}

/// Applies a percentile-clamped arcsinh stretch to a slice of physical pixel values,
/// returning 8-bit output suitable for a grayscale image.
///
/// Arcsinh stretching is standard practice in astronomical imaging: it compresses
/// the bright end of the dynamic range while preserving faint signal detail — far
/// better than a plain linear mapping would for deep-sky data.
///
/// Algorithm:
/// 1. Collect finite values and find the 1st and 99th percentiles.
/// 2. Normalize each pixel to the [0, 1] interval (clamped).
/// 3. Apply `asinh(x * k) / asinh(k)` where `k = 1.0` controls nonlinearity.
/// 4. Map the result to [0, 255].
fn apply_arcsinh_stretch(values: &[f64]) -> Vec<u8> {
    let mut finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();

    if finite.is_empty() {
        return vec![0u8; values.len()];
    }

    finite.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let n = finite.len();
    let low_idx = (n as f64 * 0.01) as usize;
    let high_idx = ((n as f64 * 0.99) as usize).min(n.saturating_sub(1));

    let min_val = finite[low_idx];
    let max_val = finite[high_idx];

    if (max_val - min_val).abs() < 1e-10 {
        // Flat image — return mid-grey so it's clearly visible rather than blank
        return vec![128u8; values.len()];
    }

    let range = max_val - min_val;
    // Stretch parameter k: higher values give more aggressive shadow boost
    let k: f64 = 1.0;
    let scale = k.asinh(); // precompute denominator

    values
        .iter()
        .map(|&v| {
            if !v.is_finite() {
                return 0u8;
            }
            let linear = ((v - min_val) / range).clamp(0.0, 1.0);
            let stretched = (linear * k).asinh() / scale; // → [0, 1]
            (stretched.clamp(0.0, 1.0) * 255.0) as u8
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const DATA_LEN: usize = FITS_BLOCK_SIZE;

    fn card(text: &str) -> Vec<u8> {
        assert!(
            text.len() <= FITS_CARD_LENGTH,
            "fixture card exceeds 80 columns: {:?}",
            text
        );
        let mut out = vec![b' '; FITS_CARD_LENGTH];
        out[..text.len()].copy_from_slice(text.as_bytes());
        out
    }

    /// Builds a primary header from value cards, appends END, and pads the
    /// header to a 2880-byte block so data offsets are realistic.
    fn header(cards: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for text in cards {
            out.extend_from_slice(&card(text));
        }
        out.extend_from_slice(&card("END"));
        while out.len() % FITS_BLOCK_SIZE != 0 {
            out.push(b' ');
        }
        out
    }

    fn data_block(seed: u8) -> Vec<u8> {
        (0..DATA_LEN)
            .map(|index| (index as u8).wrapping_add(seed))
            .collect()
    }

    fn image_cards() -> Vec<&'static str> {
        vec![
            "SIMPLE  =                    T",
            "BITPIX  =                   16",
            "NAXIS   =                    2",
            "NAXIS1  =                    4",
            "NAXIS2  =                    4",
            "OBJECT  = 'M31'                / target name",
            "OBSERVER= 'nick'",
        ]
    }

    fn image_file() -> Vec<u8> {
        let mut bytes = header(&image_cards());
        bytes.extend_from_slice(&data_block(7));
        bytes
    }

    fn find_keyword_offset(bytes: &[u8], keyword: &str) -> usize {
        bytes
            .chunks(FITS_CARD_LENGTH)
            .position(|card| {
                String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH]).trim() == keyword
            })
            .map(|index| index * FITS_CARD_LENGTH)
            .expect("keyword should exist")
    }

    fn card_text(bytes: &[u8], keyword: &str) -> String {
        let offset = find_keyword_offset(bytes, keyword);
        String::from_utf8_lossy(&bytes[offset..offset + FITS_CARD_LENGTH]).into_owned()
    }

    fn update(keyword: &str, value: &str) -> FitsKeywordUpdate {
        FitsKeywordUpdate {
            keyword: keyword.to_string(),
            value: value.to_string(),
        }
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "charbrowser-fits-{}-{}-{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    #[test]
    fn updates_existing_card_preserving_comment_end_and_data() {
        let original = image_file();
        let object_offset = find_keyword_offset(&original, "OBJECT");
        let end_offset = find_keyword_offset(&original, "END");

        let report =
            update_fits_keyword_cards(&original, &[update("OBJECT", "M42")]).expect("transform");

        assert_eq!(report.bytes.len(), original.len(), "header size must not move");
        assert_eq!(report.applied, 1);
        assert_eq!(
            report.outcomes,
            vec![FitsKeywordOutcome::Updated {
                keyword: "OBJECT".to_string(),
                offset: object_offset,
                old_value: "'M31'".to_string(),
                new_value: "'M42'".to_string(),
            }]
        );

        // Exactly one 80-column card changed; comments survive.
        assert_eq!(&report.bytes[..object_offset], &original[..object_offset]);
        assert_eq!(
            &report.bytes[object_offset + FITS_CARD_LENGTH..],
            &original[object_offset + FITS_CARD_LENGTH..]
        );
        let updated = card_text(&report.bytes, "OBJECT");
        assert!(updated.starts_with("OBJECT  = 'M42'"), "card: {:?}", updated);
        assert!(updated.contains("/ target name"), "card: {:?}", updated);

        // END stays at its old offset and every data byte is identical.
        assert_eq!(find_keyword_offset(&report.bytes, "END"), end_offset);
        assert_eq!(&report.bytes[end_offset..], &original[end_offset..]);
    }

    #[test]
    fn matches_keywords_case_insensitively_after_trimming() {
        let original = image_file();
        let report = update_fits_keyword_cards(&original, &[update("  object\t", "M42")])
            .expect("transform");

        assert_eq!(report.applied, 1);
        match &report.outcomes[0] {
            FitsKeywordOutcome::Updated { keyword, .. } => assert_eq!(keyword, "OBJECT"),
            other => panic!("expected an update, got {:?}", other),
        }
    }

    #[test]
    fn formats_boolean_numeric_and_string_values() {
        let original = header(&[
            "FLAGON  = F",
            "COUNT   = 1",
            "SCALE   = 1.0",
            "TARGET  = 'old'",
        ]);

        let report = update_fits_keyword_cards(
            &original,
            &[
                update("FLAGON", "true"),
                update("COUNT", "42"),
                update("SCALE", "1.50"),
                update("TARGET", "M42"),
            ],
        )
        .expect("transform");

        assert_eq!(report.applied, 4);
        assert!(card_text(&report.bytes, "FLAGON").starts_with("FLAGON  = T"));
        assert!(card_text(&report.bytes, "COUNT").starts_with("COUNT   = 42"));
        assert!(card_text(&report.bytes, "SCALE").starts_with("SCALE   = 1.50"));
        assert!(card_text(&report.bytes, "TARGET").starts_with("TARGET  = 'M42'"));

        let report = update_fits_keyword_cards(&original, &[update("FLAGON", "false")])
            .expect("transform");
        assert!(card_text(&report.bytes, "FLAGON").starts_with("FLAGON  = F"));
    }

    #[test]
    fn rejects_structural_keywords_without_touching_bytes() {
        let original = image_file();

        for keyword in ["SIMPLE", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "END"] {
            let report = update_fits_keyword_cards(&original, &[update(keyword, "1")])
                .expect("transform");
            assert_eq!(report.bytes, original, "{} must not be rewritten", keyword);
            assert_eq!(report.applied, 0, "{} must not count as applied", keyword);
            assert_eq!(
                report.outcomes,
                vec![FitsKeywordOutcome::ReadOnly {
                    keyword: keyword.to_string()
                }],
                "{} should report a structural rejection",
                keyword
            );
        }
    }

    #[test]
    fn reports_missing_keyword_without_touching_bytes() {
        let original = image_file();
        let report =
            update_fits_keyword_cards(&original, &[update("NOPE", "1")]).expect("transform");

        assert_eq!(report.bytes, original);
        assert_eq!(report.applied, 0);
        assert_eq!(
            report.outcomes,
            vec![FitsKeywordOutcome::Missing {
                keyword: "NOPE".to_string()
            }]
        );
    }

    #[test]
    fn rejects_overlength_cards_without_writing() {
        let comment = "x".repeat(60);
        let fixture = format!("LONGKEY = 'old' / {}", comment);
        let original = header(&[fixture.as_str()]);

        let report = update_fits_keyword_cards(&original, &[update("LONGKEY", &"n".repeat(30))])
            .expect("transform");

        assert_eq!(report.bytes, original, "overlong value must not truncate");
        assert_eq!(report.applied, 0);
        match &report.outcomes[0] {
            FitsKeywordOutcome::Malformed { reason, .. } => {
                assert!(reason.contains("exceeds 80-character"), "reason: {}", reason);
            }
            other => panic!("expected malformed, got {:?}", other),
        }
    }

    #[test]
    fn rejects_cards_without_a_value_field() {
        let original = header(&["COMMENT not a value card"]);
        let report =
            update_fits_keyword_cards(&original, &[update("COMMENT", "1")]).expect("transform");

        assert_eq!(report.bytes, original);
        assert_eq!(report.applied, 0);
        match &report.outcomes[0] {
            FitsKeywordOutcome::Malformed { reason, .. } => {
                assert!(reason.contains("not an editable keyword card"), "reason: {}", reason);
            }
            other => panic!("expected malformed, got {:?}", other),
        }
    }

    #[test]
    fn reports_unchanged_value_as_unchanged() {
        let original = header(&["OBJECT  = 'M42' / target name"]);

        let report =
            update_fits_keyword_cards(&original, &[update("OBJECT", "M42")]).expect("transform");
        assert_eq!(report.bytes, original);
        assert_eq!(report.applied, 0);
        assert_eq!(
            report.outcomes,
            vec![FitsKeywordOutcome::Unchanged {
                keyword: "OBJECT".to_string(),
                offset: 0,
                value: "'M42'".to_string(),
            }]
        );

        // FITS space padding inside the quotes is normalization, not a new value.
        let padded = header(&["OBJECT  = 'M42     ' / target name"]);
        let report =
            update_fits_keyword_cards(&padded, &[update("OBJECT", "M42")]).expect("transform");
        assert!(matches!(
            report.outcomes[0],
            FitsKeywordOutcome::Unchanged { .. }
        ));
        assert_eq!(report.bytes, padded, "an equal token must not rewrite bytes");
        assert_eq!(report.applied, 0);
    }

    #[test]
    fn quoted_values_with_slashes_keep_their_comment() {
        let original = header(&["OBJECT  = '/data/m31.fits'  / target path"]);

        // Same value: the slash belongs to the string, so this is a no-op even
        // though the on-disk spacing is not canonical.
        let noop = update_fits_keyword_cards(&original, &[update("OBJECT", "/data/m31.fits")])
            .expect("transform");
        assert_eq!(noop.bytes, original);
        assert_eq!(noop.applied, 0);
        assert_eq!(
            noop.outcomes,
            vec![FitsKeywordOutcome::Unchanged {
                keyword: "OBJECT".to_string(),
                offset: 0,
                value: "'/data/m31.fits'".to_string(),
            }]
        );

        // Changed value: only the value bytes move; the comment survives.
        let changed = update_fits_keyword_cards(&original, &[update("OBJECT", "/data/m42.fits")])
            .expect("transform");
        assert_eq!(changed.applied, 1);
        assert_eq!(
            changed.outcomes,
            vec![FitsKeywordOutcome::Updated {
                keyword: "OBJECT".to_string(),
                offset: 0,
                old_value: "'/data/m31.fits'".to_string(),
                new_value: "'/data/m42.fits'".to_string(),
            }]
        );
        let card = card_text(&changed.bytes, "OBJECT");
        assert!(card.starts_with("OBJECT  = '/data/m42.fits'"), "card: {:?}", card);
        assert!(card.contains("/ target path"), "card: {:?}", card);
        assert_eq!(changed.bytes.len(), original.len());

        // `''` is an escaped quote, not the end of the string.
        let escaped = header(&["NOTE    = 'it''s / odd' / keep"]);
        let noop = update_fits_keyword_cards(&escaped, &[update("NOTE", "it's / odd")])
            .expect("transform");
        assert_eq!(noop.bytes, escaped);
        assert_eq!(noop.applied, 0);
        assert_eq!(
            noop.outcomes,
            vec![FitsKeywordOutcome::Unchanged {
                keyword: "NOTE".to_string(),
                offset: 0,
                value: "'it''s / odd'".to_string(),
            }]
        );

        let changed = update_fits_keyword_cards(&escaped, &[update("NOTE", "it's / even")])
            .expect("transform");
        let card = card_text(&changed.bytes, "NOTE");
        assert!(card.starts_with("NOTE    = 'it''s / even'"), "card: {:?}", card);
        assert!(card.contains("/ keep"), "card: {:?}", card);
    }

    #[test]
    fn leaves_extension_hdus_byte_identical() {
        let mut original = header(&image_cards());
        let extension = {
            let mut bytes = header(&[
                "XTENSION= 'IMAGE   '",
                "BITPIX  =                    8",
                "NAXIS   =                    0",
                "PCOUNT  =                    0",
                "GCOUNT  =                    1",
                "OBJECT  = 'EXT'",
            ]);
            bytes.extend_from_slice(&data_block(3));
            bytes
        };
        let extension_start = original.len();
        original.extend_from_slice(&extension);

        let report =
            update_fits_keyword_cards(&original, &[update("OBJECT", "M42")]).expect("transform");

        assert_eq!(report.applied, 1);
        assert_eq!(report.outcomes.len(), 1, "only the primary HDU is planned");
        assert_eq!(&report.bytes[extension_start..], &original[extension_start..]);
        assert!(card_text(&report.bytes, "OBJECT").starts_with("OBJECT  = 'M42'"));
    }

    #[test]
    fn reader_returns_editable_keywords_up_to_end() {
        let mut bytes = header(&[
            "SIMPLE  =                    T",
            "BITPIX  =                   16",
            "NAXIS   =                    2",
            "NAXIS1  =                    4",
            "NAXIS2  =                    4",
            "COMMENT   generated by the test rig",
            "HISTORY   exposure 30s",
            "OBJECT  = 'M31'                / target name",
            "OBSERVER= 'nick'",
            "EXPTIME =                 30.0",
            "FLAG    =                    T",
            "EMPTY   =                      ",
        ]);
        // An extension HDU after END must never be read.
        bytes.extend_from_slice(&header(&["OBJECT  = 'EXT'"]));

        let cards = read_fits_keyword_cards(&bytes).expect("primary header should parse");

        assert_eq!(
            cards,
            vec![
                ("OBJECT".to_string(), "'M31'".to_string()),
                ("OBSERVER".to_string(), "'nick'".to_string()),
                ("EXPTIME".to_string(), "30.0".to_string()),
                ("FLAG".to_string(), "T".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );

        // A truncated header (no END card) and a sub-card buffer are reported,
        // not silently treated as an empty header.
        let truncated = card("OBJECT  = 'M31'");
        let error = read_fits_keyword_cards(&truncated).expect_err("missing END must fail");
        assert!(error.contains("truncated"), "unexpected error: {}", error);
        let error = read_fits_keyword_cards(b"x").expect_err("tiny buffer must fail");
        assert!(error.contains("too small"), "unexpected error: {}", error);
    }

    #[test]
    fn single_file_command_shares_the_transform_and_keeps_its_error_surface() {
        let dir = unique_dir("adapter");
        let path = dir.join("frame.fits");
        let original = image_file();
        fs::write(&path, &original).expect("fixture should be writable");

        let mut updates = HashMap::new();
        updates.insert(" object ".to_string(), " M42 ".to_string());
        updates.insert("observer".to_string(), "Ann".to_string());

        assert_eq!(update_fits_header_fields(&path, &updates), Ok(2));

        let after = fs::read(&path).expect("file should be readable");
        assert_eq!(after.len(), original.len());
        assert!(card_text(&after, "OBJECT").contains("/ target name"));
        assert!(card_text(&after, "OBSERVER").starts_with("OBSERVER= 'Ann'"));

        let end_offset = find_keyword_offset(&after, "END");
        assert_eq!(&after[end_offset..], &original[end_offset..]);

        // No match, structural-only, and empty requests keep the old errors and
        // never touch the file.
        let mut missing = HashMap::new();
        missing.insert("NOPE".to_string(), "x".to_string());
        let error = update_fits_header_fields(&path, &missing).expect_err("missing must fail");
        assert!(
            error.contains("No editable FITS header fields matched"),
            "unexpected error: {}",
            error
        );

        let mut structural = HashMap::new();
        structural.insert("BITPIX".to_string(), "8".to_string());
        assert!(update_fits_header_fields(&path, &structural).is_err());

        let empty: HashMap<String, String> = HashMap::new();
        let error = update_fits_header_fields(&path, &empty).expect_err("empty must fail");
        assert!(error.contains("No metadata updates provided"), "error: {}", error);

        assert_eq!(fs::read(&path).expect("file should be readable"), after);

        let tiny = dir.join("tiny.fits");
        fs::write(&tiny, b"x").expect("tiny fixture should be writable");
        assert!(update_fits_header_fields(&tiny, &updates).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bulk_engine_plans_applies_journals_and_replans_as_noop() {
        use crate::bulk_edit::{
            apply_plan, default_registry, plan_request, BulkPlanRequest, FsWriter, MemoryJournal,
            OperationKind, OperationParams, PlanFileStatus,
        };

        let dir = unique_dir("engine");
        let path = dir.join("frame.fits");
        let original = image_file();
        fs::write(&path, &original).expect("fixture should be writable");
        let path_string = path.to_string_lossy().into_owned();

        let registry = default_registry();
        let request = BulkPlanRequest {
            paths: vec![path_string.clone()],
            params: OperationParams {
                operation: OperationKind::FitsSetKeyword,
                locator: " object ".to_string(),
                value: "M42".to_string(),
            },
        };

        let plan = plan_request(&request, &registry).expect("plan should succeed");
        assert_eq!(plan.files[0].status, PlanFileStatus::Changed);
        assert_eq!(
            plan.files[0].changes[0].locator,
            format!(
                "OBJECT@{}",
                find_keyword_offset(&original, "OBJECT")
            )
        );
        assert_eq!(plan.files[0].changes[0].old_value.as_deref(), Some("'M31'"));
        assert_eq!(plan.files[0].changes[0].new_value.as_deref(), Some("'M42'"));
        assert_eq!(
            fs::read(&path).expect("planning must not write"),
            original,
            "planning is read-only"
        );

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply");
        assert_eq!(result.applied, 1);
        assert_eq!(result.failed, 0);
        assert!(!result.journal_degraded);
        assert_eq!(journal.entries().len(), 1);
        assert_eq!(journal.entries()[0].locator, plan.files[0].changes[0].locator);

        let after = fs::read(&path).expect("file should be readable");
        assert_eq!(after.len(), original.len());
        assert!(card_text(&after, "OBJECT").starts_with("OBJECT  = 'M42'"));
        let end_offset = find_keyword_offset(&after, "END");
        assert_eq!(
            &after[end_offset..],
            &original[end_offset..],
            "header padding and pixel data must keep their bytes"
        );

        let replan = plan_request(&request, &registry).expect("replan should succeed");
        assert_eq!(replan.files[0].status, PlanFileStatus::Noop);
        let mut second_journal = MemoryJournal::new();
        let result =
            apply_plan(&replan, &registry, &FsWriter, &mut second_journal).expect("noop apply");
        assert_eq!(result.applied, 0);
        assert_eq!(result.skipped, 1);
        assert!(second_journal.entries().is_empty());
        assert_eq!(fs::read(&path).expect("file should be readable"), after);

        let _ = fs::remove_dir_all(&dir);
    }

    fn temp_fits_path(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "charbrowser-fits-{}-{}-{}.fits",
            label,
            std::process::id(),
            nanos
        ))
    }

    fn build_fits_header(
        naxis1: usize,
        naxis2: usize,
        planes: usize,
        bitpix: i32,
        bayer: Option<&str>,
    ) -> Vec<u8> {
        let mut cards: Vec<String> = Vec::new();
        cards.push(format!("{:<8}= {:>20}", "SIMPLE", "T"));
        cards.push(format!("{:<8}= {:>20}", "BITPIX", bitpix));
        cards.push(format!(
            "{:<8}= {:>20}",
            "NAXIS",
            if planes > 1 { 3 } else { 2 }
        ));
        cards.push(format!("{:<8}= {:>20}", "NAXIS1", naxis1));
        cards.push(format!("{:<8}= {:>20}", "NAXIS2", naxis2));
        if planes > 1 {
            cards.push(format!("{:<8}= {:>20}", "NAXIS3", planes));
        }
        if let Some(pattern) = bayer {
            cards.push(format!(
                "{:<8}= {:>20}",
                "BAYERPAT",
                format!("'{}'", pattern)
            ));
        }
        cards.push(format!("{:<8}= {:>20}", "BSCALE", "1.0"));
        cards.push(format!("{:<8}= {:>20}", "BZERO", "0.0"));
        cards.push("END".to_string());

        let mut header = vec![b' '; FITS_BLOCK_SIZE];
        for (i, card) in cards.iter().enumerate() {
            let start = i * FITS_CARD_LENGTH;
            header[start..start + card.len()].copy_from_slice(card.as_bytes());
        }
        header
    }

    fn write_fits_fixture(
        label: &str,
        naxis1: usize,
        naxis2: usize,
        planes: usize,
        bitpix: i32,
        bayer: Option<&str>,
    ) -> PathBuf {
        let mut bytes = build_fits_header(naxis1, naxis2, planes, bitpix, bayer);
        for plane in 0..planes {
            for y in 0..naxis2 {
                for x in 0..naxis1 {
                    let value = ((x * 7 + y * 13 + plane * 37) % 4000) as i64 - 2000;
                    match bitpix {
                        8 => bytes.push(value.clamp(0, 255) as u8),
                        16 => bytes.extend_from_slice(&(value as i16).to_be_bytes()),
                        32 => bytes.extend_from_slice(&(value as i32).to_be_bytes()),
                        -32 => bytes.extend_from_slice(&(value as f32).to_be_bytes()),
                        -64 => bytes.extend_from_slice(&(value as f64).to_be_bytes()),
                        _ => unreachable!(),
                    }
                }
            }
        }
        while bytes.len() % FITS_BLOCK_SIZE != 0 {
            bytes.push(0);
        }

        let path = temp_fits_path(label);
        std::fs::write(&path, bytes).expect("fixture write should succeed");
        path
    }

    fn png_dimensions(data_url: &str) -> (u32, u32) {
        use base64::Engine;
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .expect("thumbnail should be a PNG data URL");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("thumbnail payload should be valid base64");
        let image = image::load_from_memory(&bytes).expect("thumbnail should decode as PNG");
        (image.width(), image.height())
    }

    #[test]
    fn downscaled_mono_preview_respects_max_size_and_aspect() {
        let path = write_fits_fixture("mono16", 200, 100, 1, 16, None);
        let url = generate_fits_thumbnail(path.to_str().unwrap(), 64).expect("thumbnail generated");

        // 200x100 sampled at stride 4 -> 50x25, then fitted into a 64px box.
        assert_eq!(png_dimensions(&url), (64, 32));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rgb_cube_and_bayer_layouts_render_decimated_previews() {
        let cube = write_fits_fixture("cube", 120, 80, 3, 8, None);
        let (width, height) =
            png_dimensions(&generate_fits_thumbnail(cube.to_str().unwrap(), 64).expect("cube"));
        assert_eq!(width, 64);
        assert!(
            height <= 64,
            "cube preview height {} exceeds max_size",
            height
        );
        let _ = std::fs::remove_file(&cube);

        // Odd stride is forced even for a CFA mosaic, and both sampled
        // dimensions are truncated to even values.
        let bayer = write_fits_fixture("bayer", 200, 100, 1, 16, Some("RGGB"));
        let (width, height) =
            png_dimensions(&generate_fits_thumbnail(bayer.to_str().unwrap(), 64).expect("bayer"));
        assert_eq!(width, 64);
        assert!(
            height <= 64,
            "bayer preview height {} exceeds max_size",
            height
        );
        let _ = std::fs::remove_file(&bayer);
    }

    #[test]
    fn all_supported_bitpix_depths_render() {
        for bitpix in [8, 16, 32, -32, -64] {
            let label = format!("bitpix{}", bitpix);
            let path = write_fits_fixture(&label, 64, 32, 1, bitpix, None);
            let url = generate_fits_thumbnail(path.to_str().unwrap(), 64)
                .unwrap_or_else(|e| panic!("BITPIX {} failed: {}", bitpix, e));
            assert_eq!(png_dimensions(&url), (64, 32), "BITPIX {}", bitpix);
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn truncated_fits_is_rejected_from_file_length() {
        let mut bytes = build_fits_header(200, 100, 1, 16, None);
        bytes.extend(std::iter::repeat(0u8).take(64));
        let path = temp_fits_path("truncated");
        std::fs::write(&path, bytes).expect("fixture write should succeed");

        let error = generate_fits_thumbnail(path.to_str().unwrap(), 64).unwrap_err();
        assert!(error.contains("truncated"), "unexpected error: {}", error);

        let _ = std::fs::remove_file(&path);
    }
}
