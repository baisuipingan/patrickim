//! WebRTC 诊断数据的接收与落盘。

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde_json::Value;
use time::{macros::format_description, OffsetDateTime};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    app::AppContext,
    session::parse_session_cookie,
    types::{DiagnosticsUploadRequest, DiagnosticsUploadResponse, StoredDiagnosticsReport},
    utils::{
        now_ms, sanitize_filename_component, take_rate_limited_log_count, RateLimitedLogState,
    },
};

const INVALID_SESSION_WARN_INTERVAL_MS: u64 = 30_000;
static INVALID_SESSION_WARN_STATE: RateLimitedLogState = RateLimitedLogState::new();

/// 接收前端上传的诊断包，并按会话与通话编号落到本地文件。
pub(crate) async fn post_diagnostics(
    State(context): State<Arc<AppContext>>,
    headers: HeaderMap,
    Json(report): Json<DiagnosticsUploadRequest>,
) -> Result<Json<DiagnosticsUploadResponse>, (StatusCode, Json<Value>)> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());

    if !context.config.request_origin_allowed(&headers) {
        warn!("rejecting diagnostics upload from origin {:?}", origin);
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "forbidden_origin",
            })),
        ));
    }

    let Some(session) = parse_session_cookie(&context.config, &headers) else {
        if let Some(suppressed_count) = take_rate_limited_log_count(
            &INVALID_SESSION_WARN_STATE,
            INVALID_SESSION_WARN_INTERVAL_MS,
        ) {
            if suppressed_count > 0 {
                warn!(
                    "rejecting diagnostics upload without a valid anonymous session (suppressed {} similar events in the last {}s)",
                    suppressed_count,
                    INVALID_SESSION_WARN_INTERVAL_MS / 1000
                );
            } else {
                warn!("rejecting diagnostics upload without a valid anonymous session");
            }
        }
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "missing_session",
            })),
        ));
    };

    // 文件名中带上时间、匿名用户和通话编号，方便后续排查问题。
    let id = Uuid::new_v4().to_string();
    let saved_at = now_ms();
    let file_path = build_diagnostics_path(
        &context.config.diagnostics_dir,
        saved_at,
        &id,
        &session.client_id,
        &report,
    );
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let document = StoredDiagnosticsReport {
        id: id.clone(),
        saved_at,
        session_client_id: session.client_id.clone(),
        user_agent,
        report,
    };

    // 诊断目录不存在时自动创建，避免首次上报失败。
    let parent_dir = file_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("diagnostics"));
    tokio::fs::create_dir_all(&parent_dir)
        .await
        .map_err(|err| {
            error!(
                "failed to create diagnostics dir {}: {err}",
                parent_dir.display()
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "diagnostics_dir_create_failed",
                    "message": err.to_string(),
                })),
            )
        })?;

    // 统一使用格式化 JSON 落盘，便于肉眼排查和后续归档。
    let bytes = serde_json::to_vec_pretty(&document).map_err(|err| {
        error!("failed to serialize diagnostics upload: {err}");
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "diagnostics_serialize_failed",
                "message": err.to_string(),
            })),
        )
    })?;

    tokio::fs::write(&file_path, bytes).await.map_err(|err| {
        error!(
            "failed to persist diagnostics report to {}: {err}",
            file_path.display()
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "diagnostics_write_failed",
                "message": err.to_string(),
            })),
        )
    })?;

    info!(
        "saved diagnostics report {} for client {} to {}",
        id,
        session.client_id,
        file_path.display()
    );

    Ok(Json(DiagnosticsUploadResponse {
        id,
        saved_at,
        file_path: file_path.display().to_string(),
    }))
}

fn build_diagnostics_path(
    diagnostics_dir: &PathBuf,
    saved_at: u64,
    report_id: &str,
    session_client_id: &str,
    report: &DiagnosticsUploadRequest,
) -> PathBuf {
    let day_dir = format_saved_day(saved_at);
    let room_segment = format!(
        "room-{}",
        sanitize_segment(
            context_string(&report.context, "roomId").as_deref(),
            "no-room",
        )
    );
    let nickname =
        sanitize_optional_segment(context_string(&report.context, "nickname").as_deref());
    let client_segment = match nickname {
        Some(nickname) => format!(
            "client-{}__nick-{}",
            sanitize_segment(Some(session_client_id), "unknown-client"),
            nickname
        ),
        None => format!(
            "client-{}",
            sanitize_segment(Some(session_client_id), "unknown-client")
        ),
    };
    let scope_type = sanitize_segment(
        context_string(&report.context, "scopeType").as_deref(),
        "app",
    );
    let reason = sanitize_segment(
        (!report.reason.trim().is_empty()).then_some(report.reason.as_str()),
        "report",
    );
    let file_name = format!(
        "{}-{}-{}-{}.json",
        saved_at,
        scope_type,
        reason,
        sanitize_segment(Some(report_id), "report")
    );

    diagnostics_dir
        .join(day_dir)
        .join(room_segment)
        .join(client_segment)
        .join(file_name)
}

fn context_string(context: &Value, key: &str) -> Option<String> {
    context
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_optional_segment(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(sanitize_filename_component)
        .map(|sanitized| truncate_segment(&sanitized))
        .filter(|sanitized| sanitized != "unknown")
}

fn sanitize_segment(value: Option<&str>, fallback: &str) -> String {
    sanitize_optional_segment(value).unwrap_or_else(|| fallback.to_string())
}

fn truncate_segment(value: &str) -> String {
    const MAX_SEGMENT_CHARS: usize = 48;
    let truncated = value.chars().take(MAX_SEGMENT_CHARS).collect::<String>();
    if truncated.is_empty() {
        "unknown".to_string()
    } else {
        truncated
    }
}

fn format_saved_day(saved_at: u64) -> String {
    const DATE_FORMAT: &[time::format_description::FormatItem<'static>] =
        format_description!("[year]-[month]-[day]");

    let timestamp_seconds = (saved_at / 1000) as i64;
    OffsetDateTime::from_unix_timestamp(timestamp_seconds)
        .ok()
        .and_then(|datetime| datetime.format(DATE_FORMAT).ok())
        .unwrap_or_else(|| "unknown-day".to_string())
}
