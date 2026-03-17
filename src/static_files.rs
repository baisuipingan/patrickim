//! 前端静态资源内嵌与回退路由处理。

use std::borrow::Cow;

use axum::{
    body::Body,
    http::{
        header::{self},
        HeaderValue, Response, StatusCode, Uri,
    },
    response::IntoResponse,
    Json,
};
use mime_guess::from_path;
use rust_embed::RustEmbed;

/// 将 `frontend/dist` 打进 Rust 二进制，便于单文件部署。
#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct FrontendAssets;

/// SPA 静态资源处理：找不到文件时回退到 `index.html`，交给前端路由接管。
pub(crate) async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let asset_path = if path.is_empty() { "index.html" } else { path };
    let asset = FrontendAssets::get(asset_path).or_else(|| FrontendAssets::get("index.html"));

    match asset {
        Some(asset) => build_static_response(asset_path, asset),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not_found" })),
        )
            .into_response(),
    }
}

/// 为嵌入资源补齐 MIME 与缓存头。
fn build_static_response(path: &str, asset: rust_embed::EmbeddedFile) -> Response<Body> {
    let mime = from_path(path).first_or_octet_stream();
    let cache_control = if path.starts_with("assets/") {
        // 带 hash 的静态资源可以长期缓存。
        "public, max-age=31536000, immutable"
    } else {
        // HTML 入口文件保持 no-cache，方便前端版本更新。
        "no-cache"
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(mime.as_ref())
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        )
        .header(
            header::CACHE_CONTROL,
            HeaderValue::from_str(cache_control).unwrap_or(HeaderValue::from_static("no-cache")),
        )
        .body(Body::from(match asset.data {
            Cow::Borrowed(bytes) => bytes.to_vec(),
            Cow::Owned(bytes) => bytes,
        }))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
