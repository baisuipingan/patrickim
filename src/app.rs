//! 应用级共享状态与运行时上下文。

use std::{
    collections::HashMap,
    sync::{atomic::AtomicU64, Arc},
};

use reqwest::Client;
use tokio::sync::{mpsc, watch, RwLock};
use uuid::Uuid;

use crate::{config::AppConfig, types::SignalMessage};

/// 路由、WebSocket 和后台任务共享的总上下文。
#[derive(Clone)]
pub(crate) struct AppContext {
    /// 运行配置，启动后基本只读。
    pub(crate) config: AppConfig,
    /// 房间与连接注册表，使用 RwLock 保护并发访问。
    pub(crate) state: Arc<RwLock<AppState>>,
    /// 供 Cloudflare TURN 等外部请求复用的 HTTP 客户端。
    pub(crate) http_client: Client,
}

/// 服务端当前维护的全部运行态数据。
#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) rooms: HashMap<String, RoomState>,
    pub(crate) connections: HashMap<Uuid, ConnectionHandle>,
}

/// 单个房间的成员信息。
pub(crate) struct RoomState {
    pub(crate) id: String,
    pub(crate) created_at_ms: u64,
    pub(crate) is_private: bool,
    /// `client_id -> connection_id`，便于按用户查到实际连接。
    pub(crate) clients: HashMap<String, Uuid>,
}

/// 已注册 WebSocket 连接的服务端句柄。
pub(crate) struct ConnectionHandle {
    pub(crate) client_id: String,
    pub(crate) room_id: String,
    /// 发送队列：业务线程把消息塞进去，单独的 writer 任务负责真正写 socket。
    pub(crate) sender: mpsc::UnboundedSender<OutboundMessage>,
    /// 最近一次活跃时间，用于超时回收。
    pub(crate) last_seen_ms: Arc<AtomicU64>,
    /// 主动关闭连接时，通过 watch 通知读取循环退出。
    pub(crate) shutdown: watch::Sender<bool>,
}

/// 发往客户端的统一出站消息类型。
#[derive(Clone)]
pub(crate) enum OutboundMessage {
    Json(SignalMessage),
    Ping,
    Close,
}
