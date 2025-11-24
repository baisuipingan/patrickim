import { useState, useEffect, useRef, Component } from 'react';
import CryptoJS from 'crypto-js';
import { formatSize, formatTime, formatSpeed } from './utils/formatters';
import { isModernFileAPISupported } from './utils/fileUtils';
import { ICE_SERVERS } from './constants/config';
import { useRoom } from './hooks/useRoom';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useChatHistory } from './hooks/useChatHistory';
import { RoomSelector } from './components/RoomSelector';
import FileProgress from './components/FileProgress';
import MessageInput from './components/MessageInput';
import ChatMessage from './components/ChatMessage';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Badge } from './components/ui/badge';
import { Avatar, AvatarFallback } from './components/ui/avatar';
import { Menu, Globe, Edit2, X, Trash2 } from 'lucide-react';
import { cn } from './lib/utils';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-5 text-red-600">
          <h2 className="text-xl font-bold mb-2">Something went wrong.</h2>
          <pre className="text-sm">{this.state.error && this.state.error.toString()}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChatApp() {
    const [logs, setLogs] = useState([]);
    const [message, setMessage] = useState("");
    const [isComposing, setIsComposing] = useState(false); // 输入法输入状态
    const [chatHistory, setChatHistory] = useState([]);
    const [pendingFiles, setPendingFiles] = useState([]); // 待发送的文件列表
    const [onlineUsers, setOnlineUsers] = useState(new Set());
    const [previewImage, setPreviewImage] = useState(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [activeUser, setActiveUser] = useState(null); // null = Global Chat, string = Private Chat User ID
    const [isEditingNickname, setIsEditingNickname] = useState(false);
    const [nickname, setNickname] = useState(() => localStorage.getItem('nickname') || '');
    const [userNicknames, setUserNicknames] = useState({}); // id -> nickname mapping
    const [connectionStatus, setConnectionStatus] = useState({}); // id -> 'connecting' | 'connected' | 'disconnected'
    const [isPrivate, setIsPrivate] = useState(false); // 是否创建私有房间
    const [unreadCounts, setUnreadCounts] = useState({}); // 未读消息计数 { userId: count }
    const isModernAPISupported = isModernFileAPISupported();
    
    // Refs for mutable objects
    const wsRef = useRef(null);
    const getStoredId = () => {
        let id = sessionStorage.getItem("userId");
        if (!id) {
            id = Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem("userId", id);
        }
        return id;
    };
    const myIdRef = useRef(getStoredId());
    const peersRef = useRef({}); // id -> {pc, dc}
    const eventQueueRef = useRef({}); // remoteId -> EventQueue
    const connectionTimeoutRef = useRef({}); // remoteId -> timeout handle
    
    // 保存昵称到 localStorage
    useEffect(() => {
        if (nickname) {
            localStorage.setItem('nickname', nickname);
        }
    }, [nickname]);
    
    // 房间管理 Hook
    const {
        currentRoom,
        showRoomInput,
        roomInput,
        rooms,
        myICECandidatesRef,
        setCurrentRoom,
        setShowRoomInput,
        setRoomInput,
        fetchRooms
    } = useRoom();
    
    // 聊天历史管理 Hook
    const { loadChatHistory, saveChatHistory, clearChatHistory } = useChatHistory(
        myIdRef.current,
        currentRoom
    );
    
    // 存储 Blob URLs 用于清理
    const blobUrlsRef = useRef(new Set());
    
    const chatBoxRef = useRef(null);
    
    // Auto-scroll to bottom
    useEffect(() => {
        if (chatBoxRef.current) {
            chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
        }
    }, [chatHistory]);
    
    const log = (msg) => setLogs(prev => [...prev, msg]);
    
    // 添加聊天消息并自动保存到 localStorage
    const addChat = (msg) => {
        setChatHistory(prev => {
            const newHistory = [...prev, msg];
            // 异步保存，不阻塞UI
            setTimeout(() => saveChatHistory(newHistory, currentRoom), 0);
            return newHistory;
        });
        
        // 更新未读消息计数
        if (msg.from && msg.from !== 'Me' && msg.from !== myIdRef.current) {
            // 判断消息对应的聊天窗口
            let chatWindow = null;
            if (msg.mode === 'private' || msg.to === myIdRef.current) {
                // 私聊消息，对应的聊天窗口是发送者
                chatWindow = msg.from;
            } else if (msg.mode === 'broadcast') {
                // 全局消息，对应的聊天窗口是 null
                chatWindow = null;
            }
            
            // 如果不是当前活跃的聊天窗口，增加未读计数
            if (chatWindow !== activeUser) {
                const key = chatWindow === null ? '__global__' : chatWindow;
                setUnreadCounts(prev => ({
                    ...prev,
                    [key]: (prev[key] || 0) + 1
                }));
            }
        }
    };
    
    // 清除当前房间的聊天历史
    const handleClearHistory = () => {
        if (window.confirm('确定要清除当前房间的聊天历史吗？此操作不可恢复。')) {
            clearChatHistory(currentRoom);
            setChatHistory([]);
            log('聊天历史已清除');
        }
    };
    
    // 切换聊天窗口（清零未读计数）
    const switchToUser = (userId) => {
        setActiveUser(userId);
        // 清零该聊天窗口的未读计数
        const key = userId === null ? '__global__' : userId;
        setUnreadCounts(prev => {
            const newCounts = { ...prev };
            delete newCounts[key];
            return newCounts;
        });
    };
    
    // getDisplayName 在下面定义（需要访问 nickname 状态）
    const getDisplayName = (userId) => {
        if (userId === myIdRef.current) return nickname || myIdRef.current;
        return userNicknames[userId] || userId;
    };
    
    // 文件传输 Hook
    const {
        fileProgress,
        setFileProgress,
        transferControlRef,
        incomingFilesRef,
        isSendingFileRef,
        fileQueueRef,
        sendFile,
        initFileReceive,
        processFileQueue
    } = useFileTransfer({
        log,
        addChat,
        peersRef,
        myId: myIdRef.current,
        getDisplayName,
        blobUrlsRef,
        activeUser
    });

    const updateOnlineUsers = (action, userId, list = null) => {
        setOnlineUsers(prev => {
            if (action === 'set' && Array.isArray(list)) {
                return new Set(list);
            }
            
            const newSet = new Set(prev);
            if (action === 'add' && userId) {
                newSet.add(userId);
            } else if (action === 'remove' && userId) {
                newSet.delete(userId);
            }
            return newSet;
        });
    };

    // 清理连接的辅助函数
    const cleanupConnections = () => {
        // 清除重连定时器
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        
        // 标记为手动关闭
        isManualCloseRef.current = true;
        
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        
        Object.values(peersRef.current).forEach(peer => {
            if (peer.dc) peer.dc.close();
            if (peer.pc) peer.pc.close();
        });
        peersRef.current = {};
        
        // 清除所有连接超时定时器
        Object.values(connectionTimeoutRef.current).forEach(timer => {
            if (timer) clearTimeout(timer);
        });
        connectionTimeoutRef.current = {};
        setConnectionStatus({}); // 清空连接状态
    };

    useEffect(() => {
        // 页面可见性变化监听
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // 页面隐藏时标记为手动关闭，避免自动重连
                isManualCloseRef.current = true;
            }
        };
        
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        // 如果有上次的房间，自动加入
        if (currentRoom) {
            joinRoom(currentRoom);
        } else {
            setShowRoomInput(true);
            fetchRooms();
        }

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            cleanupConnections();
            // 清理所有 Blob URLs
            blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
            blobUrlsRef.current.clear();
        };
    }, []);
    
    const joinRoom = (roomId) => {
        if (!roomId.trim()) return;
        
        cleanupConnections();
        
        // 加载该房间的聊天历史
        const history = loadChatHistory(roomId);
        setChatHistory(history);
        
        if (history.length > 0) {
            log(`Loaded ${history.length} messages from history`);
        }
        
        // 清空未读计数（切换房间时）
        setUnreadCounts({});
        
        setOnlineUsers(new Set([myIdRef.current]));
        setCurrentRoom(roomId);
        setShowRoomInput(false);
        localStorage.setItem('lastRoom', roomId);
        
        // 连接到新房间，传递 isPrivate 参数
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const privateParam = isPrivate ? '&private=true' : '';
        const wsUrl = `${protocol}//${window.location.host}/ws?id=${myIdRef.current}&room=${encodeURIComponent(roomId)}${privateParam}`;
        connectWs(wsUrl);
        
        const privateStr = isPrivate ? ' (私有)' : '';
        log(`Joined room: ${roomId}${privateStr}`);
        
        // 重置私有房间选项
        setIsPrivate(false);
    };

    const reconnectTimeoutRef = useRef(null);
    const isManualCloseRef = useRef(false);
    
    const connectWs = (url) => {
        // 清除之前的重连定时器
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        
        // 关闭旧连接
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
            isManualCloseRef.current = true;
            wsRef.current.close();
        }
        
        const ws = new WebSocket(url);
        wsRef.current = ws;
        isManualCloseRef.current = false;

        ws.onopen = () => {
            log("Connected to Signaling Server");
            // 连接成功，清除重连标记
            reconnectTimeoutRef.current = null;
        };

        ws.onmessage = async (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                await handleSignalMessage(msg);
            } catch (err) {
                console.error('Failed to parse WebSocket message:', err);
            }
        };
        
        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        
        ws.onclose = (event) => {
            // 如果是手动关闭或页面卸载，不自动重连
            if (isManualCloseRef.current || document.hidden) {
                log("Connection closed");
                return;
            }
            
            // 只有在非正常关闭时才重连
            if (event.code !== 1000) {
                log("Connection lost. Reconnecting in 3 seconds...");
                reconnectTimeoutRef.current = setTimeout(() => {
                    // 确保当前没有活跃连接
                    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
                        connectWs(url);
                    }
                }, 3000);
            } else {
                log("Disconnected from server");
            }
        };
    };

    const handleSignalMessage = async (msg) => {
        const { type, from, payload } = msg;
        
        switch(type) {
            case 'user_joined':
                log(`User ${from} joined`);
                updateOnlineUsers('add', from);
                // 发送我的昵称给新用户
                if (nickname) {
                    sendSignal('nickname', from, { nickname });
                }
                break;
            case 'nickname':
                // 收到其他用户的昵称
                if (payload && payload.nickname) {
                    setUserNicknames(prev => ({ ...prev, [from]: payload.nickname }));
                    log(`User ${from} is now "${payload.nickname}"`);
                }
                break;
            case 'existing_users':
                // from is 'server', payload is list of IDs
                if (Array.isArray(payload)) {
                    updateOnlineUsers('set', null, [...payload, myIdRef.current]);
                    payload.forEach(id => {
                        log(`Found existing user ${id}`);
                        createPeerConnection(id, true);
                        // 向每个已存在的用户发送我的昵称
                        if (nickname) {
                            setTimeout(() => sendSignal('nickname', id, { nickname }), 100);
                        }
                    });
                }
                break;
            case 'user_left':
                log(`User ${from} left`);
                updateOnlineUsers('remove', from);
                if (peersRef.current[from]) {
                    // 完整清理 PeerConnection
                    const peer = peersRef.current[from];
                    if (peer.dc) peer.dc.close();
                    if (peer.pc) peer.pc.close();
                    delete peersRef.current[from];
                }
                // 清理该用户的连接超时定时器
                if (connectionTimeoutRef.current[from]) {
                    clearTimeout(connectionTimeoutRef.current[from]);
                    delete connectionTimeoutRef.current[from];
                }
                // 清理该用户的事件队列
                delete eventQueueRef.current[from];
                // 清理该用户的文件传输状态
                delete incomingFilesRef.current[from];
                // 清理连接状态
                setConnectionStatus(prev => {
                    const next = { ...prev };
                    delete next[from];
                    return next;
                });
                // 如果正在与该用户私聊，切回全局聊天
                if (activeUser === from) {
                    switchToUser(null);
                    log(`User ${from} left. Switched to Global Chat.`);
                }
                break;
            case 'offer':
                await createPeerConnection(from, false);
                const pc = peersRef.current[from].pc;
                await pc.setRemoteDescription(new RTCSessionDescription(payload));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignal('answer', from, answer);
                break;
            case 'answer':
                 if (peersRef.current[from]) {
                     await peersRef.current[from].pc.setRemoteDescription(new RTCSessionDescription(payload));
                 }
                break;
            case 'candidate':
                 if (peersRef.current[from]) {
                     await peersRef.current[from].pc.addIceCandidate(new RTCIceCandidate(payload));
                 }
                break;
            case 'file-done':
                // 文件传输完成，验证 hash
                const transfer = incomingFilesRef.current[from]?.[payload.fileId];
                if (transfer) {
                    const calculatedHash = transfer.hasher.finalize().toString(CryptoJS.enc.Base64);
                    if (calculatedHash === payload.hash) {
                        log(`✅ File verified: ${transfer.meta.name}`);
                        
                        let fileUrl = null;
                        const isImage = transfer.meta.fileType?.startsWith('image/') || 
                                       /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(transfer.meta.name);
                        
                        // 关闭 writer（如果有）
                        if (transfer.writer) {
                            await transfer.writer.close();
                        }
                        
                        // 创建 Blob URL（统一使用下载方式）
                        if (transfer.chunks && transfer.chunks.length > 0) {
                            const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                            fileUrl = URL.createObjectURL(blob);
                            blobUrlsRef.current.add(fileUrl);
                        } else {
                            log(`⚠️ Warning: No chunks data for ${transfer.meta.name}`);
                        }
                        
                        // 添加到聊天记录（只有有 fileUrl 才添加）
                        if (fileUrl) {
                            const fileMsg = {
                                type: 'file',
                                name: transfer.meta.name,
                                data: fileUrl,
                                mode: transfer.meta.mode || 'broadcast',
                                savedToDisk: false  // 统一使用下载按钮方式
                            };
                            addChat({ from, ...fileMsg });
                        }
                        
                        delete incomingFilesRef.current[from][payload.fileId];
                        delete transferControlRef.current[`down-${payload.fileId}`];
                    } else {
                        log(`❌ Hash mismatch: ${transfer.meta.name}`);
                        alert(`File corrupted: ${transfer.meta.name}`);
                    }
                }
                break;
            case 'file-start':
                await initFileReceive(from, payload);
                break;
        }
    };

    const createPeerConnection = async (remoteId, initiator) => {
        if (peersRef.current[remoteId]) return;

        // 清除之前的超时定时器（如果存在）
        if (connectionTimeoutRef.current[remoteId]) {
            clearTimeout(connectionTimeoutRef.current[remoteId]);
        }

        // 设置连接状态为连接中
        setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'connecting' } }));
        
        // 设置连接超时（30秒）
        connectionTimeoutRef.current[remoteId] = setTimeout(() => {
            const peer = peersRef.current[remoteId];
            if (peer && (!peer.dc || peer.dc.readyState !== 'open')) {
                log(`Connection timeout with ${remoteId}, retrying...`);
                
                // 清理旧连接
                if (peer.dc) peer.dc.close();
                if (peer.pc) peer.pc.close();
                delete peersRef.current[remoteId];
                
                // 更新连接状态为断开
                setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'disconnected' } }));
                
                // 如果我们是发起方，尝试重新连接
                if (initiator) {
                    log(`Initiating reconnection with ${remoteId} after timeout...`);
                    setTimeout(() => {
                        createPeerConnection(remoteId, true);
                    }, 1000);
                }
            }
        }, 30000); // 30秒超时

        const pc = new RTCPeerConnection(ICE_SERVERS);
        let dc;

        if (initiator) {
            dc = pc.createDataChannel("chat");
            setupDataChannel(dc, remoteId);
        } else {
            pc.ondatachannel = (e) => {
                setupDataChannel(e.channel, remoteId);
            };
        }

        peersRef.current[remoteId] = { pc, dc: initiator ? dc : null };
        
        // 检测网络连接类型的辅助函数
        const detectNetworkType = () => {
            pc.getStats().then(stats => {
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        // 获取本地和远程候选者信息
                        stats.forEach(candidate => {
                            if (candidate.id === report.localCandidateId) {
                                const localType = candidate.candidateType;
                                const localAddress = candidate.address || candidate.ip;
                                
                                stats.forEach(remote => {
                                    if (remote.id === report.remoteCandidateId) {
                                        const remoteType = remote.candidateType;
                                        const remoteAddress = remote.address || remote.ip;
                                        
                                        // 判断是否为局域网连接
                                        // host类型表示直连（局域网），srflx表示STUN穿透（公网），relay表示TURN中继
                                        const isLAN = localType === 'host' && remoteType === 'host';
                                        const networkType = isLAN ? 'lan' : 'wan';
                                        
                                        log(`${remoteId} 连接类型: ${networkType.toUpperCase()} (${localType} -> ${remoteType})`);
                                        
                                        // 更新连接状态，包含网络类型信息
                                        setConnectionStatus(prev => ({
                                            ...prev,
                                            [remoteId]: {
                                                status: 'connected',
                                                networkType,
                                                localAddress,
                                                remoteAddress,
                                                localType,
                                                remoteType
                                            }
                                        }));
                                    }
                                });
                            }
                        });
                    }
                });
            }).catch(err => {
                console.error('Failed to get connection stats:', err);
            });
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                // 收集 ICE Candidates 用于局域网检测
                if (e.candidate.address) {
                    myICECandidatesRef.current.push({
                        type: e.candidate.type,
                        address: e.candidate.address,
                        candidate: e.candidate.candidate
                    });
                }
                sendSignal('candidate', remoteId, e.candidate);
            }
        };

        // 监听 ICE 连接状态变化，处理网络切换等情况
        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            log(`ICE connection state with ${remoteId}: ${state}`);
            
            if (state === 'failed' || state === 'disconnected') {
                log(`Connection ${state} with ${remoteId}, attempting to reconnect...`);
                
                // 延迟重连，避免频繁重试
                setTimeout(() => {
                    // 检查是否还在断开状态
                    if (peersRef.current[remoteId] && 
                        (peersRef.current[remoteId].pc.iceConnectionState === 'failed' || 
                         peersRef.current[remoteId].pc.iceConnectionState === 'disconnected')) {
                        
                        // 清理旧连接
                        const peer = peersRef.current[remoteId];
                        if (peer) {
                            if (peer.dc) peer.dc.close();
                            if (peer.pc) peer.pc.close();
                            delete peersRef.current[remoteId];
                        }
                        
                        // 更新连接状态
                        setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'disconnected' } }));
                        
                        // 如果我们是发起方，尝试重新连接
                        if (initiator) {
                            log(`Initiating reconnection with ${remoteId}...`);
                            setTimeout(() => {
                                createPeerConnection(remoteId, true);
                            }, 1000);
                        }
                    }
                }, 2000); // 等待2秒，看连接是否能自动恢复
            } else if (state === 'connected' || state === 'completed') {
                log(`ICE connection established with ${remoteId}`);
                // ICE连接稳定后，延迟500ms检测网络类型（等待候选者对最终确定）
                setTimeout(() => {
                    if (peersRef.current[remoteId]) {
                        detectNetworkType();
                    }
                }, 500);
            }
        };
        
        // 监听整体连接状态
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            log(`Connection state with ${remoteId}: ${state}`);
            
            if (state === 'failed') {
                log(`Connection failed with ${remoteId}`);
                setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'disconnected' } }));
            }
        };

        if (initiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal('offer', remoteId, offer);
        }
    };

    const setupDataChannel = (dc, remoteId) => {
        if (peersRef.current[remoteId]) {
            peersRef.current[remoteId].dc = dc;
        }
        
        // 重要：设置为 arraybuffer 以便接收二进制数据
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 0;

        dc.onopen = () => {
            log(`Connected to ${remoteId}`);
            // 清除连接超时定时器
            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }
            // 更新连接状态为已连接（先设置基本状态）
            setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'connected' } }));
            // 注意：网络类型检测移到 ICE 状态变化监听中，等待连接稳定后再检测
        };
        
        dc.onclose = () => {
            log(`DataChannel closed with ${remoteId}`);
            // 清除连接超时定时器
            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }
            // 更新连接状态为已断开
            setConnectionStatus(prev => ({ ...prev, [remoteId]: { status: 'disconnected' } }));
            // 清理该用户的事件队列
            delete eventQueueRef.current[remoteId];
        };
        
        dc.onerror = (error) => {
            // DataChannel 错误通常是连接断开或关闭时的正常现象
            // 只有在 DataChannel 处于 open 状态时才是真正的错误
            if (dc.readyState === 'open' || dc.readyState === 'connecting') {
                console.warn(`DataChannel error with ${remoteId}:`, error);
                log(`⚠️ Connection issue with ${remoteId}`);
            }
            // readyState 为 'closing' 或 'closed' 时是正常清理，忽略
        };
        
        // 创建事件队列保证接收顺序
        if (!eventQueueRef.current[remoteId]) {
            eventQueueRef.current[remoteId] = createEventQueue();
        }
        
        dc.onmessage = (e) => {
            // 添加到事件队列，保证顺序处理
            eventQueueRef.current[remoteId].enqueue(() => handleMessage(remoteId, e.data));
        };
    };
    
    // 创建事件队列
    const createEventQueue = () => {
        let tail = Promise.resolve();
        return {
            enqueue: (handler) => {
                tail = tail.then(handler).catch(err => console.error('EventQueue error:', err));
            }
        };
    };
    
    const handleMessage = async (remoteId, data) => {
        // 1. 处理二进制 chunk
        if (data instanceof ArrayBuffer) {
            handleBinaryChunk(remoteId, data);
            return;
        }
        
        // 2. 处理 JSON 消息
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'cancel-transfer') {
                // 发送端主动取消，通知接收端
                const control = transferControlRef.current[`down-${msg.fileId}`];
                if (control) {
                    log(`发送方已取消传输`);
                    control.cancelled = true;
                    delete incomingFilesRef.current[remoteId]?.[msg.fileId];
                    setFileProgress(prev => {
                        const next = { ...prev };
                        delete next[`down-${msg.fileId}`];
                        return next;
                    });
                    delete transferControlRef.current[`down-${msg.fileId}`];
                }
            } else if (msg.type === 'pause-transfer-by-sender') {
                // 发送端暂停，接收端显示暂停状态
                const control = transferControlRef.current[`down-${msg.fileId}`];
                if (control) {
                    log(`发送端已暂停发送`);
                    control.paused = true;
                    // 强制更新UI显示暂停状态
                    setFileProgress(prev => ({...prev}));
                }
            } else if (msg.type === 'resume-transfer-by-sender') {
                // 发送端恢复，接收端显示恢复状态
                const control = transferControlRef.current[`down-${msg.fileId}`];
                if (control) {
                    log(`发送端已恢复发送`);
                    control.paused = false;
                    // 强制更新UI显示恢复状态
                    setFileProgress(prev => ({...prev}));
                }
            } else if (msg.type === 'pause-transfer-by-receiver') {
                // 接收端暂停，发送端停止向该接收端发送
                const control = transferControlRef.current[`up-${msg.fileId}`];
                if (control && msg.receiverId) {
                    log(`接收端 ${msg.receiverId} 已暂停接收`);
                    control.subPaused[msg.receiverId] = true;
                    // 强制更新UI显示暂停状态
                    setFileProgress(prev => ({...prev}));
                }
            } else if (msg.type === 'resume-transfer-by-receiver') {
                // 接收端恢复，发送端继续向该接收端发送
                const control = transferControlRef.current[`up-${msg.fileId}`];
                if (control && msg.receiverId) {
                    log(`接收端 ${msg.receiverId} 已恢复接收`);
                    control.subPaused[msg.receiverId] = false;
                    // 主动触发该接收端的 sendBatch 继续发送
                    const sendBatch = control.subSendBatch[msg.receiverId];
                    if (sendBatch) sendBatch();
                    // 强制更新UI显示恢复状态
                    setFileProgress(prev => ({...prev}));
                }
            } else if (msg.type === 'cancel-transfer-by-receiver') {
                // 接收端主动取消，发送端只停止向该接收端发送
                const control = transferControlRef.current[`up-${msg.fileId}`];
                if (control && msg.receiverId) {
                    log(`接收端 ${msg.receiverId} 已取消接收`);
                    control.subCancelled[msg.receiverId] = true;
                    
                    // 清理该接收端的进度条
                    setFileProgress(prev => {
                        const next = { ...prev };
                        delete next[`up-${msg.fileId}-${msg.receiverId}`];
                        return next;
                    });
                    
                    // 检查是否所有接收端都已取消
                    const allCancelled = Object.keys(control.subChannels).every(
                        id => control.subCancelled[id] === true
                    );
                    
                    if (allCancelled) {
                        log(`所有接收端都已取消，停止发送`);
                        // 移除所有事件监听器
                        Object.values(control.subChannels).forEach(channel => {
                            if (channel) channel.onbufferedamountlow = null;
                        });
                        // 清理控制对象
                        delete transferControlRef.current[`up-${msg.fileId}`];
                    }
                }
            } else if (msg.type === 'file-done') {
                // 文件传输完成，验证 hash
                const transfer = incomingFilesRef.current[remoteId]?.[msg.fileId];
                if (transfer) {
                    const calculatedHash = transfer.hasher.finalize().toString(CryptoJS.enc.Base64);
                    if (calculatedHash === msg.hash) {
                        log(`✅ File verified: ${transfer.meta.name}`);
                        
                        let fileUrl = null;
                        const isImage = transfer.meta.fileType?.startsWith('image/') || 
                                       /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(transfer.meta.name);
                        
                        // 关闭 writer（如果有）
                        if (transfer.writer) {
                            await transfer.writer.close();
                        }
                        
                        // 创建 Blob URL（统一使用下载方式）
                        if (transfer.chunks && transfer.chunks.length > 0) {
                            const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                            fileUrl = URL.createObjectURL(blob);
                            blobUrlsRef.current.add(fileUrl);
                        } else {
                            log(`⚠️ Warning: No chunks data for ${transfer.meta.name}`);
                        }
                        
                        // 添加到聊天记录（只有有 fileUrl 才添加）
                        if (fileUrl) {
                            const fileMsg = {
                                type: 'file',
                                name: transfer.meta.name,
                                data: fileUrl,
                                mode: transfer.meta.mode || 'broadcast',
                                savedToDisk: false  // 统一使用下载按钮方式
                            };
                            addChat({ from: remoteId, ...fileMsg });
                        }
                        
                        delete incomingFilesRef.current[remoteId][msg.fileId];
                        delete transferControlRef.current[`down-${msg.fileId}`];
                    } else {
                        log(`❌ Hash mismatch: ${transfer.meta.name}`);
                        alert(`File corrupted: ${transfer.meta.name}`);
                    }
                }
            } else if (msg.type === 'file-start') {
                await initFileReceive(remoteId, msg);
            } else {
                // Normal chat or other signaling
                if (!msg.mode) {
                    msg.mode = 'broadcast';
                }
                addChat({ from: remoteId, ...msg });
            }
        } catch {
            addChat({ from: remoteId, text: data, type: 'text', mode: 'broadcast' });
        }
    };
    
    const handleBinaryChunk = async (remoteId, chunk) => {
        const transfers = incomingFilesRef.current[remoteId];
        if (!transfers) return;
        
        // 找到第一个未完成的文件
        for (const fileId in transfers) {
            const transfer = transfers[fileId];
            
            // 检查是否已取消
            if (transferControlRef.current[`down-${fileId}`]?.cancelled) {
                if (transfer.writer) await transfer.writer.close();
                delete transfers[fileId];
                continue;
            }
            
            // 检查是否已暂停（暂停时数据继续接收但不显示进度更新）
            const isPaused = transferControlRef.current[`down-${fileId}`]?.paused;
            
            if (transfer.received < transfer.meta.size) {
                // 更新 hash
                transfer.hasher.update(CryptoJS.lib.WordArray.create(chunk));
                
                // 写入文件
                if (transfer.writer) {
                    // 现代 API: 流式写入
                    await transfer.writer.write(chunk);
                }
                if (transfer.chunks) {
                    // 需要 chunks：降级方案 或 图片预览
                    transfer.chunks.push(chunk);
                }
                
                transfer.received += chunk.byteLength;
                
                // Update Progress (除非暂停)
                if (!isPaused) {
                    const now = Date.now();
                    const elapsed = (now - transfer.startTime) / 1000; // 秒
                    const percent = Math.round((transfer.received / transfer.meta.size) * 100);
                    const speed = elapsed > 0 ? transfer.received / elapsed : 0; // bytes/s
                    const remaining = speed > 0 ? (transfer.meta.size - transfer.received) / speed : 0; // 秒
                    
                    // 每 100ms 更新一次（避免过于频繁）
                    if (now - transfer.lastUpdateTime > 100) {
                        transfer.lastUpdateTime = now;
                        setFileProgress(prev => ({
                            ...prev,
                            [`down-${fileId}`]: {
                                name: transfer.meta.name,
                                type: 'download',
                                percent,
                                speed: formatSpeed(speed),
                                totalSize: formatSize(transfer.meta.size),
                                received: formatSize(transfer.received),
                                remaining: formatTime(remaining)
                            }
                        }));
                    }
                }
                
                // Check completion
                if (transfer.received >= transfer.meta.size) {
                    // 文件接收完成，清除进度条
                    setFileProgress(prev => {
                        const next = { ...prev };
                        delete next[`down-${fileId}`];
                        return next;
                    });
                    // 等待 hash 验证
                    // 验证在 file-done 消息中处理
                }
                break;
            }
        }
    };

    const sendSignal = (type, to, payload) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, to, payload }));
        }
    };

    const sendMessage = () => {
        // 检查是否有消息或文件要发送
        if (!message.trim() && pendingFiles.length === 0) return;
        
        const isPrivate = activeUser !== null;
        
        // 发送文本消息
        if (message.trim()) {
            const msgObj = { 
                text: message, 
                type: 'text',
                mode: isPrivate ? 'private' : 'broadcast'
            };
            
            if (isPrivate) {
                // Private Chat - 检查用户是否在线
                const { dc } = peersRef.current[activeUser] || {};
                const status = connectionStatus[activeUser];
                
                if (!dc || dc.readyState !== 'open') {
                    if (status === 'connecting') {
                        alert(`正在与 ${getDisplayName(activeUser)} 建立连接，请稍候...`);
                    } else {
                        alert(`无法发送消息：${getDisplayName(activeUser)} 未连接。`);
                    }
                    return;
                }
                dc.send(JSON.stringify(msgObj));
                addChat({ from: 'Me', to: activeUser, ...msgObj });
            } else {
                // Global Chat
                const activePeers = Object.keys(peersRef.current).filter(id => {
                    const { dc } = peersRef.current[id];
                    return dc && dc.readyState === 'open';
                });
                
                const connectingPeers = Object.keys(connectionStatus).filter(id => 
                    connectionStatus[id] === 'connecting'
                );
                
                if (activePeers.length === 0) {
                    if (connectingPeers.length > 0) {
                        alert(`正在与 ${connectingPeers.length} 个用户建立连接，请稍候...`);
                    } else {
                        alert('没有活跃连接。请等待其他用户加入。');
                    }
                    return;
                }
                
                activePeers.forEach(id => {
                    peersRef.current[id].dc.send(JSON.stringify(msgObj));
                });
                addChat({ from: 'Me', ...msgObj });
            }
        }
        
        // 发送所有待发送的文件
        pendingFiles.forEach(file => {
            sendFile(file);
        });
        
        // 清空输入
        setMessage("");
        setPendingFiles([]);
    };

    const handlePaste = (e) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    // 添加到待发送列表，而不是直接发送
                    setPendingFiles(prev => [...prev, file]);
                    e.preventDefault();
                }
            }
        }
    };
    
    // 添加文件选择处理
    const handleFileSelect = (file) => {
        setPendingFiles(prev => [...prev, file]);
    };
    
    // 移除待发送的文件
    const removePendingFile = (index) => {
        setPendingFiles(prev => prev.filter((_, i) => i !== index));
    };

    const getInitials = (name) => name ? name.substring(0, 2).toUpperCase() : '??';
    
    const saveNickname = () => {
        if (nickname.trim()) {
            // 广播昵称给所有在线用户
            Object.keys(peersRef.current).forEach(id => {
                sendSignal('nickname', id, { nickname: nickname.trim() });
            });
            setIsEditingNickname(false);
            log(`Nickname changed to "${nickname.trim()}"`);
        }
    };

    // Filter chat history based on activeUser
    const filteredChatHistory = chatHistory.filter(msg => {
        if (activeUser === null) {
            // Global chat: show only broadcast messages
            return msg.mode === 'broadcast' || !msg.mode; // fallback for old messages without mode
        } else {
            // Private chat: show only private messages between me and activeUser
            return (
                msg.mode === 'private' && (
                    (msg.from === 'Me' && msg.to === activeUser) || // My private messages to activeUser
                    (msg.from === activeUser) // Private messages from activeUser to me
                )
            );
        }
    });

    const currentChatName = activeUser === null ? 'Global Chat' : activeUser;

    // 房间选择界面
    if (showRoomInput) {
        return (
            <RoomSelector
                roomInput={roomInput}
                rooms={rooms}
                isPrivate={isPrivate}
                onRoomInputChange={setRoomInput}
                onJoinRoom={joinRoom}
                onPrivateChange={setIsPrivate}
            />
        );
    }

    return (
        <div className="w-full h-screen bg-gray-50">
            <div className="w-full h-full flex relative">
                {/* Left Side: User List */}
                <div className={cn(
                    "w-full md:w-56 lg:w-64 bg-white border-r flex flex-col transition-transform duration-300 z-20",
                    "md:translate-x-0 md:relative",
                    isSidebarOpen ? "translate-x-0 fixed inset-0" : "-translate-x-full fixed md:relative"
                )}>
                    <div className="px-3 sm:px-4 py-3 sm:py-4 border-b">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                <h2 className="font-semibold text-sm">
                                    {onlineUsers.size} Online
                                </h2>
                            </div>
                            <button 
                                className="md:hidden p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                                onClick={() => setIsSidebarOpen(false)}
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
                        {/* Global Chat Option */}
                        <div 
                            key="global-chat" 
                            className={cn(
                                "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer relative",
                                activeUser === null 
                                    ? "bg-gray-900 text-white" 
                                    : unreadCounts['__global__'] > 0
                                        ? "hover:bg-gray-100 text-gray-900 ring-2 ring-green-400 shadow-lg shadow-green-200/50"
                                        : "hover:bg-gray-100 text-gray-900"
                            )}
                            onClick={() => {
                                switchToUser(null);
                                setIsSidebarOpen(false);
                            }}
                        >
                            <div className={cn(
                                "w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0",
                                activeUser === null 
                                    ? "bg-white/10" 
                                    : "bg-gray-100"
                            )}>
                                <Globe className={cn("w-5 h-5", activeUser === null ? "text-white" : "text-gray-600")} />
                            </div>
                            <div className="flex flex-col flex-1 min-w-0">
                                <span className="text-sm font-medium truncate">
                                    Global Chat
                                </span>
                                <span className={cn(
                                    "text-xs",
                                    activeUser === null ? "text-white/70" : "text-gray-500"
                                )}>
                                    Everyone
                                </span>
                            </div>
                            {unreadCounts['__global__'] > 0 && (
                                <div className="flex-shrink-0 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                                    {unreadCounts['__global__']}
                                </div>
                            )}
                        </div>
                        
                        {/* Individual Users */}
                        {[...onlineUsers].map(user => {
                            if (user === myIdRef.current) return null; // Don't show myself in private chat list
                            const displayName = getDisplayName(user);
                            const connInfo = connectionStatus[user] || { status: 'connecting' };
                            const status = connInfo.status || 'connecting';
                            const networkType = connInfo.networkType; // 'lan' or 'wan'
                            const statusConfig = {
                                connecting: { color: '#f59e0b', text: '连接中' },
                                connected: { color: '#10b981', text: networkType === 'lan' ? '🏠局域网' : '🌐公网' },
                                disconnected: { color: '#9ca3af', text: '离线' }
                            };
                            const currentStatus = statusConfig[status];
                            
                            const unreadCount = unreadCounts[user] || 0;
                            
                            return (
                                <div 
                                    key={user} 
                                    className={cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer relative",
                                        activeUser === user 
                                            ? "bg-gray-900 text-white" 
                                            : unreadCount > 0
                                                ? "hover:bg-gray-100 text-gray-900 ring-2 ring-green-400 shadow-lg shadow-green-200/50"
                                                : "hover:bg-gray-100 text-gray-900"
                                    )}
                                    onClick={() => {
                                        switchToUser(user);
                                        setIsSidebarOpen(false);
                                    }}
                                >
                                    <div className="relative flex-shrink-0">
                                        <div className={cn(
                                            "w-9 h-9 rounded-lg flex items-center justify-center font-semibold text-xs",
                                            activeUser === user 
                                                ? "bg-white/10 text-white" 
                                                : "bg-gray-900 text-white"
                                        )}>
                                            {getInitials(displayName)}
                                        </div>
                                        <div 
                                            className={cn(
                                                "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2",
                                                activeUser === user ? "border-gray-900" : "border-white",
                                                status === 'connected' && "bg-green-500",
                                                status === 'connecting' && "bg-amber-500",
                                                status === 'disconnected' && "bg-gray-400"
                                            )}
                                        />
                                    </div>
                                    <div className="flex flex-col flex-1 min-w-0">
                                        <span className="text-sm font-medium truncate">
                                            {displayName}
                                        </span>
                                        <span className={cn(
                                            "text-xs",
                                            activeUser === user ? "text-white/70" : "text-gray-500"
                                        )}>
                                            {currentStatus.text}
                                        </span>
                                    </div>
                                    {unreadCount > 0 && (
                                        <div className="flex-shrink-0 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                                            {unreadCount}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Overlay for mobile sidebar */}
                {isSidebarOpen && (
                    <div 
                        className="fixed inset-0 bg-black/20 z-10 md:hidden"
                        onClick={() => setIsSidebarOpen(false)}
                    />
                )}

                {/* Right Side: Chat */}
                <div className="flex-1 flex flex-col bg-white">
                    {/* Header */}
                    <div className="px-3 sm:px-4 py-2.5 sm:py-3 border-b flex items-center gap-2 sm:gap-3 bg-white">
                        <Button 
                            variant="ghost" 
                            size="icon" 
                            className="md:hidden -ml-2 h-9 w-9"
                            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        >
                            <Menu className="w-5 h-5" />
                        </Button>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-semibold truncate">
                                {activeUser === null ? 'Global Chat' : getDisplayName(activeUser)}
                            </h2>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <Badge variant="secondary" className="text-xs h-5 px-2">
                                    {currentRoom}
                                </Badge>
                                {nickname ? (
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-muted-foreground">
                                            {nickname}
                                        </span>
                                        <Button 
                                            variant="ghost" 
                                            size="icon" 
                                            className="h-5 w-5 p-0 hover:bg-gray-100"
                                            onClick={() => setIsEditingNickname(true)}
                                        >
                                            <Edit2 className="w-3 h-3" />
                                        </Button>
                                    </div>
                                ) : (
                                    <Button 
                                        onClick={() => setIsEditingNickname(true)} 
                                        size="icon"
                                        variant="ghost"
                                        className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground hover:bg-gray-100"
                                        title="设置昵称"
                                    >
                                        <Edit2 className="w-3 h-3" />
                                    </Button>
                                )}
                            </div>
                        </div>
                        <Button 
                            onClick={handleClearHistory}
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 shrink-0"
                            title="清除聊天历史"
                        >
                            <Trash2 className="w-4 h-4" />
                        </Button>
                        <Button 
                            onClick={() => {
                                setShowRoomInput(true);
                                fetchRooms();
                            }}
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs shrink-0"
                        >
                            Switch
                        </Button>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-col gap-3 sm:gap-4 bg-gray-50" ref={chatBoxRef}>
                        {filteredChatHistory.map((c, i) => (
                            <ChatMessage
                                key={i}
                                message={c}
                                displayName={getDisplayName(c.from)}
                                isMine={c.from === 'Me'}
                                onImageClick={setPreviewImage}
                            />
                        ))}
                    </div>
                    
                    {/* File Progress Bars */}
                    {Object.keys(fileProgress).length > 0 && (
                        <div className="px-4 py-3 border-t bg-white">
                            {Object.entries(fileProgress).map(([id, p]) => {
                                // 对于上传进度条，id格式是 up-{fileId}-{targetId}，需要提取 fileId 和 targetId
                                const isUpload = id.startsWith('up-');
                                const parts = id.split('-');
                                const fileId = isUpload ? parts.slice(0, 2).join('-') : id;
                                const targetId = isUpload && parts.length > 2 ? parts[2] : null;
                                const control = transferControlRef.current[fileId];
                                // 检查该目标是否暂停
                                const isPaused = p.type === 'upload' && targetId 
                                    ? control?.subPaused[targetId] 
                                    : control?.paused;
                                
                                // 为单个进度条创建暂停/恢复函数
                                const handlePauseResume = () => {
                                    if (p.type === 'upload' && targetId) {
                                        // 上传：只暂停/恢复该目标
                                        if (control) {
                                            const channel = control.subChannels[targetId];
                                            if (control.subPaused[targetId]) {
                                                // 恢复
                                                control.subPaused[targetId] = false;
                                                // 通知该接收端恢复
                                                if (channel && channel.readyState === 'open') {
                                                    try {
                                                        channel.send(JSON.stringify({
                                                            type: 'resume-transfer-by-sender',
                                                            fileId: parts[1]
                                                        }));
                                                    } catch (e) {
                                                        console.error('Failed to send resume signal:', e);
                                                    }
                                                }
                                                // 主动触发该目标的 sendBatch
                                                const sendBatch = control.subSendBatch[targetId];
                                                if (sendBatch) sendBatch();
                                                log(`恢复发送给 ${getDisplayName(targetId)}`);
                                            } else {
                                                // 暂停
                                                control.subPaused[targetId] = true;
                                                // 通知该接收端暂停
                                                if (channel && channel.readyState === 'open') {
                                                    try {
                                                        channel.send(JSON.stringify({
                                                            type: 'pause-transfer-by-sender',
                                                            fileId: parts[1]
                                                        }));
                                                    } catch (e) {
                                                        console.error('Failed to send pause signal:', e);
                                                    }
                                                }
                                                log(`暂停发送给 ${getDisplayName(targetId)}`);
                                            }
                                            // 强制更新
                                            setFileProgress(prev => ({...prev}));
                                        }
                                    } else {
                                        // 下载或全局暂停/恢复
                                        if (control) {
                                            if (isPaused) {
                                                control.resume();
                                                control.paused = false;
                                            } else {
                                                control.pause();
                                                control.paused = true;
                                            }
                                            setFileProgress(prev => ({...prev}));
                                        }
                                    }
                                };
                                
                                // 为单个进度条创建取消函数
                                const handleCancel = () => {
                                    if (p.type === 'upload' && targetId) {
                                        // 上传：只取消该目标
                                        if (control) {
                                            control.subCancelled[targetId] = true;
                                            // 通知接收端
                                            const channel = control.subChannels[targetId];
                                            if (channel && channel.readyState === 'open') {
                                                try {
                                                    channel.send(JSON.stringify({
                                                        type: 'cancel-transfer',
                                                        fileId: parts[1]
                                                    }));
                                                } catch (e) {
                                                    console.error('Failed to send cancel signal:', e);
                                                }
                                            }
                                            // 删除该进度条
                                            setFileProgress(prev => {
                                                const next = { ...prev };
                                                delete next[id];
                                                return next;
                                            });
                                            log(`已取消发送给 ${getDisplayName(targetId)}`);
                                            
                                            // 检查是否所有目标都已取消
                                            const allCancelled = Object.keys(control.subChannels).every(
                                                id => control.subCancelled[id] === true
                                            );
                                            if (allCancelled) {
                                                log(`所有接收端都已取消`);
                                                delete transferControlRef.current[fileId];
                                                
                                                // 重置发送标志，允许发送新文件
                                                isSendingFileRef.current = false;
                                                
                                                // 继续处理队列中的其他文件
                                                if (fileQueueRef.current.length > 0) {
                                                    setTimeout(() => processFileQueue(), 100);
                                                }
                                            }
                                        }
                                    } else {
                                        // 下载或全局取消
                                        if (control) control.cancel();
                                    }
                                };
                                
                                // 实时获取用户昵称
                                let displayProgress = p;
                                if (p.type === 'upload' && targetId) {
                                    // 发送端：显示接收者昵称
                                    displayProgress = { ...p, targetName: getDisplayName(targetId) };
                                } else if (p.type === 'download') {
                                    // 接收端：查找发送者并显示其昵称
                                    const downloadFileId = id.replace('down-', '');
                                    let senderId = null;
                                    // 在 incomingFilesRef 中查找这个 fileId 对应的 remoteId
                                    for (const [remoteId, files] of Object.entries(incomingFilesRef.current)) {
                                        if (files[downloadFileId]) {
                                            senderId = remoteId;
                                            break;
                                        }
                                    }
                                    if (senderId) {
                                        displayProgress = { ...p, fromName: getDisplayName(senderId) };
                                    }
                                }
                                
                                return (
                                    <FileProgress
                                        key={id}
                                        id={id}
                                        progress={displayProgress}
                                        control={control}
                                        isPaused={isPaused}
                                        onPauseResume={handlePauseResume}
                                        onCancel={handleCancel}
                                    />
                                );
                            })}
                        </div>
                    )}

                    <MessageInput
                        message={message}
                        onMessageChange={setMessage}
                        onSendMessage={sendMessage}
                        onFileSelect={handleFileSelect}
                        onPaste={handlePaste}
                        isComposing={isComposing}
                        onCompositionStart={() => setIsComposing(true)}
                        onCompositionEnd={() => setIsComposing(false)}
                        pendingFiles={pendingFiles}
                        onRemoveFile={removePendingFile}
                    />
                </div>
            </div>

            {/* Image Preview Modal */}
            {previewImage && (
                <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4" onClick={() => setPreviewImage(null)}>
                    <img src={previewImage} alt="Preview" className="max-w-full max-h-full object-contain" />
                </div>
            )}
            
            {/* Nickname Edit Modal */}
            {isEditingNickname && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setIsEditingNickname(false)}>
                    <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <h3 className="text-lg font-semibold mb-4">Set Your Nickname</h3>
                        <Input
                            type="text" 
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveNickname()}
                            placeholder="Enter your nickname..."
                            autoFocus
                            className="mb-4"
                        />
                        <div className="flex gap-2 justify-end">
                            <Button 
                                onClick={() => setIsEditingNickname(false)} 
                                variant="outline"
                                size="sm"
                            >
                                Cancel
                            </Button>
                            <Button onClick={saveNickname} size="sm">
                                Save
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary>
            <ChatApp />
        </ErrorBoundary>
    );
}
