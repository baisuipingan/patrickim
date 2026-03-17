//! ICE/STUN/TURN 配置生成逻辑。

use std::sync::Arc;

use serde::Deserialize;

use crate::{
    app::AppContext,
    config::IceProvider,
    types::{IceConfigResponse, IceServer},
    utils::filter_browser_unsafe_urls,
};

/// Cloudflare TURN API 返回体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareIceConfigResponse {
    ice_servers: Vec<IceServer>,
}

/// 根据当前配置生成前端可直接使用的 `iceServers` 列表。
pub(crate) async fn build_ice_config(
    context: &Arc<AppContext>,
) -> Result<IceConfigResponse, String> {
    match &context.config.ice_provider {
        IceProvider::StunOnly { stun_urls } => Ok(IceConfigResponse {
            provider: "stun-only".to_string(),
            ttl_seconds: 0,
            ice_servers: vec![IceServer {
                urls: stun_urls.clone(),
                username: None,
                credential: None,
            }],
        }),
        IceProvider::Static {
            stun_urls,
            turn_urls,
            username,
            credential,
        } => {
            let mut ice_servers = vec![IceServer {
                urls: stun_urls.clone(),
                username: None,
                credential: None,
            }];

            let filtered_turn_urls = filter_browser_unsafe_urls(
                turn_urls.clone(),
                context.config.filter_browser_unsafe_turn_urls,
            );
            if !filtered_turn_urls.is_empty() {
                ice_servers.push(IceServer {
                    urls: filtered_turn_urls,
                    username: Some(username.clone()),
                    credential: Some(credential.clone()),
                });
            }

            Ok(IceConfigResponse {
                provider: "static".to_string(),
                ttl_seconds: 0,
                ice_servers,
            })
        }
        IceProvider::Cloudflare {
            stun_urls,
            key_id,
            api_token,
            ttl_seconds,
        } => {
            // 运行时向 Cloudflare 申请短期凭据，避免把固定 TURN 密码长期暴露给前端。
            let response = context
                .http_client
                .post(format!(
                    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
                ))
                .bearer_auth(api_token)
                .json(&serde_json::json!({ "ttl": ttl_seconds }))
                .send()
                .await
                .map_err(|err| format!("Cloudflare TURN request failed: {err}"))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(format!("Cloudflare TURN request returned {status}: {body}"));
            }

            let mut cloudflare = response
                .json::<CloudflareIceConfigResponse>()
                .await
                .map_err(|err| format!("invalid Cloudflare TURN response: {err}"))?;

            if cloudflare.ice_servers.is_empty() {
                // 即使 TURN 接口异常，也尽量保留 STUN，避免全部回空。
                cloudflare.ice_servers.push(IceServer {
                    urls: stun_urls.clone(),
                    username: None,
                    credential: None,
                });
            }

            for ice_server in &mut cloudflare.ice_servers {
                ice_server.urls = filter_browser_unsafe_urls(
                    std::mem::take(&mut ice_server.urls),
                    context.config.filter_browser_unsafe_turn_urls,
                );
            }
            cloudflare
                .ice_servers
                .retain(|ice_server| !ice_server.urls.is_empty());

            if cloudflare.ice_servers.is_empty() {
                cloudflare.ice_servers.push(IceServer {
                    urls: stun_urls.clone(),
                    username: None,
                    credential: None,
                });
            }

            Ok(IceConfigResponse {
                provider: "cloudflare".to_string(),
                ttl_seconds: *ttl_seconds,
                ice_servers: cloudflare.ice_servers,
            })
        }
    }
}
