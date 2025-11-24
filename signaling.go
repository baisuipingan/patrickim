package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket 升级器配置
// 设计原因：
// CheckOrigin 返回 true 允许跨域 WebSocket 连接
// 这在局域网聊天场景中是必要的，因为客户端可能来自不同的 IP 地址
// 生产环境建议验证 Origin 头以防止 CSRF 攻击
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // 允许所有来源的 WebSocket 连接
	},
}

// Room 代表一个聊天房间
type Room struct {
	ID        string             // 房间唯一标识
	Clients   map[string]*Client // 房间内的客户端
	CreatedAt time.Time          // 房间创建时间
	IsPrivate bool               // 是否为私有房间（不在房间列表中显示）
	mu        sync.RWMutex       // 保护 Clients map 的读写锁
}

// Message 代表一条信令消息
// 设计原因：
//  1. Type 字段区分消息类型（offer/answer/candidate/user_joined 等）
//  2. Payload 使用 json.RawMessage 延迟解析，避免服务器解析复杂的 WebRTC 数据结构
//     服务器只负责转发，不需要理解 SDP 或 ICE Candidate 的内容
//  3. From 字段由服务器强制设置，防止客户端伪造身份
//  4. To 字段支持单播（指定接收者）和广播（为空时发给所有人）
type Message struct {
	Type    string          `json:"type"`         // 消息类型
	Payload json.RawMessage `json:"payload"`      // 原始 JSON 负载数据
	From    string          `json:"from"`         // 发送者 ID（服务器强制设置）
	To      string          `json:"to,omitempty"` // 接收者 ID（为空则广播）
}

// Client 代表一个 WebSocket 客户端连接
// 设计原因：
//  1. send channel 是解决 WebSocket 并发写入问题的关键
//     Gorilla WebSocket 不支持多 goroutine 同时写入同一连接
//     所有写入操作都投递到 send channel，由 writePump 串行处理
//  2. Hub 引用用于在连接断开时通知中央调度器
type Client struct {
	ID        string          // 客户端唯一标识
	RoomID    string          // 所属房间ID
	IsPrivate bool            // 是否为私有房间
	Conn      *websocket.Conn // WebSocket 连接对象
	Hub       *Hub            // 指向中央 Hub 的引用
	send      chan Message    // 发送消息的缓冲 channel，容量 256
}

// Hub 是中央消息调度器
// 设计原因：
// 1. 使用 channel 实现事件驱动架构，避免回调地狱
// 2. 所有对 clients map 的访问都在 Run() 的单一 goroutine 中，避免复杂的锁竞争
// 3. sync.RWMutex 允许多个 goroutine 同时读取 clients（如广播消息时）
// 4. channel 天然线程安全，简化并发编程
type Hub struct {
	rooms      map[string]*Room // 所有房间的映射表
	broadcast  chan Message     // 接收需要转发的消息
	register   chan *Client     // 接收客户端注册请求
	unregister chan *Client     // 接收客户端注销请求
	mu         sync.RWMutex     // 保护 rooms map 的读写锁
}

// safeClose 安全关闭 channel，避免重复关闭导致 panic
func safeClose(ch chan Message) {
	defer func() {
		if recover() != nil {
			// Channel 已经关闭，忽略 panic
		}
	}()
	close(ch)
}

// NewHub 创建一个新的 Hub 实例
// 设计原因：
// 1. 使用构造函数确保所有 channel 和 map 都被正确初始化
// 2. channel 不设置缓冲区，确保消息处理是同步的（发送者会等待 Hub 处理）
func NewHub() *Hub {
	return &Hub{
		broadcast:  make(chan Message),     // 无缓冲 channel
		register:   make(chan *Client),     // 无缓冲 channel
		unregister: make(chan *Client),     // 无缓冲 channel
		rooms:      make(map[string]*Room), // 房间映射表
	}
}

// getOrCreateRoom 获取或创建房间
func (h *Hub) getOrCreateRoom(roomID string, isPrivate bool) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	room, exists := h.rooms[roomID]
	if !exists {
		room = &Room{
			ID:        roomID,
			Clients:   make(map[string]*Client),
			CreatedAt: time.Now(),
			IsPrivate: isPrivate,
		}
		h.rooms[roomID] = room
		privateStr := ""
		if isPrivate {
			privateStr = " (private)"
		}
		log.Printf("Created room: %s%s", roomID, privateStr)
	}
	return room
}

// Run 是 Hub 的事件循环，处理所有客户端注册、注销和消息转发
// 设计原因：
// 1. 使用 select 多路复用，同时监听多个 channel，哪个有数据就处理哪个
// 2. 所有对 clients map 的修改操作都集中在这一个 goroutine，避免并发写入冲突
// 3. 无限循环保证服务器持续运行
func (h *Hub) Run() {
	for {
		select {
		// ====== 处理客户端注册 ======
		case client := <-h.register:
			// 获取或创建房间（从 client 中读取 IsPrivate 信息）
			room := h.getOrCreateRoom(client.RoomID, client.IsPrivate)

			room.mu.Lock()
			// 如果 ID 已存在，关闭旧连接
			if old, ok := room.Clients[client.ID]; ok {
				safeClose(old.send)
				delete(room.Clients, client.ID)
			}
			room.Clients[client.ID] = client
			room.mu.Unlock()

			log.Printf("Client %s joined room %s", client.ID, client.RoomID)

			// 步骤 1：发送房间内现有用户列表给新客户端
			existingUsers := make([]string, 0)
			room.mu.RLock()
			for id := range room.Clients {
				if id != client.ID {
					existingUsers = append(existingUsers, id)
				}
			}
			room.mu.RUnlock()

			if len(existingUsers) > 0 {
				payload, _ := json.Marshal(existingUsers)
				client.send <- Message{
					Type:    "existing_users",
					From:    "server",
					Payload: payload,
				}
			}

			// 步骤 2：通知房间内其他人有新用户加入
			msg := Message{
				Type:    "user_joined",
				From:    client.ID,
				Payload: nil,
			}
			h.broadcastToRoom(client.RoomID, msg, client.ID)

		// ====== 处理客户端注销 ======
		case client := <-h.unregister:
			h.mu.RLock()
			room, roomExists := h.rooms[client.RoomID]
			h.mu.RUnlock()

			if roomExists {
				room.mu.Lock()
				if _, ok := room.Clients[client.ID]; ok {
					delete(room.Clients, client.ID)
					safeClose(client.send)
					log.Printf("Client %s left room %s", client.ID, client.RoomID)

					// 检查房间是否为空
					isEmpty := len(room.Clients) == 0
					room.mu.Unlock()

					// 如果房间为空且创建超过5分钟，删除房间
					if isEmpty && time.Since(room.CreatedAt) > 5*time.Minute {
						h.mu.Lock()
						delete(h.rooms, client.RoomID)
						h.mu.Unlock()
						log.Printf("Deleted empty room: %s", client.RoomID)
					}

					// 通知房间内其他人该用户离开
					msg := Message{
						Type:    "user_left",
						From:    client.ID,
						Payload: nil,
					}
					h.broadcastToRoom(client.RoomID, msg, "")
				} else {
					room.mu.Unlock()
				}
			}

		// ====== 处理消息转发 ======
		case message := <-h.broadcast:
			// 从消息中获取发送者的房间ID
			h.mu.RLock()
			var senderRoom *Room
			for _, room := range h.rooms {
				room.mu.RLock()
				if _, ok := room.Clients[message.From]; ok {
					senderRoom = room
					room.mu.RUnlock()
					break
				}
				room.mu.RUnlock()
			}
			h.mu.RUnlock()

			if senderRoom == nil {
				continue // 发送者不在任何房间，丢弃消息
			}

			// 收集发送失败的客户端ID
			var failedClients []string

			senderRoom.mu.RLock()
			if message.To != "" {
				// 单播模式：只发给同房间的指定接收者
				log.Printf("📤 单播 [房间%s]: %s → %s (%s)", senderRoom.ID, message.From, message.To, message.Type)
				if client, ok := senderRoom.Clients[message.To]; ok {
					select {
					case client.send <- message:
					default:
						safeClose(client.send)
						failedClients = append(failedClients, client.ID)
					}
				}
			} else {
				// 广播模式：发给同房间内除发送者外的所有人
				log.Printf("📢 广播 [房间%s]: %s (%s)", senderRoom.ID, message.From, message.Type)
				for id, client := range senderRoom.Clients {
					if id == message.From {
						continue
					}
					select {
					case client.send <- message:
					default:
						safeClose(client.send)
						failedClients = append(failedClients, client.ID)
					}
				}
			}
			senderRoom.mu.RUnlock()

			// 在锁外删除失败的客户端
			if len(failedClients) > 0 {
				senderRoom.mu.Lock()
				for _, id := range failedClients {
					delete(senderRoom.Clients, id)
				}
				senderRoom.mu.Unlock()
			}
		}
	}
}

// broadcastToRoom 向指定房间广播消息（可排除指定 ID）
func (h *Hub) broadcastToRoom(roomID string, msg Message, excludeID string) {
	h.mu.RLock()
	room, exists := h.rooms[roomID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	// 收集发送失败的客户端ID
	var failedClients []string

	room.mu.RLock()
	for id, client := range room.Clients {
		if id == excludeID {
			continue
		}
		select {
		case client.send <- msg:
		default:
			safeClose(client.send)
			failedClients = append(failedClients, client.ID)
		}
	}
	room.mu.RUnlock()

	// 在锁外删除失败的客户端
	if len(failedClients) > 0 {
		room.mu.Lock()
		for _, id := range failedClients {
			delete(room.Clients, id)
		}
		room.mu.Unlock()
	}
}

// writePump 是每个客户端的发送协程
// 设计原因：
//  1. 解决 Gorilla WebSocket 不支持并发写入的问题
//     所有写入操作都在这个单独的 goroutine 中串行执行
//  2. 从 send channel 读取消息，实现生产者-消费者模式
//  3. channel 关闭时自动退出，清理资源
//  4. 定期发送 ping 消息进行心跳检测
func (c *Client) writePump() {
	// 创建 ping ticker，每 30 秒发送一次 ping
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close() // 退出时关闭 WebSocket 连接
	}()

	for {
		select {
		case msg, ok := <-c.send:
			// 设置写入超时 10 秒
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				// send channel 已关闭，说明客户端已注销
				// 发送 WebSocket 关闭帧通知客户端
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteJSON(msg); err != nil {
				// 写入失败，说明连接已断开
				return
			}
		case <-ticker.C:
			// 发送 ping 消息
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump 是每个客户端的接收协程
// 设计原因：
// 1. 持续从 WebSocket 读取消息，直到连接断开
// 2. 强制设置 msg.From 字段，防止客户端伪造身份（安全措施）
// 3. 将消息投递到 Hub 的 broadcast channel，由 Hub 统一调度转发
// 4. 退出时自动注销客户端
// 5. 使用心跳机制检测僵尸连接
func (c *Client) readPump() {
	defer func() {
		c.Hub.unregister <- c // 通知 Hub 该客户端已断开
		c.Conn.Close()        // 关闭 WebSocket 连接
	}()

	// 设置读取超时和心跳检测
	// 60秒内没有收到任何消息（包括pong）则认为连接断开
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	// 设置 pong 处理器，收到 pong 时重置超时
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		var msg Message
		err := c.Conn.ReadJSON(&msg)
		if err != nil {
			// 检查是否为意外关闭错误
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break // 连接断开，退出循环
		}

		// 收到消息，重置读取超时
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		// 安全措施：强制设置发送者 ID，防止客户端伪造
		msg.From = c.ID
		// 将消息投递到 Hub 进行转发
		c.Hub.broadcast <- msg
	}
}

// serveWs 处理 WebSocket 升级请求
// 设计原因：
// 1. 将 HTTP 请求升级为 WebSocket 长连接
// 2. 从 URL 参数获取客户端 ID 和房间 ID
// 3. 创建 Client 对象并启动两个 goroutine：
//   - writePump：处理发送
//   - readPump：处理接收
func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	// 将 HTTP 请求升级为 WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}

	// 从 URL 参数获取客户端 ID（例如：/ws?id=abc123&room=room1）
	id := r.URL.Query().Get("id")
	if id == "" {
		// 如果没有提供 ID，使用 IP 地址作为匿名 ID
		id = "anon_" + r.RemoteAddr
	}

	// 从 URL 参数获取房间 ID
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		// 如果没有提供房间 ID，使用默认房间
		roomID = "default"
	}

	// 从 URL 参数获取是否为私有房间
	isPrivate := r.URL.Query().Get("private") == "true"

	// 创建客户端对象
	client := &Client{
		ID:        id,
		RoomID:    roomID,
		IsPrivate: isPrivate,
		Conn:      conn,
		Hub:       hub,
		send:      make(chan Message, 256), // 缓冲 256 条消息
	}
	// 向 Hub 注册该客户端
	hub.register <- client

	// 启动两个独立的 goroutine
	go client.writePump() // 发送协程
	go client.readPump()  // 接收协程
}

// RoomInfo 房间信息结构
type RoomInfo struct {
	ID          string    `json:"id"`
	ClientCount int       `json:"clientCount"`
	Clients     []string  `json:"clients"`
	CreatedAt   time.Time `json:"createdAt"`
	IsPrivate   bool      `json:"isPrivate"`
}

// getRooms 返回所有房间列表（过滤私有房间）
func getRooms(hub *Hub, w http.ResponseWriter, r *http.Request) {
	hub.mu.RLock()
	defer hub.mu.RUnlock()

	rooms := make([]RoomInfo, 0, len(hub.rooms))
	for _, room := range hub.rooms {
		// 跳过私有房间
		if room.IsPrivate {
			continue
		}

		room.mu.RLock()
		clientIDs := make([]string, 0, len(room.Clients))
		for id := range room.Clients {
			clientIDs = append(clientIDs, id)
		}
		rooms = append(rooms, RoomInfo{
			ID:          room.ID,
			ClientCount: len(room.Clients),
			Clients:     clientIDs,
			CreatedAt:   room.CreatedAt,
			IsPrivate:   room.IsPrivate,
		})
		room.mu.RUnlock()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rooms)
}
