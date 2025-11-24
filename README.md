# Patrick IM

一个基于 WebRTC 的点对点即时通讯应用，支持局域网和公网环境下的实时聊天、文件传输。

## ✨ 主要功能

- 🚀 **P2P 通信**：基于 WebRTC 数据通道的端到端文件传输
- 💬 **实时聊天**：支持文本消息、图片预览、文件传输
- 🏠 **房间管理**：多房间支持，自动发现局域网房间
- 📁 **文件传输**：支持暂停/恢复、取消、进度显示、哈希校验
- 🎨 **现代 UI**：使用 Tailwind CSS + shadcn/ui，响应式设计
- 👥 **用户管理**：昵称设置、在线状态、私聊/群聊切换

## 🛠️ 技术栈

**后端**
- Go 1.21
- Gorilla WebSocket（信令服务器）
- 心跳检测机制，防止僵尸连接

**前端**
- React 18
- Vite 3
- Tailwind CSS
- shadcn/ui 组件库
- WebRTC DataChannel API

## 🚀 快速开始

### 本地开发

```bash
# 启动后端和前端
cd frontend && npm install && npm run build && cd .. && go run .
```

访问 `http://localhost:3456`

### Docker 部署

```bash
docker build -t patrick-im .
docker run -d -p 3456:3456 patrick-im
```

### 远程部署

```bash
./deploy-remote.sh
```

## 📝 License

MIT
