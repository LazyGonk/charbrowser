fn normalize_comfy_api_type(api_type: Option<String>) -> String {
    if api_type
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("runpod")
    {
        "runpod".to_string()
    } else {
        "local".to_string()
    }
}

fn runpod_base_url(endpoint_id: &str) -> Result<String, String> {
    let id = endpoint_id.trim();
    if id.is_empty() {
        return Err("RunPod endpoint ID is required".to_string());
    }
    Ok(format!("https://api.runpod.ai/v2/{}", id))
}

/// Tests connectivity to a ComfyUI server by calling the system stats endpoint.
#[tauri::command]
pub async fn comfyui_test_connection(
    endpoint: String,
    api_type: Option<String>,
    api_key: Option<String>,
    endpoint_id: Option<String>,
) -> Result<String, String> {
    let mode = normalize_comfy_api_type(api_type);
    let client = reqwest::Client::new();
    let base = if mode == "runpod" {
        runpod_base_url(&endpoint_id.unwrap_or_default())?
    } else {
        endpoint.trim_end_matches('/').to_string()
    };

    if base.is_empty() {
        return Err("ComfyUI endpoint is empty".to_string());
    }

    let url = if mode == "runpod" {
        format!("{}/health", base)
    } else {
        format!("{}/system_stats", base)
    };

    let mut request = client.get(&url);
    if mode == "runpod" {
        let key = api_key.unwrap_or_default();
        if key.trim().is_empty() {
            return Err("RunPod API key is required".to_string());
        }
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Server responded with {}", response.status()));
    }

    let payload: serde_json::Value = response.json().await.unwrap_or_else(|_| serde_json::json!({}));

    if mode == "runpod" {
        let status = payload["status"].as_str().unwrap_or("ok");
        return Ok(format!("Connected (RunPod: {})", status));
    }

    let version = payload["system"]["comfyui_version"]
        .as_str()
        .or_else(|| payload["version"].as_str())
        .unwrap_or("unknown");

    Ok(format!("Connected (ComfyUI {})", version))
}

/// Submits a ComfyUI workflow prompt and returns the created prompt id.
#[tauri::command]
pub async fn comfyui_submit_prompt(
    endpoint: String,
    workflow: serde_json::Value,
    api_type: Option<String>,
    api_key: Option<String>,
    endpoint_id: Option<String>,
) -> Result<String, String> {
    let mode = normalize_comfy_api_type(api_type);
    let client = reqwest::Client::new();
    let base = if mode == "runpod" {
        runpod_base_url(&endpoint_id.unwrap_or_default())?
    } else {
        endpoint.trim_end_matches('/').to_string()
    };

    if base.is_empty() {
        return Err("ComfyUI endpoint is empty".to_string());
    }

    let url = if mode == "runpod" {
        format!("{}/run", base)
    } else {
        format!("{}/prompt", base)
    };

    let body = if mode == "runpod" {
        serde_json::json!({
            "input": {
                "prompt": workflow
            }
        })
    } else {
        serde_json::json!({
            "prompt": workflow
        })
    };

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json");

    if mode == "runpod" {
        let key = api_key.unwrap_or_default();
        if key.trim().is_empty() {
            return Err("RunPod API key is required".to_string());
        }
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    let response = request
        .body(serde_json::to_string(&body).map_err(|e| format!("Serialize failed: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Submit failed ({}) and body could not be read: {}", status, e))?;
        return Err(format!("Submit failed ({}): {}", status, text));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    if mode == "runpod" {
        return payload["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "No job id in RunPod response".to_string());
    }

    payload["prompt_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "No prompt_id in ComfyUI response".to_string())
}

/// Returns one ComfyUI history payload for a prompt id.
#[tauri::command]
pub async fn comfyui_get_history(
    endpoint: String,
    prompt_id: String,
    api_type: Option<String>,
    api_key: Option<String>,
    endpoint_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mode = normalize_comfy_api_type(api_type);
    let client = reqwest::Client::new();
    let base = if mode == "runpod" {
        runpod_base_url(&endpoint_id.unwrap_or_default())?
    } else {
        endpoint.trim_end_matches('/').to_string()
    };

    if base.is_empty() {
        return Err("ComfyUI endpoint is empty".to_string());
    }

    let url = if mode == "runpod" {
        format!("{}/status/{}", base, prompt_id)
    } else {
        format!("{}/history/{}", base, prompt_id)
    };

    let mut request = client.get(&url);
    if mode == "runpod" {
        let key = api_key.unwrap_or_default();
        if key.trim().is_empty() {
            return Err("RunPod API key is required".to_string());
        }
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("History request failed ({})", response.status()));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Parse failed: {}", e))
}

/// Downloads one ComfyUI output image and returns it as a data URL.
#[tauri::command]
pub async fn comfyui_download_image(
    endpoint: String,
    filename: String,
    subfolder: String,
    image_type: String,
) -> Result<String, String> {
    use base64::Engine;

    let client = reqwest::Client::new();
    let base = endpoint.trim_end_matches('/');
    let mut url = reqwest::Url::parse(&format!("{}/view", base))
        .map_err(|e| format!("Invalid endpoint URL: {}", e))?;

    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("filename", &filename);
        pairs.append_pair("subfolder", &subfolder);
        pairs.append_pair("type", &image_type);
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Image download failed ({})", response.status()));
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| "image/png".to_string());

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image bytes: {}", e))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}
