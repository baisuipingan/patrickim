# patrick-im

[English](./README.en.md) | [简体中文](./README.md)

`patrick-im` 是一个以 WebRTC 为核心的点对点通信项目，支持匿名入房、文本聊天、文件传输、音视频通话与屏幕共享。当前主分支基于 `Rust + Axum + React`，服务端保持轻量，只负责匿名 session、房间信令、ICE/TURN 配置和诊断上报。

## 当前状态

- 当前主线：Rust 信令服务版本 `main`
- 旧版 Go 实现：`main-go` 分支
- Go 版本最后快照：`go-legacy-final` tag

如果你是从早期 Go 版仓库迁移过来的，建议把 `main-go` 当作历史参考，把 `main` 当作当前维护版本。

## 核心特性

- 匿名入站，无需注册登录
- 基于 WebRTC DataChannel 的 P2P 文本聊天
- 接收方确认后再发送的文件传输，支持暂停、恢复和取消
- 摄像头、麦克风可开关的音视频通话
- 通话中的屏幕共享
- 局域网优先直连，公网场景自动尝试 STUN / TURN
- 前后端诊断留档，便于排查连接不稳和协商异常
- 聊天历史优先保存在浏览器本地

## 架构说明

### 服务端负责什么

- 签发和续期匿名 session cookie
- 维护房间成员和 WebSocket 信令
- 提供 `/api/ice` 给前端建立 WebRTC
- 接收 `/api/diagnostics` 诊断报告

### 服务端不负责什么

- 不存储聊天正文
- 不中转正常文本消息
- 不承载正常音视频流
- 不代理正常文件内容

正常情况下，聊天、文件和媒体都尽量走浏览器之间的 P2P 连接，服务端只保留在信令和启动链路上。

## 技术栈

### 后端

- Rust
- Axum
- Tokio
- WebSocket signaling
- HMAC 签名匿名 session cookie

### 前端

- React 18
- Vite
- Tailwind CSS
- WebRTC

## 仓库结构

```text
.
├── src/                    # Rust 后端
├── frontend/               # React 前端
├── deploy-local.sh         # 本地一键发版脚本
├── deploy.sh               # 服务器侧部署脚本
├── docker-compose.yml      # 服务器容器编排
├── .env.example            # 服务运行配置模板
└── .env.local.example      # 本地发版私密配置模板
```

## 本地开发

先准备运行配置：

```bash
cp .env.example .env
```

最少建议填写：

```env
ALLOWED_ORIGINS=http://localhost:3456,http://127.0.0.1:3456
SESSION_SECRET=替换成固定随机字符串
ICE_PROVIDER=stun-only
```

构建前端并启动后端：

```bash
cd frontend
npm install
npm run build
cd ..

cargo run
```

启动后访问：

- `http://127.0.0.1:3456`
- `http://localhost:3456`

## 生产部署

当前仓库默认采用“本机构建，服务器拉镜像”的工作流：

- 本机构建前端静态资源
- 本机使用 `cargo zigbuild` 交叉编译 Linux 二进制
- 本机打 Docker 镜像并推送镜像仓库
- 服务器只执行 `docker compose pull` 和 `docker compose up -d`

先准备两个配置文件：

```bash
cp .env.example .env
cp .env.local.example .env.local
```

### `.env`

这个文件是服务运行配置，发版时会同步到服务器。

常见写法：

```env
APP_IMAGE=your-registry.example.com/your-namespace/patrick-im:latest
APP_PULL_POLICY=always

ALLOWED_ORIGINS=https://your-domain.com
SESSION_SECRET=替换成固定随机字符串
SESSION_TTL_SECONDS=2592000

ICE_PROVIDER=cloudflare
STUN_URLS=stun:stun.cloudflare.com:3478
CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
CLOUDFLARE_TURN_API_TOKEN=your-turn-api-token
CLOUDFLARE_TURN_TTL_SECONDS=86400
FILTER_BROWSER_UNSAFE_TURN_URLS=true
```

`ALLOWED_ORIGINS` 支持多个域名，用英文逗号分隔。

### `.env.local`

这个文件只给你本机发版脚本使用，不会上服务器，也不会提交到 Git。

常见写法：

```env
DEPLOY_SERVER_HOST=your-server-ip-or-domain
DEPLOY_SERVER_PORT=22
DEPLOY_SERVER_USER=root
DEPLOY_SERVER_PASSWORD=your-ssh-password
DEPLOY_PROJECT_DIR=/home/patrick-im

ACR_REGISTRY=your-registry.example.com
IMAGE_REPO=your-registry.example.com/your-namespace/patrick-im
ACR_USERNAME=your-registry-username
ACR_PASSWORD=your-registry-password

PLATFORMS=linux/amd64
RUST_TARGET=x86_64-unknown-linux-musl
PUSH_LATEST=true
```

### 一键发版

确保本机已经安装：

- Docker
- Rust toolchain
- Zig
- `cargo-zigbuild`
- Node.js / npm
- `sshpass`

首次使用可以执行：

```bash
rustup target add x86_64-unknown-linux-musl
cargo install cargo-zigbuild
```

之后每次发版只需要：

```bash
bash ./deploy-local.sh
```

## ICE / TURN 模式

项目支持三种 ICE 模式：

- `stun-only`
- `static`
- `cloudflare`

### `stun-only`

只做直连和 NAT 打洞，不提供 TURN 中继兜底。

### `static`

适合自建 `coturn` 之类的固定 TURN 服务：

```env
ICE_PROVIDER=static
STUN_URLS=stun:stun.cloudflare.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

### `cloudflare`

适合使用 Cloudflare Realtime TURN。

注意：

- 这里不是填 Cloudflare 管理 API Token
- 项目真正需要的是 TURN key 页面给出的：
  - `Turn 令牌 ID`
  - `API 令牌`

后端会在每次 `/api/ice` 请求时向 Cloudflare 动态申请一组短期 TURN 凭据，再把 `iceServers` 返回给当前前端会话。

## 诊断与接口

主要接口：

- `GET /healthz`
- `GET /api/session`
- `GET /api/ice`
- `GET /api/rooms`
- `POST /api/diagnostics`
- `GET /ws`

如果你启用了前端诊断上报，服务端会把报告写入 `diagnostics/` 目录。

## 说明

- 当前主线已经移除 Go 后端
- 前端静态资源会被打包进后端发布产物
- Docker 运行镜像是最小化运行镜像，要求构建产物先在本地准备好

## License

MIT
