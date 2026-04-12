/// Opens a URL in the system browser.
#[tauri::command]
pub fn open_url_in_system_browser(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    webbrowser::open(trimmed)
        .map(|_| ())
        .map_err(|e| format!("Failed to open URL: {}", e))
}

/// Opens an embedded legal document in the system browser using a generated HTML file.
#[tauri::command]
pub fn open_legal_document_in_system_browser(doc_id: String) -> Result<(), String> {
    let (title, body) = match doc_id.as_str() {
        "license" => ("MIT License", include_str!("../../../LICENSE")),
        "notices" => (
            "Third-Party Notices",
            include_str!("../../../THIRD_PARTY_NOTICES.md"),
        ),
        _ => return Err("Unknown legal document".to_string()),
    };

    let mut temp_path = std::env::temp_dir();
    temp_path.push(format!("charbrowser-{}.html", doc_id));

    let escaped = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font-family:Consolas,Monaco,monospace;background:#15161a;color:#d5d9e0;margin:0;padding:20px}}pre{{white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:13px;background:#1f2127;border:1px solid #2f3440;border-radius:8px;padding:16px}}</style></head><body><pre>{}</pre></body></html>",
        title,
        escaped
    );

    std::fs::write(&temp_path, html)
        .map_err(|e| format!("Failed to write temp document: {}", e))?;

    let file_url = format!("file:///{}", temp_path.to_string_lossy().replace('\\', "/"));
    webbrowser::open(&file_url)
        .map(|_| ())
        .map_err(|e| format!("Failed to open legal document: {}", e))
}
