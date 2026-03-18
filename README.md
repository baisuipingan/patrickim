# patrick-im

`patrick-im` 是一个以 WebRTC 为核心的点对点即时通信项目，提供匿名入房、文本聊天、文件传输、音视频通话和屏幕共享能力。当前主分支基于 `Rust + Axum + React`，服务端只负责匿名 session、房间信令、ICE 配置和诊断上报，消息与媒体数据尽量走浏览器之间的 P2P 连接。

## 当前状态

- 当前主分支 `main`：Rust 信令服务版本
- 旧版 Go 实现：`main-go` 分支
- 旧版 Go 最后快照：`go-legacy-final` tag

如果你是从早期 Go 版仓库进来的，建议直接看 `main`；如果你要对比迁移前实现或兼容旧部署，可以切到 `main-go`。

## 核心特性

- 匿名入站：无需注册登录，进入网站后直接选择房间或输入房间号
- P2P 文本聊天：优先通过 DataChannel 在浏览器之间直连传输
- 文件传输：支持接收方确认后再开始发送，支持暂停、恢复、取消
- 音视频通话：支持摄像头、麦克风开关和屏幕共享
- 网络自适应：优先局域网直连，公网下自动尝试 STUN / TURN
- 诊断留档：连接异常、信令异常、数据通道关闭等问题可落盘排查
- 本地优先：聊天历史保存在浏览器本地，不依赖中心化消息存储

## 技术栈

### 后端

- Rust
- Axum
- Tokio
- WebSocket signaling
- HMAC-signed anonymous session cookie

### 前端

- React 18
- Vite
- Tailwind CSS
- WebRTC

## 项目结构

```text
.
├── src/                    # Rust 服务端
├── frontend/               # React 前端
├── deploy-local.sh         # 本地一键发版脚本
├── deploy.sh               # 服务器侧部署脚本
├── docker-compose.yml      # 服务器容器编排
├── .env.example            # 服务运行配置模板
└── .env.local.example      # 本地发版私密配置模板
```

## 工作方式

### 服务端负责什么

- 签发匿名 session
- 维护房间成员和 WebSocket 信令
- 返回 `/api/ice` 给前端建立 WebRTC
- 接收 `/api/diagnostics` 诊断报告

### 服务端不负责什么

- 不存储聊天消息正文
- 不中转正常的文本消息
- 不承载正常的音视频流
- 不承载正常的文件内容

正常情况下，消息、文件、音视频都尽量走 P2P；只有信令、身份和 TURN 凭据获取仍然经过服务端。

## 快速开始

### 1. 本地开发

先准备运行配置：

```bash
cp .env.example .env
```

至少建议填好：

```env
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
SESSION_SECRET=替换成一串固定随机字符串
ICE_PROVIDER=stun-only
```

安装前端依赖并运行：

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

## 2. 生产部署

当前仓库默认采用：

- 本机构建前端
- 本机使用 `cargo zigbuild` 交叉编译 Linux 二进制
- 本机打 Docker 镜像并推送镜像仓库
- 服务器只执行 `docker compose pull` 和 `docker compose up -d`

先准备两个配置文件：

```bash
cp .env.example .env
cp .env.local.example .env.local
```

### `.env`

这个文件是服务运行配置，会同步到服务器。

常用项：

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

`ALLOWED_ORIGINS` 支持多个域名，使用英文逗号分隔。

### `.env.local`

这个文件只给你本机发版脚本使用，不会上服务器，也不会提交到 Git。

常用项：

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

然后每次发版只需要：

```bash
bash ./deploy-local.sh
```

## TURN 配置说明

项目支持三种 ICE 模式：

- `stun-only`
- `static`
- `cloudflare`

### `stun-only`

只用于直连和 NAT 打洞，不提供 TURN 中继。

### `static`

适合自建 `coturn` 之类的固定 TURN 服务器：

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

- 项目里填的不是 Cloudflare 管理 API Token
- 这里需要的是 TURN key 页面给出的：
  - `Turn 令牌 ID`
  - `API 令牌`

后端会在每次 `/api/ice` 请求时向 Cloudflare 动态申请一组短期 TURN 凭据，再返回给当前前端会话使用。

## 诊断

可用接口：

- `GET /healthz`
- `GET /api/session`
- `GET /api/ice`
- `GET /api/rooms`
- `POST /api/diagnostics`
- `GET /ws`

生产环境里如果你启用了前端诊断上报，服务端会将报告写入 `diagnostics/` 目录。

## 开发说明

- 当前主线已经移除 Go 后端，服务端实现集中在 `src/`
- 前端与后端通过内嵌静态资源方式一起发布
- Docker 运行镜像是最小化运行镜像，构建产物由本机准备

## 路线图

- 更细的连接诊断与连接类型展示
- 更稳定的长时间通话重协商
- 更强的文件传输可观测性
- 更完整的开源文档和部署模板

## License

MIT
