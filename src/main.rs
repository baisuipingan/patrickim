//! 服务端启动入口。
//! 这里只负责装配依赖、创建共享上下文并启动 Axum 服务。

mod app;
mod config;
mod ice;
mod routes;
mod session;
mod static_files;
mod types;
mod utils;
mod ws;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use app::{AppContext, AppState};
use config::AppConfig;
use reqwest::Client;
use tokio::sync::RwLock;
use tracing::info;
use ws::run_stale_connection_reaper;

#[tokio::main]
async fn main() {
    // 本地开发时自动读取环境文件：
    // 真实环境变量优先；若未显式传入，则优先取 .env.local，再回退到 .env。
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();

    // 优先读取环境变量中的日志级别；未配置时使用项目默认值。
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "patrick_im_server=info,info".to_string()),
        )
        .init();

    let config = AppConfig::from_env();
    let port = config.port;
    // 全局上下文集中放配置、共享状态和 HTTP 客户端，便于路由层注入。
    let context = Arc::new(AppContext {
        config,
        state: Arc::new(RwLock::new(AppState::default())),
        http_client: Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client"),
    });
    // 后台任务：定期清理长时间没有心跳的 WebSocket 连接。
    tokio::spawn(run_stale_connection_reaper(context.clone()));

    let app = routes::build_router(context);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .expect("failed to bind TCP listener");

    info!("starting Rust signaling server on 0.0.0.0:{port}");
    axum::serve(listener, app)
        .await
        .expect("axum server exited unexpectedly");
}
