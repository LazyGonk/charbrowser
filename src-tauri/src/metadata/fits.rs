use crate::metadata::types::FileMetadata;
use crate::metadata::utils::{FITS_CARD_LENGTH, FITS_KEYWORD_LENGTH, FITS_KEYWORD_VALUE_START};
use std::io::Read;
use std::path::Path;

pub fn extract_fits_metadata(
    path: &Path,
    file_name: String,
    file_path: String,
    file_size: u64,
    modified_timestamp: Option<i64>,
) -> Result<FileMetadata, String> {
    const FITS_BLOCK_SIZE: usize = 2880;
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

            let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH]).trim().to_string();
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

        let keyword = String::from_utf8_lossy(&card[..FITS_KEYWORD_LENGTH]).trim().to_string();
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
            "BSCALE" | "BZERO" | "EXPTIME" | "EXPOSURE" | "GAIN" | "SATURATE" | "AIRMASS" | "FOCUSPOS" | "CRVAL1" | "CRVAL2" | "CRPIX1" | "CRPIX2" | "CDELT1" | "CDELT2" | "CROTA1" | "CROTA2" => {
                if let Ok(val) = value_str.trim_matches('\'').trim().parse::<f64>() {
                    format_specific.insert(keyword.to_lowercase(), serde_json::json!(val));
                }
            }
            "OBJECT" | "TELESCOP" | "INSTRUME" | "OBSERVER" | "FILTER" | "DATE-OBS" | "DATE" | "TIME-OBS" | "UT" | "ST" | "RA" | "DEC" | "EPOCH" | "EQUINOX" | "RADECSYS" | "CTYPE1" | "CTYPE2" | "CUNIT1" | "CUNIT2" | "BUNIT" => {
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

    let width = format_specific.get("naxis1").and_then(|v| v.as_i64()).map(|v| v as u32);
    let height = format_specific.get("naxis2").and_then(|v| v.as_i64()).map(|v| v as u32);

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

/// Generates a thumbnail for a FITS image file.
///
/// FITS images often have very high dynamic range with most signal in a narrow
/// band near black. A plain linear mapping would produce nearly-black thumbnails.
/// This function applies BSCALE/BZERO physical scaling followed by an arcsinh
/// stretch (percentile-clamped at 1%/99%) to produce a visually informative
/// preview. FITS convention stores rows bottom-to-top, so the output is flipped.
///
/// # Parameters
/// - `file_path`: Absolute path to the `.fits` / `.fit` file.
/// - `max_size`: Longest thumbnail dimension in pixels.
///
/// # Returns
/// A `data:image/png;base64,...` string ready for the frontend preview panel.
/// Connects to: `mod.rs::generate_thumbnail` dispatcher → `main.rs::get_thumbnail` command.
pub fn generate_fits_thumbnail(file_path: &str, max_size: u32) -> Result<String, String> {
    const FITS_BLOCK_SIZE: usize = 2880;

    let file_bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read FITS file: {}", e))?;

    if file_bytes.len() < FITS_BLOCK_SIZE {
        return Err("File too small to be a valid FITS file".to_string());
    }

    // --- Parse header ---
    let mut naxis1: usize = 0;
    let mut naxis2: usize = 0;
    let mut bitpix: i32 = 16;
    let mut bscale: f64 = 1.0;
    let mut bzero: f64 = 0.0;
    let mut header_blocks: usize = 0;
    let mut found_end = false;

    let mut block_start = 0;
    while block_start + FITS_BLOCK_SIZE <= file_bytes.len() && !found_end {
        let block = &file_bytes[block_start..block_start + FITS_BLOCK_SIZE];
        header_blocks += 1;

        for card in block.chunks(FITS_CARD_LENGTH) {
            if card.len() < FITS_CARD_LENGTH {
                break;
            }
            let keyword = std::str::from_utf8(&card[..FITS_KEYWORD_LENGTH])
                .unwrap_or("")
                .trim();

            if keyword == "END" {
                found_end = true;
                break;
            }

            // Value cards have '=' at position 8
            if card.len() <= FITS_KEYWORD_VALUE_START || card[FITS_KEYWORD_LENGTH] != b'=' {
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
                "NAXIS1" => naxis1 = value_str.parse::<i64>().unwrap_or(0) as usize,
                "NAXIS2" => naxis2 = value_str.parse::<i64>().unwrap_or(0) as usize,
                "BITPIX" => bitpix = value_str.parse::<i32>().unwrap_or(16),
                "BSCALE" => bscale = value_str.parse::<f64>().unwrap_or(1.0),
                "BZERO"  => bzero  = value_str.parse::<f64>().unwrap_or(0.0),
                _ => {}
            }
        }

        block_start += FITS_BLOCK_SIZE;
    }

    if naxis1 == 0 || naxis2 == 0 {
        return Err("Invalid or missing FITS image dimensions".to_string());
    }

    // --- Read pixel data ---
    let data_start = header_blocks * FITS_BLOCK_SIZE;
    let bytes_per_pixel = (bitpix.unsigned_abs() / 8) as usize;
    let total_pixels = naxis1 * naxis2;
    let needed_bytes = total_pixels * bytes_per_pixel;

    if data_start + needed_bytes > file_bytes.len() {
        return Err("FITS file truncated: image data shorter than declared size".to_string());
    }

    let raw = &file_bytes[data_start..data_start + needed_bytes];

    // Convert raw bytes → f64 (all FITS values are big-endian)
    let raw_values: Vec<f64> = match bitpix {
        8 => raw.iter().map(|&b| b as f64).collect(),
        16 => raw.chunks_exact(2).map(|c| {
            i16::from_be_bytes([c[0], c[1]]) as f64
        }).collect(),
        32 => raw.chunks_exact(4).map(|c| {
            i32::from_be_bytes([c[0], c[1], c[2], c[3]]) as f64
        }).collect(),
        -32 => raw.chunks_exact(4).map(|c| {
            f32::from_be_bytes([c[0], c[1], c[2], c[3]]) as f64
        }).collect(),
        -64 => raw.chunks_exact(8).map(|c| {
            f64::from_be_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])
        }).collect(),
        _ => return Err(format!("Unsupported FITS BITPIX value: {}", bitpix)),
    };

    // Apply physical scaling: physical_value = raw * BSCALE + BZERO
    let physical: Vec<f64> = raw_values.iter().map(|&v| v * bscale + bzero).collect();

    // Apply arcsinh histogram stretch and convert to u8
    let stretched = apply_arcsinh_stretch(&physical);

    // FITS stores rows bottom-to-top — flip vertically so sky is up in the preview
    let mut flipped = vec![0u8; stretched.len()];
    for row in 0..naxis2 {
        let src_row = naxis2 - 1 - row;
        let dst = row * naxis1;
        let src = src_row * naxis1;
        flipped[dst..dst + naxis1].copy_from_slice(&stretched[src..src + naxis1]);
    }

    // Build grayscale image and scale to thumbnail size
    let img = image::GrayImage::from_raw(naxis1 as u32, naxis2 as u32, flipped)
        .ok_or("Failed to construct image buffer from FITS pixel data")?;

    let thumb = image::DynamicImage::ImageLuma8(img).thumbnail(max_size, max_size);

    let mut buffer = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
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
    let low_idx  = (n as f64 * 0.01) as usize;
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

    values.iter().map(|&v| {
        if !v.is_finite() {
            return 0u8;
        }
        let linear = ((v - min_val) / range).clamp(0.0, 1.0);
        let stretched = (linear * k).asinh() / scale; // → [0, 1]
        (stretched.clamp(0.0, 1.0) * 255.0) as u8
    }).collect()
}
