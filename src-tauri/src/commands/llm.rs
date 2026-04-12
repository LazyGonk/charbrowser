use crate::LlmMessage;

const HTTP_REFERER: &str = "https://charbrowser.app";
const HTTP_TITLE: &str = "CharBrowser";

/// Returns normalized provider key used by backend request routing.
fn resolve_llm_provider(api_type: Option<&str>, endpoint: &str) -> String {
    if let Some(value) = api_type {
        let normalized = value.trim().to_lowercase();
        if !normalized.is_empty() {
            return normalized;
        }
    }

    let lower_endpoint = endpoint.to_lowercase();
    if lower_endpoint.contains("localhost:11434") || lower_endpoint.contains("ollama") {
        return "ollama".to_string();
    }
    if lower_endpoint.contains("openrouter.ai") {
        return "openrouter".to_string();
    }
    if lower_endpoint.contains("api.groq.com") {
        return "groq".to_string();
    }
    if lower_endpoint.contains("api.deepseek.com") {
        return "deepseek".to_string();
    }
    if lower_endpoint.contains("nano-gpt.com") {
        return "nanogpt".to_string();
    }

    "openai".to_string()
}

/// Returns true when provider requires a non-empty API key.
fn provider_requires_api_key(provider: &str) -> bool {
    matches!(provider, "openai" | "openrouter" | "groq" | "deepseek" | "nanogpt")
}

/// Retrieves available models from one OpenAI-compatible provider.
#[tauri::command]
pub async fn get_llm_models(endpoint: String, api_key: Option<String>, api_type: Option<String>) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let base = endpoint.trim_end_matches('/');
    let provider = resolve_llm_provider(api_type.as_deref(), base);
    let url = if provider == "ollama" {
        format!("{}/api/tags", base)
    } else {
        format!("{}/models", base)
    };

    let auth_key = api_key.unwrap_or_default();
    if provider_requires_api_key(&provider) && auth_key.trim().is_empty() {
        return Err("API key is required for this provider.".to_string());
    }

    let mut request = client.get(&url);
    if !auth_key.trim().is_empty() {
        request = request.header("Authorization", format!("Bearer {}", auth_key));
    }
    if provider == "openrouter" {
        request = request
            .header("HTTP-Referer", HTTP_REFERER)
            .header("X-Title", HTTP_TITLE);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Model list request failed ({}) and body could not be read: {}", status, e))?;
        return Err(format!("Model list request failed ({}): {}", status, text));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    let models: Vec<String> = if provider == "ollama" {
        payload["models"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m["name"].as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    } else {
        payload["data"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m["id"].as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    };

    Ok(models)
}

/// Calls one OpenAI-compatible chat endpoint and returns assistant content text.
#[tauri::command]
pub async fn call_llm_chat(
    endpoint: String,
    api_key: Option<String>,
    api_type: Option<String>,
    model: String,
    messages: Vec<LlmMessage>,
    temperature: f64,
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let base = endpoint.trim_end_matches('/');
    let provider = resolve_llm_provider(api_type.as_deref(), base);
    let auth_key = api_key.unwrap_or_default();
    if provider_requires_api_key(&provider) && auth_key.trim().is_empty() {
        return Err("API key is required for this provider.".to_string());
    }

    let url = if provider == "ollama" {
        format!("{}/api/chat", base)
    } else {
        format!("{}/chat/completions", base)
    };

    let mut request = client.post(&url).header("Content-Type", "application/json");

    if !auth_key.trim().is_empty() {
        request = request.header("Authorization", format!("Bearer {}", auth_key));
    }
    if provider == "openrouter" {
        request = request
            .header("HTTP-Referer", HTTP_REFERER)
            .header("X-Title", HTTP_TITLE);
    }

    let body = if provider == "ollama" {
        serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens
            }
        })
    } else {
        serde_json::json!({
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": messages
        })
    };

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
            .map_err(|e| format!("Chat request failed ({}) and body could not be read: {}", status, e))?;
        return Err(format!("Chat request failed ({}): {}", status, text));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    if provider == "ollama" {
        return payload["message"]["content"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "No content in Ollama response".to_string());
    }

    payload["choices"][0]["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "No content in response".to_string())
}
