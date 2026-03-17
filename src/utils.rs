//! 各模块复用的小工具函数。

use std::{
    env,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::HeaderMap;

/// 判断当前请求在反向代理之后是否应视为 HTTPS。
pub(crate) fn request_is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// 返回 Unix 毫秒时间戳，统一整个服务端的时间口径。
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// 生成适合写入文件名的安全片段，避免特殊字符污染路径。
pub(crate) fn sanitize_filename_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
            _ => '_',
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

/// 读取逗号分隔环境变量并去掉空白与空项。
pub(crate) fn split_csv(key: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_default()
        .split(',')
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

/// 至少保证有一个默认 STUN 地址，避免前端拿到空配置。
pub(crate) fn normalized_stun_urls(mut urls: Vec<String>) -> Vec<String> {
    if urls.is_empty() {
        urls.push("stun:stun.cloudflare.com:3478".to_string());
    }
    urls
}

/// 某些浏览器对 `:53` 端口的 TURN URL 兼容性较差，这里可按需过滤。
pub(crate) fn filter_browser_unsafe_urls(urls: Vec<String>, enabled: bool) -> Vec<String> {
    if !enabled {
        return urls;
    }

    urls.into_iter()
        .filter(|url| !url.contains(":53"))
        .collect()
}

/// 解析布尔型环境变量，兼容常见写法。
pub(crate) fn env_bool(key: &str) -> Option<bool> {
    env::var(key)
        .ok()
        .and_then(|value| match value.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

/// 简单的限流告警状态，避免高频重复日志把真正的问题淹没。
pub(crate) struct RateLimitedLogState {
    last_logged_at_ms: AtomicU64,
    suppressed_count: AtomicU64,
}

impl RateLimitedLogState {
    pub(crate) const fn new() -> Self {
        Self {
            last_logged_at_ms: AtomicU64::new(0),
            suppressed_count: AtomicU64::new(0),
        }
    }
}

/// 判断当前是否应该输出一次限流告警；返回值为本次一并带出的 suppressed 数量。
pub(crate) fn take_rate_limited_log_count(
    state: &RateLimitedLogState,
    interval_ms: u64,
) -> Option<u64> {
    let now = now_ms();
    let last_logged_at_ms = state.last_logged_at_ms.load(Ordering::Relaxed);
    let should_log = last_logged_at_ms == 0 || now.saturating_sub(last_logged_at_ms) >= interval_ms;

    if should_log
        && state
            .last_logged_at_ms
            .compare_exchange(last_logged_at_ms, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        return Some(state.suppressed_count.swap(0, Ordering::Relaxed));
    }

    state.suppressed_count.fetch_add(1, Ordering::Relaxed);
    None
}
