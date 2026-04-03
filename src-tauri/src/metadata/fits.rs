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
