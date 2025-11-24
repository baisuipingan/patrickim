package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

// 使用 go:embed 将前端构建产物嵌入到 Go 二进制文件中
// 设计原因：
// 1. 部署简化：只需一个可执行文件，无需额外携带前端资源文件夹
// 2. 版本一致性：前后端版本绑定，避免资源不匹配
// 3. 跨平台友好：编译后可直接在目标平台运行，无需配置静态文件路径
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// 创建信令服务器的中央调度器（Hub）
	// 设计原因：
	// Hub 采用事件驱动模型，通过 channel 解耦消息生产者和消费者
	// 所有客户端的注册、注销、消息转发都通过 Hub 统一调度
	hub := NewHub()

	// 在独立的 goroutine 中运行 Hub 的事件循环
	// 设计原因：
	// Hub.Run() 是一个阻塞的无限循环，必须放在后台运行
	// 这样主 goroutine 可以继续初始化 HTTP 服务器
	go hub.Run()

	// 从嵌入的文件系统中提取 frontend/dist 子目录
	// 设计原因：
	// embed.FS 嵌入的是完整路径（包含 frontend/dist 前缀）
	// fs.Sub 去除路径前缀，让文件服务器从 dist 根目录开始提供文件
	// 例如：访问 /index.html 会映射到 frontend/dist/index.html
	subFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatalf("Error accessing frontend/dist: %v", err)
	}

	// 将根路径 "/" 映射到静态文件服务器
	// 设计原因：
	// 使用 http.FileServer 自动处理静态文件请求（HTML/CSS/JS/图片等）
	// 支持 Content-Type 自动识别、Range 请求（视频流）、缓存控制等
	http.Handle("/", http.FileServer(http.FS(subFS)))

	// 注册 WebSocket 升级端点 "/ws"
	// 设计原因：
	// WebSocket 提供全双工通信，适合实时信令交换
	// 将 hub 通过闭包传递给 serveWs，避免使用全局变量
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	// 注册房间列表 API 端点
	http.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		getRooms(hub, w, r)
	})

	log.Println("Starting Server on :3456")

	// 启动 HTTP 服务器，监听 0.0.0.0:3456
	// 设计原因：
	// 0.0.0.0：监听所有网络接口，支持局域网内其他设备访问
	// :3456：自定义端口，避免与常见服务冲突（80/443/8080 等）
	// ListenAndServe 是阻塞调用，会一直运行直到出错或被终止
	if err := http.ListenAndServe("0.0.0.0:3456", nil); err != nil {
		log.Fatal("Server error:", err)
	}
}
