use std::path::Path;

/// Lists supported media files in one directory.
#[tauri::command]
pub fn list_directory_files(dir_path: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir_path);

    if !path.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut files = Vec::new();
    let entries = std::fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    let ext = ext.to_string_lossy().to_lowercase();
                    if matches!(
                        ext.as_str(),
                        "png"
                            | "jpg"
                            | "jpeg"
                            | "gif"
                            | "bmp"
                            | "webp"
                            | "fits"
                            | "fit"
                            | "tif"
                            | "tiff"
                            | "nef"
                            | "arw"
                            | "orf"
                            | "pef"
                            | "rw2"
                            | "dng"
                            | "mp4"
                            | "mov"
                            | "avi"
                            | "mkv"
                            | "mp3"
                            | "wav"
                            | "flac"
                            | "ogg"
                            | "m4a"
                    ) {
                        if let Some(path_str) = path.to_str() {
                            files.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }

    files.sort();
    Ok(files)
}
