//! WebSocket 信令、房间管理与连接回收逻辑。

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{
        header::{self},
        HeaderMap, StatusCode,
    },
    response::IntoResponse,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    app::{AppContext, ConnectionHandle, OutboundMessage, RoomState},
    session::parse_session_cookie,
    types::{ConnectParams, SignalMessage},
    utils::{now_ms, take_rate_limited_log_count, RateLimitedLogState},
};

const WS_HEARTBEAT_TIMEOUT_MS: u64 = 20_000;
const WS_STALE_SWEEP_INTERVAL_MS: u64 = 5_000;
const WS_SERVER_PING_INTERVAL_MS: u64 = 8_000;
const INVALID_SESSION_WARN_INTERVAL_MS: u64 = 30_000;
static INVALID_SESSION_WARN_STATE: RateLimitedLogState = RateLimitedLogState::new();

/// WebSocket 升级入口：校验来源、校验匿名会话、提取房间参数。
pub(crate) async fn ws_handler(
    State(context): State<Arc<AppContext>>,
    Query(params): Query<ConnectParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());

    if !context.config.origin_allowed(origin) {
        warn!("rejecting websocket upgrade from origin {:?}", origin);
        return Err(StatusCode::FORBIDDEN);
    }

    let Some(session) = parse_session_cookie(&context.config, &headers) else {
        if let Some(suppressed_count) = take_rate_limited_log_count(
            &INVALID_SESSION_WARN_STATE,
            INVALID_SESSION_WARN_INTERVAL_MS,
        ) {
            if suppressed_count > 0 {
                warn!(
                    "rejecting websocket upgrade without a valid anonymous session (suppressed {} similar events in the last {}s)",
                    suppressed_count,
                    INVALID_SESSION_WARN_INTERVAL_MS / 1000
                );
            } else {
                warn!("rejecting websocket upgrade without a valid anonymous session");
            }
        }
        return Err(StatusCode::UNAUTHORIZED);
    };
    let room_id = params
        .room
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "default".to_string());

    Ok(ws.on_upgrade(move |socket| {
        handle_socket(
            context,
            socket,
            session.client_id,
            room_id,
            params.is_private,
        )
    }))
}

/// 周期性扫描长时间未活跃的连接，避免浏览器异常退出后状态残留。
pub(crate) async fn run_stale_connection_reaper(context: Arc<AppContext>) {
    let mut interval = tokio::time::interval(Duration::from_millis(WS_STALE_SWEEP_INTERVAL_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        reap_stale_connections(&context).await;
    }
}

/// 单个 WebSocket 连接的完整生命周期。
async fn handle_socket(
    context: Arc<AppContext>,
    socket: WebSocket,
    client_id: String,
    room_id: String,
    is_private: bool,
) {
    let connection_id = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<OutboundMessage>();
    let (shutdown_sender, mut shutdown_receiver) = watch::channel(false);

    let registration = register_connection(
        &context,
        connection_id,
        client_id.clone(),
        room_id.clone(),
        is_private,
        sender.clone(),
        shutdown_sender.clone(),
    )
    .await;

    // 新用户加入时，先把已在房间中的成员列表发给它，方便前端发起点对点协商。
    if let Some(existing_users) = registration.existing_users {
        let _ = sender.send(OutboundMessage::Json(SignalMessage {
            kind: "existing_users".to_string(),
            payload: Value::Array(existing_users.into_iter().map(Value::String).collect()),
            from: "server".to_string(),
            to: None,
        }));
    }

    // 同一个匿名用户重新连入时，主动挤掉旧连接，避免一个 client_id 挂两条 socket。
    if let Some(replaced) = registration.replaced_connection {
        let _ = replaced.shutdown.send(true);
        let _ = replaced.sender.send(OutboundMessage::Close);
    }

    broadcast_outbound(
        &registration.join_recipients,
        SignalMessage {
            kind: "user_joined".to_string(),
            payload: Value::Null,
            from: client_id.clone(),
            to: None,
        },
    );

    info!("client {client_id} joined room {room_id}");

    // writer 独占 socket 写端，避免多处并发写入导致协议混乱。
    let writer = tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            let result = match message {
                OutboundMessage::Json(payload) => {
                    let text = match serde_json::to_string(&payload) {
                        Ok(text) => text,
                        Err(err) => {
                            error!("failed to serialize outbound websocket payload: {err}");
                            continue;
                        }
                    };
                    sink.send(WsMessage::Text(text.into())).await
                }
                // 由服务端定时发 Ping，浏览器会自动回 Pong；reader 收到 Pong 后会刷新活跃时间。
                OutboundMessage::Ping => sink.send(WsMessage::Ping(Vec::new().into())).await,
                OutboundMessage::Close => {
                    let _ = sink.send(WsMessage::Close(None)).await;
                    break;
                }
            };

            if result.is_err() {
                break;
            }
        }
    });

    // reader 负责收消息、更新时间戳，并在必要时退出整个连接生命周期。
    let mut ping_interval =
        tokio::time::interval(Duration::from_millis(WS_SERVER_PING_INTERVAL_MS));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            result = stream.next() => {
                let Some(result) = result else {
                    break;
                };

                match result {
                    Ok(WsMessage::Text(text)) => {
                        touch_connection(&context, connection_id).await;
                        match serde_json::from_str::<SignalMessage>(&text) {
                            Ok(message) => route_message(&context, connection_id, message).await,
                            Err(err) => warn!("ignoring invalid websocket payload from {client_id}: {err}"),
                        }
                    }
                    Ok(WsMessage::Close(_)) => break,
                    Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) | Ok(WsMessage::Binary(_)) => {
                        touch_connection(&context, connection_id).await;
                    }
                    Err(err) => {
                        warn!("websocket read error for {client_id}: {err}");
                        break;
                    }
                }
            }
            _ = ping_interval.tick() => {
                if sender.send(OutboundMessage::Ping).is_err() {
                    break;
                }
            }
            changed = shutdown_receiver.changed() => {
                if changed.is_err() || *shutdown_receiver.borrow() {
                    break;
                }
            }
        }
    }

    writer.abort();
    unregister_connection(&context, connection_id, false).await;
}

/// 被新连接顶掉的旧连接句柄。
struct ReplacedConnection {
    sender: mpsc::UnboundedSender<OutboundMessage>,
    shutdown: watch::Sender<bool>,
}

/// 新连接注册完成后，需要返回给调用方的附带信息。
struct RegistrationResult {
    existing_users: Option<Vec<String>>,
    join_recipients: Vec<mpsc::UnboundedSender<OutboundMessage>>,
    replaced_connection: Option<ReplacedConnection>,
}

/// 把新连接加入房间，并返回需要广播和补发的数据。
async fn register_connection(
    context: &Arc<AppContext>,
    connection_id: Uuid,
    client_id: String,
    room_id: String,
    is_private: bool,
    sender: mpsc::UnboundedSender<OutboundMessage>,
    shutdown: watch::Sender<bool>,
) -> RegistrationResult {
    let mut state = context.state.write().await;
    // 房间不存在时按当前连接携带的属性创建。
    let room = state
        .rooms
        .entry(room_id.clone())
        .or_insert_with(|| RoomState {
            id: room_id.clone(),
            created_at_ms: now_ms(),
            is_private,
            clients: HashMap::new(),
        });

    // 记录加入前已有的成员列表，用于前端建立已有 peer 的连接。
    let existing_users = room
        .clients
        .keys()
        .filter(|id| *id != &client_id)
        .cloned()
        .collect::<Vec<_>>();

    // 如果同一 client_id 已存在，则旧连接会被挤掉。
    let replaced_connection_id = room.clients.insert(client_id.clone(), connection_id);
    let recipient_connection_ids = room
        .clients
        .iter()
        .filter_map(|(id, member_connection_id)| {
            if id == &client_id {
                None
            } else {
                Some(*member_connection_id)
            }
        })
        .collect::<Vec<_>>();

    let replaced_connection = replaced_connection_id.and_then(|old_connection_id| {
        state
            .connections
            .remove(&old_connection_id)
            .map(|connection| ReplacedConnection {
                sender: connection.sender,
                shutdown: connection.shutdown,
            })
    });

    state.connections.insert(
        connection_id,
        ConnectionHandle {
            client_id,
            room_id,
            sender,
            last_seen_ms: Arc::new(AtomicU64::new(now_ms())),
            shutdown,
        },
    );

    let join_recipients = recipient_connection_ids
        .iter()
        .filter_map(|connection_id| {
            state
                .connections
                .get(connection_id)
                .map(|connection| connection.sender.clone())
        })
        .collect::<Vec<_>>();

    RegistrationResult {
        existing_users: if existing_users.is_empty() {
            None
        } else {
            Some(existing_users)
        },
        join_recipients,
        replaced_connection,
    }
}

/// 从房间和全局连接表中移除连接，并按需广播离开事件。
async fn unregister_connection(context: &Arc<AppContext>, connection_id: Uuid, close_socket: bool) {
    let (room_id, client_id, recipients, removed_from_room, sender, shutdown) = {
        let mut state = context.state.write().await;
        let Some(connection) = state.connections.remove(&connection_id) else {
            return;
        };

        let room_id = connection.room_id.clone();
        let client_id = connection.client_id.clone();
        let sender = connection.sender.clone();
        let shutdown = connection.shutdown.clone();

        let mut removed_from_room = false;
        let mut recipient_connection_ids = Vec::new();
        let mut should_remove_room = false;

        if let Some(room) = state.rooms.get_mut(&room_id) {
            if room.clients.get(&client_id) == Some(&connection_id) {
                room.clients.remove(&client_id);
                removed_from_room = true;
            }

            if room.clients.is_empty() {
                should_remove_room = true;
            } else {
                recipient_connection_ids.extend(room.clients.values().copied());
            }
        }

        if should_remove_room {
            state.rooms.remove(&room_id);
        }

        let recipients = recipient_connection_ids
            .iter()
            .filter_map(|member_connection_id| {
                state
                    .connections
                    .get(member_connection_id)
                    .map(|member| member.sender.clone())
            })
            .collect::<Vec<_>>();

        (
            room_id,
            client_id,
            recipients,
            removed_from_room,
            sender,
            shutdown,
        )
    };

    if close_socket {
        let _ = shutdown.send(true);
        let _ = sender.send(OutboundMessage::Close);
    }

    if removed_from_room {
        info!("client {client_id} left room {room_id}");
        broadcast_outbound(
            &recipients,
            SignalMessage {
                kind: "user_left".to_string(),
                payload: Value::Null,
                from: client_id,
                to: None,
            },
        );
    }
}

/// 根据 `to` 字段路由单播或房间广播消息。
async fn route_message(context: &Arc<AppContext>, connection_id: Uuid, mut message: SignalMessage) {
    let recipients = {
        let state = context.state.read().await;
        let Some(connection) = state.connections.get(&connection_id) else {
            return;
        };
        let Some(room) = state.rooms.get(&connection.room_id) else {
            return;
        };

        message.from = connection.client_id.clone();

        // 心跳只用于保活，不需要继续向外转发。
        if matches!(message.kind.as_str(), "heartbeat" | "ping") {
            return;
        }

        if let Some(target) = &message.to {
            room.clients
                .get(target)
                .and_then(|recipient_connection_id| state.connections.get(recipient_connection_id))
                .map(|recipient| vec![recipient.sender.clone()])
                .unwrap_or_default()
        } else {
            room.clients
                .iter()
                .filter_map(|(client_id, recipient_connection_id)| {
                    if client_id == &connection.client_id {
                        None
                    } else {
                        state
                            .connections
                            .get(recipient_connection_id)
                            .map(|recipient| recipient.sender.clone())
                    }
                })
                .collect::<Vec<_>>()
        }
    };

    broadcast_outbound(&recipients, message);
}

/// 刷新连接的最近活跃时间，供超时回收逻辑判断。
async fn touch_connection(context: &Arc<AppContext>, connection_id: Uuid) {
    let state = context.state.read().await;
    if let Some(connection) = state.connections.get(&connection_id) {
        connection.last_seen_ms.store(now_ms(), Ordering::Relaxed);
    }
}

/// 找出超时连接并主动关闭。
async fn reap_stale_connections(context: &Arc<AppContext>) {
    let now = now_ms();
    let stale_connections = {
        let state = context.state.read().await;
        state
            .connections
            .iter()
            .filter_map(|(connection_id, connection)| {
                let last_seen_ms = connection.last_seen_ms.load(Ordering::Relaxed);
                let idle_for_ms = now.saturating_sub(last_seen_ms);

                if idle_for_ms >= WS_HEARTBEAT_TIMEOUT_MS {
                    Some((
                        *connection_id,
                        connection.client_id.clone(),
                        connection.room_id.clone(),
                        idle_for_ms,
                    ))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
    };

    for (connection_id, client_id, room_id, idle_for_ms) in stale_connections {
        warn!(
            "closing stale websocket connection for client {client_id} in room {room_id} after {idle_for_ms}ms of inactivity"
        );
        unregister_connection(context, connection_id, true).await;
    }
}

/// 将一条业务消息复制发送给多个接收方。
fn broadcast_outbound(
    recipients: &[mpsc::UnboundedSender<OutboundMessage>],
    message: SignalMessage,
) {
    for recipient in recipients {
        let _ = recipient.send(OutboundMessage::Json(message.clone()));
    }
}
