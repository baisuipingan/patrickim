# Patrick IM

一个现代化、高性能的点对点（P2P）即时通讯系统。它利用 WebRTC 技术实现端到端的加密通信，无需中心化服务器存储消息，真正保护用户隐私。系统能够智能识别网络环境，在局域网内自动直连以获得最高速度，在公网环境下通过 STUN 实现穿透连接。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/backend-Go%201.21-00ADD8.svg)
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

### 🎨 现代化界面
- **响应式设计**：完美适配桌面端和移动端，侧边栏在移动端自动折叠。
- **美观交互**：基于 shadcn/ui 和 Tailwind CSS 构建，提供流畅的动画和精致的视觉效果。
- **实时状态**：在线人数、用户状态（连接中/已连接/离线）实时更新。

## 🛠️ 技术栈

**后端 (Backend)**
- **Go 1.21**: 高性能并发处理
- **Gorilla WebSocket**: 可靠的信令交换通道
- **并发安全**: 完善的锁机制和协程管理

**前端 (Frontend)**
- **React 18**: 组件化 UI 开发
- **Vite 3**: 极速构建体验
- **WebRTC**: 核心 P2P 通信技术
- **Tailwind CSS**: 原子化 CSS 样式
- **shadcn/ui**: 高质量 UI 组件库
- **CryptoJS**: 前端数据加密与哈希计算

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

最简单的部署方式，只需一条命令即可拥有自己的 IM 服务。

```bash
# 构建并启动容器
docker run -d -p 3456:3456 --name patrick-im registry.cn-qingdao.aliyuncs.com/patrickcmh/patrick-im:latest
```

访问 `http://localhost:3456` 即可使用。

### 方式二：本地源码运行

适合开发和调试。

```bash
# 1. 克隆仓库
git clone https://github.com/your-repo/patrickim.git
cd patrickim

# 2. 构建前端
cd frontend
npm install
npm run build
cd ..

# 3. 运行后端
go run .
```

## 📝 开发计划

- [x] 基础 P2P 聊天与文件传输
- [x] 断点续传与哈希校验
- [x] 局域网/公网智能切换与标识
- [x] 消息持久化与历史记录
- [x] 未读消息计数与智能定位
- [ ] 音视频通话支持
- [ ] 屏幕共享功能

## 📄 License

MIT License - 自由使用，欢迎贡献！
