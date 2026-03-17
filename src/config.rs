//! 环境变量解析与服务端运行配置。

use std::{env, path::PathBuf, sync::Arc};

use tracing::warn;
use uuid::Uuid;

use crate::utils::{env_bool, normalized_stun_urls, split_csv};

/// 服务启动后长期持有的配置快照。
#[derive(Debug, Clone)]
pub(crate) struct AppConfig {
    pub(crate) port: u16,
    pub(crate) allowed_origins: Vec<String>,
    pub(crate) ice_provider: IceProvider,
    pub(crate) filter_browser_unsafe_turn_urls: bool,
    pub(crate) session_secret: Arc<Vec<u8>>,
    pub(crate) session_ttl_seconds: u64,
    pub(crate) diagnostics_dir: PathBuf,
}

/// ICE 服务来源。
/// `stun-only` 用于纯打洞，`static` 和 `cloudflare` 会额外返回 TURN 凭据。
#[derive(Debug, Clone)]
pub(crate) enum IceProvider {
    StunOnly {
        stun_urls: Vec<String>,
    },
    Static {
        stun_urls: Vec<String>,
        turn_urls: Vec<String>,
        username: String,
        credential: String,
    },
    Cloudflare {
        stun_urls: Vec<String>,
        key_id: String,
        api_token: String,
        ttl_seconds: u64,
    },
}

impl AppConfig {
    /// 从进程环境变量读取配置；缺省值尽量保证本地开发即可运行。
    pub(crate) fn from_env() -> Self {
        let port = env::var("APP_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(3456);
        let allowed_origins = split_csv("ALLOWED_ORIGINS");
        let filter_browser_unsafe_turn_urls =
            env_bool("FILTER_BROWSER_UNSAFE_TURN_URLS").unwrap_or(true);
        let session_ttl_seconds = env::var("SESSION_TTL_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30 * 24 * 60 * 60);
        let diagnostics_dir = env::var("DIAGNOSTICS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("diagnostics"));
        let session_secret = env::var("SESSION_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                let generated = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                warn!(
                    "SESSION_SECRET is not set; generating an ephemeral secret for this process. Anonymous sessions will be invalidated on restart."
                );
                generated
            });

        let ice_provider_name = env::var("ICE_PROVIDER")
            .unwrap_or_else(|_| "stun-only".to_string())
            .to_lowercase();
        let stun_urls = split_csv("STUN_URLS");

        // 根据部署方式选择 ICE 来源；配置不完整时自动回退到 STUN-only，
        // 这样至少还能保证局域网或可直连环境可用。
        let ice_provider = match ice_provider_name.as_str() {
            "cloudflare" => {
                let key_id = env::var("CLOUDFLARE_TURN_KEY_ID").unwrap_or_default();
                let api_token = env::var("CLOUDFLARE_TURN_API_TOKEN").unwrap_or_default();
                let ttl_seconds = env::var("CLOUDFLARE_TURN_TTL_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(86_400);

                if key_id.is_empty() || api_token.is_empty() {
                    warn!("ICE_PROVIDER=cloudflare but Cloudflare TURN credentials are missing; falling back to STUN only");
                    IceProvider::StunOnly {
                        stun_urls: normalized_stun_urls(stun_urls),
                    }
                } else {
                    IceProvider::Cloudflare {
                        stun_urls: normalized_stun_urls(stun_urls),
                        key_id,
                        api_token,
                        ttl_seconds,
                    }
                }
            }
            "static" => {
                let turn_urls = split_csv("TURN_URLS");
                let username = env::var("TURN_USERNAME").unwrap_or_default();
                let credential = env::var("TURN_CREDENTIAL").unwrap_or_default();

                if turn_urls.is_empty() || username.is_empty() || credential.is_empty() {
                    warn!("ICE_PROVIDER=static but TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL are incomplete; falling back to STUN only");
                    IceProvider::StunOnly {
                        stun_urls: normalized_stun_urls(stun_urls),
                    }
                } else {
                    IceProvider::Static {
                        stun_urls: normalized_stun_urls(stun_urls),
                        turn_urls,
                        username,
                        credential,
                    }
                }
            }
            _ => IceProvider::StunOnly {
                stun_urls: normalized_stun_urls(stun_urls),
            },
        };

        Self {
            port,
            allowed_origins,
            ice_provider,
            filter_browser_unsafe_turn_urls,
            session_secret: Arc::new(session_secret.into_bytes()),
            session_ttl_seconds,
            diagnostics_dir,
        }
    }

    /// 校验请求来源是否在允许列表中；未配置白名单时默认放行。
    pub(crate) fn origin_allowed(&self, origin: Option<&str>) -> bool {
        if self.allowed_origins.is_empty() {
            return true;
        }

        origin
            .map(|value| {
                self.allowed_origins
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(value))
            })
            .unwrap_or(false)
    }
}
