//! HTTP 路由装配与轻量接口处理。

use std::sync::Arc;

use axum::{
    extract::State,
    http::{
        header::{self},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::Value;
use tracing::error;

use crate::{
    app::AppContext,
    ice::build_ice_config,
    session::{build_session_cookie, existing_or_new_session},
    static_files::static_handler,
    types::{IceConfigResponse, RoomInfo, SessionResponse},
    utils::request_is_secure,
    ws::ws_handler,
};

/// 统一创建 Axum 路由树。
pub(crate) fn build_router(context: Arc<AppContext>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/rooms", get(list_rooms))
        .route("/api/session", get(get_session))
        .route("/api/ice", get(get_ice_config))
        .route("/ws", get(ws_handler))
        .fallback(get(static_handler))
        .with_state(context)
}

/// 健康检查接口，便于反向代理或容器探针使用。
async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

/// 返回当前所有公开房间的简要信息。
async fn list_rooms(State(context): State<Arc<AppContext>>) -> impl IntoResponse {
    let state = context.state.read().await;
    let mut rooms = state
        .rooms
        .values()
        .filter(|room| !room.is_private)
        .map(|room| RoomInfo {
            id: room.id.clone(),
            client_count: room.clients.len(),
            clients: room.clients.keys().cloned().collect(),
            created_at: room.created_at_ms,
            is_private: room.is_private,
        })
        .collect::<Vec<_>>();
    rooms.sort_by(|left, right| left.id.cmp(&right.id));
    Json(rooms)
}

/// 获取或续签匿名会话，并把签名后的 Cookie 写回浏览器。
async fn get_session(State(context): State<Arc<AppContext>>, headers: HeaderMap) -> Response {
    let secure = request_is_secure(&headers);
    let session = existing_or_new_session(&context.config, &headers);
    let cookie = build_session_cookie(&context.config, &session, secure);

    let mut response = Json(SessionResponse {
        client_id: session.client_id.clone(),
        issued_at: session.issued_at_ms,
        expires_at: session.expires_at_ms,
        expires_in_seconds: context.config.session_ttl_seconds,
    })
    .into_response();

    match cookie {
        Ok(cookie) => {
            if let Ok(cookie_header) = HeaderValue::from_str(&cookie) {
                response
                    .headers_mut()
                    .insert(header::SET_COOKIE, cookie_header);
            } else {
                error!("failed to serialize session cookie header");
            }
        }
        Err(err) => {
            error!("failed to build session cookie: {err}");
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    response
}

/// 生成当前前端应使用的 ICE 配置。
async fn get_ice_config(
    State(context): State<Arc<AppContext>>,
) -> Result<Json<IceConfigResponse>, (StatusCode, Json<Value>)> {
    let config = build_ice_config(&context).await.map_err(|err| {
        error!("failed to build ICE config: {err}");
        (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "failed_to_build_ice_config",
                "message": err,
            })),
        )
    })?;

    Ok(Json(config))
}
