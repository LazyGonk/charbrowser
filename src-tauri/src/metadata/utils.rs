use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MIN_BASE64_TOKEN_LEN: usize = 24;
pub const VIDEO_ATOM_MAX_SIZE: usize = 8 * 1024 * 1024;
pub const VIDEO_PREVIEW_MAX_SIZE: usize = 80 * 1024 * 1024;
pub const SYNCHSAFE_MASK: u32 = 0x07FFFFFF;
pub const SYNCHSAFE_BYTE_MASK: u32 = 0x7F;

pub const FLAC_BLOCK_TYPE_VORBIS_COMMENT: u8 = 4;
pub const FLAC_BLOCK_TYPE_PICTURE: u8 = 6;

pub const FITS_CARD_LENGTH: usize = 80;
pub const FITS_KEYWORD_LENGTH: usize = 8;
pub const FITS_KEYWORD_VALUE_START: usize = 10;

pub fn synchsafe_to_u32(bytes: &[u8]) -> u32 {
    if bytes.len() < 4 {
        return 0;
    }
    ((bytes[0] as u32) << 21)
        | ((bytes[1] as u32) << 14)
        | ((bytes[2] as u32) << 7)
        | (bytes[3] as u32)
}

pub fn synchsafe_24_to_u32(bytes: &[u8]) -> u32 {
    if bytes.len() < 3 {
        return 0;
    }
    ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | (bytes[2] as u32)
}

pub fn u32_to_synchsafe(value: u32) -> [u8; 4] {
    let v = value & SYNCHSAFE_MASK;
    [
        ((v >> 21) & SYNCHSAFE_BYTE_MASK) as u8,
        ((v >> 14) & SYNCHSAFE_BYTE_MASK) as u8,
        ((v >> 7) & SYNCHSAFE_BYTE_MASK) as u8,
        (v & SYNCHSAFE_BYTE_MASK) as u8,
    ]
}

pub fn build_backup_path(path: &Path) -> std::path::PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut backup = path.to_path_buf();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bak");
    backup.set_extension(format!("{}.charbrowser.{}.bak", ext, ts));
    backup
}

pub fn write_with_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let backup_path = build_backup_path(path);
    std::fs::copy(path, &backup_path)
        .map_err(|e| format!("Failed to create backup before write: {}", e))?;

    if let Err(e) = std::fs::write(path, bytes) {
        let _ = std::fs::copy(&backup_path, path);
        let _ = std::fs::remove_file(&backup_path);
        return Err(format!("Write failed: {}", e));
    }

    let _ = std::fs::remove_file(&backup_path);
    Ok(())
}
