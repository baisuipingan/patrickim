//! 匿名会话的签发、校验与 Cookie 编解码。

use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cookie::{time::Duration as CookieDuration, Cookie, SameSite};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

use crate::{config::AppConfig, utils::now_ms};

/// 浏览器中保存匿名身份的 Cookie 名称。
pub(crate) const SESSION_COOKIE_NAME: &str = "patrick_im_session";

type HmacSha256 = Hmac<Sha256>;

/// 经过签名保护的匿名会话声明。
#[derive(Debug, Clone)]
pub(crate) struct SessionClaims {
    pub(crate) client_id: String,
    pub(crate) issued_at_ms: u64,
    pub(crate) expires_at_ms: u64,
    pub(crate) nonce: String,
}

/// 如果请求里已有有效会话，就沿用原 `client_id` 重新续期；否则签发新匿名身份。
pub(crate) fn existing_or_new_session(config: &AppConfig, headers: &HeaderMap) -> SessionClaims {
    match parse_session_cookie(config, headers) {
        Some(existing) => issue_session(config, Some(existing.client_id)),
        None => issue_session(config, None),
    }
}

/// 从请求头中解析并校验匿名 Cookie。
pub(crate) fn parse_session_cookie(
    config: &AppConfig,
    headers: &HeaderMap,
) -> Option<SessionClaims> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;

    Cookie::split_parse(cookie_header)
        .filter_map(Result::ok)
        .find(|cookie| cookie.name() == SESSION_COOKIE_NAME)
        .and_then(|cookie| verify_session_token(config, cookie.value()))
}

/// 将会话声明编码成带签名的 Cookie 字符串。
pub(crate) fn build_session_cookie(
    config: &AppConfig,
    session: &SessionClaims,
    secure: bool,
) -> Result<String, String> {
    let payload = format!(
        "{}.{}.{}.{}",
        session.client_id, session.issued_at_ms, session.expires_at_ms, session.nonce
    );
    let signature = sign_session_payload(config, &payload)
        .map(|mac| URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))?;
    let cookie_value = format!("{payload}.{signature}");

    let mut builder = Cookie::build((SESSION_COOKIE_NAME, cookie_value))
        .path("/")
        // 只允许浏览器自动携带，避免前端脚本直接读取和伪造。
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(CookieDuration::seconds(config.session_ttl_seconds as i64));

    if secure {
        builder = builder.secure(true);
    }

    Ok(builder.build().to_string())
}

/// 生成新的匿名身份，默认有效期由配置控制。
fn issue_session(config: &AppConfig, existing_client_id: Option<String>) -> SessionClaims {
    let issued_at_ms = now_ms();
    let ttl_ms = config.session_ttl_seconds.saturating_mul(1000);

    SessionClaims {
        client_id: existing_client_id.unwrap_or_else(generate_client_id),
        issued_at_ms,
        expires_at_ms: issued_at_ms.saturating_add(ttl_ms),
        nonce: Uuid::new_v4().simple().to_string(),
    }
}

/// 前端展示用匿名昵称，避免直接暴露完整 UUID。
fn generate_client_id() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("guest-{}", &raw[..8])
}

/// 解析 token 并验证签名与过期时间。
fn verify_session_token(config: &AppConfig, token: &str) -> Option<SessionClaims> {
    let mut parts = token.split('.');
    let client_id = parts.next()?.to_string();
    let issued_at_ms = parts.next()?.parse::<u64>().ok()?;
    let expires_at_ms = parts.next()?.parse::<u64>().ok()?;
    let nonce = parts.next()?.to_string();
    let signature = parts.next()?;

    if parts.next().is_some() || expires_at_ms <= now_ms() {
        return None;
    }

    let payload = format!("{client_id}.{issued_at_ms}.{expires_at_ms}.{nonce}");
    let expected = sign_session_payload(config, &payload).ok()?;
    let provided = URL_SAFE_NO_PAD.decode(signature).ok()?;

    expected.verify_slice(&provided).ok()?;

    Some(SessionClaims {
        client_id,
        issued_at_ms,
        expires_at_ms,
        nonce,
    })
}

/// 使用服务端密钥对会话载荷做 HMAC-SHA256 签名。
fn sign_session_payload(config: &AppConfig, payload: &str) -> Result<HmacSha256, String> {
    let mut mac = HmacSha256::new_from_slice(config.session_secret.as_slice())
        .map_err(|err| format!("failed to initialize session signer: {err}"))?;
    mac.update(payload.as_bytes());
    Ok(mac)
}
