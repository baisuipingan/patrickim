//! 路由层与 WebSocket 层共享的数据结构定义。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// WebSocket 信令消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SignalMessage {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) payload: Value,
    #[serde(default)]
    pub(crate) from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) to: Option<String>,
}

/// 前端房间列表接口返回的数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoomInfo {
    pub(crate) id: String,
    pub(crate) client_count: usize,
    pub(crate) clients: Vec<String>,
    pub(crate) created_at: u64,
    pub(crate) is_private: bool,
}

/// WebRTC `iceServers` 中的单项配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IceServer {
    pub(crate) urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential: Option<String>,
}

/// `/api/ice` 返回给前端的完整 ICE 配置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IceConfigResponse {
    pub(crate) provider: String,
    pub(crate) ttl_seconds: u64,
    pub(crate) ice_servers: Vec<IceServer>,
}

/// `/api/session` 返回的匿名会话信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionResponse {
    pub(crate) client_id: String,
    pub(crate) issued_at: u64,
    pub(crate) expires_at: u64,
    pub(crate) expires_in_seconds: u64,
}

/// WebSocket 建连时从 query 中提取的参数。
#[derive(Debug, Deserialize)]
pub(crate) struct ConnectParams {
    pub(crate) room: Option<String>,
    #[serde(default, rename = "private")]
    pub(crate) is_private: bool,
}
