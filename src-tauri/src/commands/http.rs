use std::collections::HashMap;
use std::time::Duration;

fn should_forward_header(key: &str) -> bool {
    !key.eq_ignore_ascii_case("content-type")
}

#[tauri::command]
pub async fn post_json_via_native_http(
    url: String,
    headers: HashMap<String, String>,
    body: serde_json::Value,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("[HTTP_CLIENT_ERROR] 创建HTTP客户端失败: {}", e))?;
    let mut request = client.post(url).json(&body);

    for (key, value) in headers {
        if should_forward_header(&key) {
            request = request.header(&key, value);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("[HTTP_REQUEST_ERROR] HTTP请求失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("[HTTP_RESPONSE_ERROR] 读取HTTP响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "[HTTP_STATUS_ERROR] HTTP请求返回错误状态 {}: {}",
            status.as_u16(),
            text
        ));
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::should_forward_header;

    #[test]
    fn filters_content_type_case_insensitively() {
        assert!(!should_forward_header("Content-Type"));
        assert!(!should_forward_header("content-type"));
        assert!(!should_forward_header("CONTENT-TYPE"));
    }

    #[test]
    fn keeps_other_headers() {
        assert!(should_forward_header("Authorization"));
        assert!(should_forward_header("X-Test"));
    }
}
