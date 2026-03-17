# patrick-im

一个现代化、高性能的点对点（P2P）即时通讯系统。它利用 WebRTC 技术实现端到端的加密通信，无需中心化服务器存储消息，真正保护用户隐私。系统能够智能识别网络环境，在局域网内自动直连以获得最高速度，在公网环境下通过 STUN/TURN 实现穿透连接。当前版本采用 Rust 信令服务，并由服务端签发匿名会话，无需注册登录即可直接进房间。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Rust](https://img.shields.io/badge/backend-Rust%20%2B%20Axum-orange.svg)
![React](https://img.shields.io/badge/frontend-React%2018-61DAFB.svg)

## ✨ 核心特性

### 🌐 智能混合网络
- **自适应连接**：自动检测网络环境，优先选择局域网直连（速度最快），公网环境自动进行 NAT 穿透。
- **状态可视化**：在用户列表中通过不同图标（🏠局域网 / 🌐公网）直观展示连接类型。
- **网络切换**：支持在不同网络环境间无缝切换，自动重连。

### 📁 强大的文件传输
- **无界传输**：基于 DataChannel 的流式传输，支持 GB 级大文件，不受服务器带宽限制。
- **断点续传**：传输中断后可随时恢复，无需重新开始。
- **完整性校验**：实时 SHA-256 哈希校验，确保文件数据 100% 准确。
- **传输控制**：支持暂停、恢复、取消传输，实时显示传输速度和剩余时间。

### 💬 极致聊天体验
- **智能未读管理**：
  - 自动记录未读消息数
  - 醒目的未读红线定位
  - 智能滚动：有未读消息时自动定位到第一条未读，无未读时直达底部
- **消息持久化**：聊天记录存储在本地浏览器中，刷新页面不丢失，且数据完全由用户掌控。
- **多模式聊天**：支持全局广播（Global Chat）和私密点对点聊天（Private Chat）。
- **房间即入口**：默认匿名入站，无需登录，进入网站后直接选房间或输入房间号即可加入。

### 📞 音视频通话
- **高清视频通话**：基于 WebRTC 的点对点视频通话，支持 720p 高清画质。
- **语音通话**：纯语音通话模式，节省带宽。
- **动态切换**：通话中可随时开关摄像头和麦克风。
- **设备兼容**：自动检测设备，无摄像头/麦克风也可接收对方音视频（仅接收模式）。
- **双连接架构**：数据通道和媒体通道分离，聊天/文件传输不会再直接拖慢音视频协商。

### 🖥️ 屏幕共享
- **一键共享**：通话中随时开启屏幕共享，支持共享整个屏幕、应用窗口或浏览器标签页。
- **实时同步**：通过 SDP 重新协商确保分辨率变化时对方能正确接收。
- **全屏观看**：接收方可全屏查看共享内容，视频保持原始比例不拉伸。

### 🎨 现代化界面
- **响应式设计**：完美适配桌面端和移动端，侧边栏在移动端自动折叠。
- **美观交互**：基于 shadcn/ui 和 Tailwind CSS 构建，提供流畅的动画和精致的视觉效果。
- **实时状态**：在线人数、用户状态（连接中/已连接/离线）实时更新。

## 🛠️ 技术栈

**后端 (Backend)**
- **Rust + Axum + Tokio**: 高性能异步信令服务
- **WebSocket**: 可靠的信令交换通道
- **匿名会话 Cookie**: 服务端签发匿名身份，不再信任前端自报 `userId`

**前端 (Frontend)**
- **React 18**: 组件化 UI 开发
- **Vite 3**: 极速构建体验
- **WebRTC**: 核心 P2P 通信技术
- **Tailwind CSS**: 原子化 CSS 样式
- **shadcn/ui**: 高质量 UI 组件库
- **CryptoJS**: 前端数据加密与哈希计算

## 🚀 快速开始

### 方式一：Docker Compose 部署（推荐）

当前推荐使用 `Rust app + Nginx` 的双容器部署方式。

```bash
# 1. 准备环境变量
cp .env.example .env

# 2. 至少设置一个稳定的匿名会话密钥
# SESSION_SECRET=请替换成一串足够长的随机字符串

# 3. 构建并启动
docker compose up -d --build
```

默认通过 Nginx 暴露在 `http://localhost`。

### 方式一补充：推荐的远程发布链路

如果你的服务器是 `x86_64`，而开发机像 MacBook 一样是 `arm64`，推荐改成：

1. 本地用 `docker buildx` 构建 `linux/amd64` 镜像并推送到镜像仓库
2. 服务器只执行 `docker compose pull && docker compose up -d`

仓库内已经提供了两个脚本：

```bash
# 只发布镜像，不连服务器
IMAGE_REPO=your-acr-registry.example.com/your-namespace/patrick-im \
bash ./release-image.sh

# 发布镜像后，通过 SSH 让服务器拉新镜像并重启
SERVER=ubuntu@1.2.3.4 \
PROJECT_DIR=/home/patrick-im \
IMAGE_REPO=your-acr-registry.example.com/your-namespace/patrick-im \
bash ./deploy-remote.sh
```

说明：
- 默认构建平台是 `linux/amd64`，适合大多数云服务器。
- 这是 Docker 层的跨架构构建，不需要额外用 `zigbuild` 去交叉编译 Rust。
- 如果以后你既有 `amd64` 服务器也有 `arm64` 服务器，可以把 `PLATFORMS` 改成 `linux/amd64,linux/arm64` 来发多架构镜像。

### 方式二：本地源码运行

适合开发和调试。

```bash
# 1. 克隆仓库
git clone https://github.com/your-repo/patrickim.git
cd patrickim

# 2. 准备本地环境变量（推荐）
cp .env.example .env
# 至少给 SESSION_SECRET 一个固定值，避免后端重启后匿名 session 全部失效

# 3. 构建前端
cd frontend
npm install
npm run build
cd ..

# 4. 运行后端
cargo run
```

如果你要调试音视频，还有两个常用方式：

```bash
# 桌面浏览器本机调试
# localhost 在多数现代浏览器里本身就属于安全上下文
# Vite 会把 /api 和 /ws 自动代理到本地 Rust 后端（默认 http://127.0.0.1:3456）
cd frontend
npm run dev

# 局域网设备 / 本地 HTTPS 调试
# 适合手机、平板或通过本机 IP 访问时测试摄像头和麦克风权限
# 同样会自动代理到本地 Rust 后端
cd frontend
npm run dev:https
```

说明：
- `cargo run` 现在会自动读取项目根目录下的 `.env.local` 和 `.env`；显式传入的 shell 环境变量优先级更高。
- 启动前记得先在项目根目录运行 `cargo run`，本地开发代理默认把请求转给 `http://127.0.0.1:3456`。
- 如果你的后端不是这个地址，可以设置环境变量 `VITE_DEV_BACKEND_ORIGIN`，例如 `VITE_DEV_BACKEND_ORIGIN=http://192.168.1.10:3456 npm run dev:https`。
- `http://localhost` 或 `http://127.0.0.1` 在大多数桌面浏览器里可以直接调用 `getUserMedia`。
- `http://192.168.x.x` 这类局域网 IP 通常不算安全上下文，测试音视频时建议用 `npm run dev:https`。
- `dev:https` 基于 Vite 的本地 HTTPS 证书能力启动，浏览器首次访问可能需要手动确认一次证书。

匿名会话说明：
- `GET /api/session` 会由服务端签发匿名 Cookie，浏览器后续连接 `/ws` 时自动携带。
- 生产环境建议显式设置 `SESSION_SECRET`；如果不配置，服务重启后匿名会话会失效。
- 本地开发如果不设置固定的 `SESSION_SECRET`，旧标签页在服务重启后会短暂出现 `invalid anonymous session` 警告；刷新页面或等待前端自动续期即可恢复。

## 📝 开发计划

- [x] 基础 P2P 聊天与文件传输
- [x] 断点续传与哈希校验
- [x] 局域网/公网智能切换与标识
- [x] 消息持久化与历史记录
- [x] 未读消息计数与智能定位
- [x] 音视频通话支持
- [x] 屏幕共享功能
- [ ] 集成AI相关

## 📄 License

MIT License - 自由使用，欢迎贡献！
