import { useState, useEffect, useRef, Component } from 'react';
import './App.css';
import CryptoJS from 'crypto-js';
import { formatSize, formatTime, formatSpeed, generateId } from './utils/formatters';
import { isImageFile, isModernFileAPISupported } from './utils/fileUtils';
import { ICE_SERVERS, FILE_TRANSFER_CONFIG, MESSAGE_TYPES, CHAT_MODES } from './constants/config';
import { useRoom } from './hooks/useRoom';
import { RoomSelector } from './components/RoomSelector';

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
        <div style={{ padding: 20, color: 'red' }}>
          <h2>Something went wrong.</h2>
          <pre>{this.state.error && this.state.error.toString()}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ICE Servers 已从 constants/config.js 导入

function ChatApp() {
    const [logs, setLogs] = useState([]);
    const [message, setMessage] = useState("");
    const [isComposing, setIsComposing] = useState(false); // 输入法输入状态
    const [chatHistory, setChatHistory] = useState([]);
    const [onlineUsers, setOnlineUsers] = useState(new Set());
    const [previewImage, setPreviewImage] = useState(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [fileProgress, setFileProgress] = useState({}); // { id: { name, type: 'upload'|'download', percent } }
    const [activeUser, setActiveUser] = useState(null); // null = Global Chat, string = Private Chat User ID
    const [isEditingNickname, setIsEditingNickname] = useState(false);
    const [nickname, setNickname] = useState(() => localStorage.getItem('nickname') || '');
    const [userNicknames, setUserNicknames] = useState({}); // id -> nickname mapping
    const isModernAPISupported = isModernFileAPISupported();
    
    // 房间管理 Hook
    const {
        currentRoom,
        showRoomInput,
        roomInput,
        rooms,
        localNetworkRooms,
        myICECandidatesRef,
        setCurrentRoom,
        setShowRoomInput,
        setRoomInput,
        fetchRooms,
        detectLocalNetworkRooms
    } = useRoom();
    
    // 存储 Blob URLs 用于清理
    const blobUrlsRef = useRef(new Set());
    
    const chatBoxRef = useRef(null);
    
    // Auto-scroll to bottom
    useEffect(() => {
        if (chatBoxRef.current) {
            chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
        }
    }, [chatHistory]);
    
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
    
    // 保存昵称到 localStorage
    useEffect(() => {
        if (nickname) {
            localStorage.setItem('nickname', nickname);
        }
    }, [nickname]);
    const peersRef = useRef({}); // id -> {pc, dc}
    const incomingFilesRef = useRef({}); // remoteId -> { fileId: { meta, received: 0, chunks: [] } }
    const fileQueueRef = useRef([]); // 文件发送队列
    const isSendingFileRef = useRef(false); // 是否正在发送文件
    const eventQueueRef = useRef({}); // remoteId -> EventQueue
    const transferControlRef = useRef({}); // fileId -> { paused, cancelled, cancel() }

    const log = (msg) => setLogs(prev => [...prev, msg]);
    const addChat = (msg) => setChatHistory(prev => [...prev, msg]);

    const updateOnlineUsers = (action, userId, list = null) => {
        setOnlineUsers(prev => {
            let newSet;
            try {
                 newSet = new Set(prev);
            } catch(e) {
                 newSet = new Set();
            }
            
            if (action === 'add') {
                if (userId) newSet.add(userId);
            } else if (action === 'remove') {
                if (userId) newSet.delete(userId);
            } else if (action === 'set') {
                if (Array.isArray(list)) return new Set(list);
            }
            return newSet;
        });
    };

    useEffect(() => {
        // 如果有上次的房间，自动加入
        if (currentRoom) {
            joinRoom(currentRoom);
        } else {
            setShowRoomInput(true);
            fetchRooms(); // 获取房间列表
        }

        return () => {
            // 清理 WebSocket
            if (wsRef.current) wsRef.current.close();
            
            // 清理所有 PeerConnections
            Object.keys(peersRef.current).forEach(id => {
                const peer = peersRef.current[id];
                if (peer.dc) peer.dc.close();
                if (peer.pc) peer.pc.close();
            });
            
            // 清理所有 Blob URLs
            blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
            blobUrlsRef.current.clear();
        }
    }, []);
    
    const joinRoom = (roomId) => {
        if (!roomId.trim()) return;
        
        // 清理旧连接
        if (wsRef.current) wsRef.current.close();
        Object.keys(peersRef.current).forEach(id => {
            const peer = peersRef.current[id];
            if (peer.dc) peer.dc.close();
            if (peer.pc) peer.pc.close();
        });
        peersRef.current = {};
        
        // 重置状态
        setChatHistory([]);
        setOnlineUsers(new Set([myIdRef.current]));
        setCurrentRoom(roomId);
        setShowRoomInput(false);
        localStorage.setItem('lastRoom', roomId);
        
        // 连接到新房间
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws?id=${myIdRef.current}&room=${encodeURIComponent(roomId)}`;
        connectWs(wsUrl);
        log(`Joined room: ${roomId}`);
    };

    const connectWs = (url) => {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            log("Connected to Signaling Server");
        };

        ws.onmessage = async (evt) => {
            const msg = JSON.parse(evt.data);
            handleSignalMessage(msg);
        };
        
        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        
        ws.onclose = () => {
            log("Disconnected from server. Reconnecting...");
            // 3秒后尝试重连
            setTimeout(() => {
                if (wsRef.current === ws) { // 确保不是手动关闭
                    connectWs(url);
                }
            }, 3000);
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
                // 清理该用户的事件队列
                delete eventQueueRef.current[from];
                // 清理该用户的文件传输状态
                delete incomingFilesRef.current[from];
                // 如果正在与该用户私聊，切回全局聊天
                if (activeUser === from) {
                    setActiveUser(null);
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
                        
                        // 关闭 writer
                        if (transfer.writer) {
                            await transfer.writer.close();
                        }
                        
                        // 创建 Blob URL（图片总是需要预览，非图片则根据 API 支持情况）
                        if (transfer.chunks) {
                            const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                            fileUrl = URL.createObjectURL(blob);
                            blobUrlsRef.current.add(fileUrl);
                        } else if (isImage) {
                            // 现代 API 下的图片：需要显示提示，因为没有 chunks
                            fileUrl = 'file-saved-to-disk';
                        } else {
                            // 现代 API 下的非图片：显示已保存提示
                            fileUrl = 'file-saved-to-disk';
                        }
                        
                        // 添加到聊天记录
                        const fileMsg = {
                            type: 'file',
                            name: transfer.meta.name,
                            data: fileUrl,
                            mode: transfer.meta.mode || 'broadcast',
                            savedToDisk: transfer.writer !== null
                        };
                        addChat({ from, ...fileMsg });
                        
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

        dc.onopen = () => log(`Connected to ${remoteId}`);
        
        dc.onclose = () => {
            log(`DataChannel closed with ${remoteId}`);
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
    
    // 统一的初始化文件接收函数
    const initFileReceive = async (remoteId, fileMeta) => {
        if (!incomingFilesRef.current[remoteId]) {
            incomingFilesRef.current[remoteId] = {};
        }
        
        const isImage = isImageFile(fileMeta.name, fileMeta.fileType);
        
        // 创建传输状态对象
        incomingFilesRef.current[remoteId][fileMeta.fileId] = {
            meta: fileMeta,
            received: 0,
            chunks: (isModernAPISupported && !isImage) ? null : [],
            totalChunks: fileMeta.totalChunks,
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            hasher: CryptoJS.algo.MD5.create(),
            fileHandle: null,
            writer: null
        };
        
        // 创建下载控制对象
        const fileId = fileMeta.fileId;
        transferControlRef.current[`down-${fileId}`] = {
            cancelled: false,
            paused: false,
            pause: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (ctrl) {
                    ctrl.paused = true;
                    // 通知发送端暂停
                    const peer = peersRef.current[remoteId];
                    if (peer?.dc && peer.dc.readyState === 'open') {
                        try {
                            peer.dc.send(JSON.stringify({
                                type: 'pause-transfer-by-receiver',
                                fileId: fileId,
                                receiverId: myIdRef.current
                            }));
                            log(`通知发送端暂停: ${fileId}`);
                        } catch (e) {
                            console.error('Failed to send pause signal:', e);
                        }
                    }
                }
            },
            resume: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (ctrl) {
                    ctrl.paused = false;
                    // 通知发送端恢复
                    const peer = peersRef.current[remoteId];
                    if (peer?.dc && peer.dc.readyState === 'open') {
                        try {
                            peer.dc.send(JSON.stringify({
                                type: 'resume-transfer-by-receiver',
                                fileId: fileId,
                                receiverId: myIdRef.current
                            }));
                            log(`通知发送端恢复: ${fileId}`);
                        } catch (e) {
                            console.error('Failed to send resume signal:', e);
                        }
                    }
                }
            },
            cancel: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (!ctrl) return;
                
                ctrl.cancelled = true;
                delete incomingFilesRef.current[remoteId]?.[fileId];
                setFileProgress(prev => {
                    const next = { ...prev };
                    delete next[`down-${fileId}`];
                    return next;
                });
                delete transferControlRef.current[`down-${fileId}`];
                
                // 发送取消信号给发送方（包含接收端自己的ID）
                const peer = peersRef.current[remoteId];
                if (peer?.dc && peer.dc.readyState === 'open') {
                    try {
                        peer.dc.send(JSON.stringify({
                            type: 'cancel-transfer-by-receiver',
                            fileId: fileId,
                            receiverId: myIdRef.current
                        }));
                    } catch (e) {
                        console.error('Failed to send cancel signal:', e);
                    }
                }
                log(`已取消接收: ${fileMeta.name}`);
            }
        };
        
        // 如果支持现代 API 且不是图片，让用户选择保存位置
        if (isModernAPISupported && !isImage) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: fileMeta.name,
                    types: [{
                        description: 'All Files',
                        accept: { '*/*': [] }
                    }]
                });
                const writer = await fileHandle.createWritable();
                incomingFilesRef.current[remoteId][fileId].fileHandle = fileHandle;
                incomingFilesRef.current[remoteId][fileId].writer = writer;
            } catch (err) {
                if (err.name === 'AbortError') {
                    // 用户取消
                    transferControlRef.current[`down-${fileId}`]?.cancel();
                    return false;
                }
                console.error('FileSystem API error:', err);
            }
        }
        
        log(`开始接收: ${fileMeta.name} (${formatSize(fileMeta.size)})`);
        return true;
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
                        
                        // 关闭 writer
                        if (transfer.writer) {
                            await transfer.writer.close();
                        }
                        
                        // 创建 Blob URL（图片总是需要预览，非图片则根据 API 支持情况）
                        if (transfer.chunks) {
                            const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                            fileUrl = URL.createObjectURL(blob);
                            blobUrlsRef.current.add(fileUrl);
                        } else if (isImage) {
                            // 现代 API 下的图片：需要显示提示，因为没有 chunks
                            fileUrl = 'file-saved-to-disk';
                        } else {
                            // 现代 API 下的非图片：显示已保存提示
                            fileUrl = 'file-saved-to-disk';
                        }
                        
                        // 添加到聊天记录
                        const fileMsg = {
                            type: 'file',
                            name: transfer.meta.name,
                            data: fileUrl,
                            mode: transfer.meta.mode || 'broadcast',
                            savedToDisk: transfer.writer !== null
                        };
                        addChat({ from: remoteId, ...fileMsg });
                        
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
        if (!message.trim()) return;
        
        const isPrivate = activeUser !== null;
        const msgObj = { 
            text: message, 
            type: 'text',
            mode: isPrivate ? 'private' : 'broadcast'
        };
        
        if (isPrivate) {
            // Private Chat - 检查用户是否在线
            const { dc } = peersRef.current[activeUser] || {};
            if (!dc || dc.readyState !== 'open') {
                alert(`Cannot send message: ${activeUser} is offline or not connected.`);
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
            
            if (activePeers.length === 0) {
                alert('No active connections. Wait for other users to join.');
                return;
            }
            
            activePeers.forEach(id => {
                peersRef.current[id].dc.send(JSON.stringify(msgObj));
            });
            addChat({ from: 'Me', ...msgObj });
        }
        
        setMessage("");
    };

    const sendFile = async (file) => {
         if (file.size > 2 * 1024 * 1024 * 1024) {
             alert("File too large (max 2GB)");
             return;
         }
         
         // 添加到队列
         fileQueueRef.current.push(file);
         
         // 如果没有正在发送的文件，开始处理队列
         if (!isSendingFileRef.current) {
             processFileQueue();
         }
    };
    
    const processFileQueue = async () => {
         if (isSendingFileRef.current || fileQueueRef.current.length === 0) {
             return;
         }
         
         isSendingFileRef.current = true;
         const file = fileQueueRef.current.shift();
         
         await sendFileActual(file);
         
         isSendingFileRef.current = false;
         
         // 继续处理下一个文件
         if (fileQueueRef.current.length > 0) {
             setTimeout(() => processFileQueue(), 100);
         }
    };
    
    const sendFileActual = async (file) => {
         const fileId = Math.random().toString(36).substr(2, 9);
         const isPrivate = activeUser !== null;
         const chunkSize = 32 * 1024; // 32KB
         const totalChunks = Math.ceil(file.size / chunkSize);
         
         const meta = {
             type: 'file-start',
             fileId,
             name: file.name,
             size: file.size,
             fileType: file.type,
             mode: isPrivate ? 'private' : 'broadcast',
             totalChunks
         };
         
         // 创建 MD5 hasher
         const hasher = CryptoJS.algo.MD5.create();
         
         // 获取目标 DataChannel(s)
         const targetDCs = [];
         const targetIds = [];
         if (isPrivate) {
             const { dc } = peersRef.current[activeUser] || {};
             if (dc && dc.readyState === 'open') {
                 targetDCs.push(dc);
                 targetIds.push(activeUser);
             }
         } else {
             Object.keys(peersRef.current).forEach(id => {
                const { dc } = peersRef.current[id];
                if (dc && dc.readyState === 'open') {
                    targetDCs.push(dc);
                    targetIds.push(id);
                }
             });
         }
         
         if (targetDCs.length === 0) {
             alert("No active connections");
             return;
         }
         
         // Send Meta
         targetDCs.forEach(dc => dc.send(JSON.stringify(meta)));
         
         // Read file
         const arrayBuffer = await file.arrayBuffer();
         
         // 计算 hash
         for (let i = 0; i < totalChunks; i++) {
             const start = i * chunkSize;
             const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
             const chunk = arrayBuffer.slice(start, end);
             hasher.update(CryptoJS.lib.WordArray.create(chunk));
         }
         const hash = hasher.finalize().toString(CryptoJS.enc.Base64);
         
         // 为每个目标创建独立的进度条
        targetIds.forEach(targetId => {
            const displayName = getDisplayName(targetId);
            setFileProgress(prev => ({
                ...prev,
                [`up-${fileId}-${targetId}`]: {
                    name: file.name,
                    type: 'upload',
                    percent: 0,
                    speed: 0,
                    remaining: '...',
                    targetId: targetId,
                    targetName: displayName
                }
            }));
        });
         
         // 使用 bufferedamountlow 事件驱动发送
        await Promise.all(targetDCs.map((dc, idx) => 
            sendFileToChannel(dc, arrayBuffer, fileId, targetIds[idx], file.name, totalChunks, chunkSize)
        ));
         
         // 发送完成消息和 hash
         targetDCs.forEach(dc => {
             dc.send(JSON.stringify({
                 type: 'file-done',
                 fileId,
                 hash
             }));
         });
         
         // Clear Progress - 删除所有该文件的进度条
        setFileProgress(prev => {
            const next = { ...prev };
            targetIds.forEach(targetId => {
                delete next[`up-${fileId}-${targetId}`];
            });
            return next;
        });
         
         log(`✅ File sent & verified: ${file.name}`);
         
         // 添加到自己的聊天记录
         addFileSelfToChat(file, arrayBuffer, isPrivate);
    };
    
    const sendFileToChannel = (dc, arrayBuffer, fileId, targetId, fileName, totalChunks, chunkSize) => {
        return new Promise((resolve, reject) => {
            let offset = 0;
            const startTime = Date.now();
            let lastUpdateTime = Date.now();
            let paused = false;
            let cancelled = false;
            
            // 创建或更新控制对象（只创建一次）
            if (!transferControlRef.current[`up-${fileId}`]) {
                transferControlRef.current[`up-${fileId}`] = {
                    paused: false,
                    cancelled: false,
                    subPaused: {},
                    subCancelled: {},
                    subChannels: {}, // 存储每个目标的 dc 引用
                    subSendBatch: {}, // 存储每个目标的 sendBatch 函数
                    pause: () => { 
                        transferControlRef.current[`up-${fileId}`].paused = true;
                        Object.keys(transferControlRef.current[`up-${fileId}`].subPaused).forEach(id => {
                            transferControlRef.current[`up-${fileId}`].subPaused[id] = true;
                        });
                        // 注意：不通知接收端，因为每个进度条独立控制
                    },
                    resume: () => { 
                        transferControlRef.current[`up-${fileId}`].paused = false;
                        Object.keys(transferControlRef.current[`up-${fileId}`].subPaused).forEach(id => {
                            transferControlRef.current[`up-${fileId}`].subPaused[id] = false;
                        });
                        // 主动触发所有 sendBatch 以恢复发送
                        Object.values(transferControlRef.current[`up-${fileId}`].subSendBatch).forEach(fn => {
                            if (fn) fn();
                        });
                        // 注意：不通知接收端，因为每个进度条独立控制
                    },
                    cancel: () => {
                        const ctrl = transferControlRef.current[`up-${fileId}`];
                        if (!ctrl) return;
                        
                        // 设置取消标志
                        ctrl.cancelled = true;
                        Object.keys(ctrl.subCancelled).forEach(id => {
                            ctrl.subCancelled[id] = true;
                        });
                        
                        // 移除所有 DataChannel 的事件监听器
                        Object.entries(ctrl.subChannels).forEach(([id, channel]) => {
                            if (channel) {
                                channel.onbufferedamountlow = null;
                                // 通知接收端取消
                                if (channel.readyState === 'open') {
                                    try {
                                        channel.send(JSON.stringify({
                                            type: 'cancel-transfer',
                                            fileId: fileId
                                        }));
                                    } catch (e) {
                                        console.error('Failed to send cancel signal:', e);
                                    }
                                }
                            }
                        });
                        
                        // 清理所有该文件的进度条
                        setFileProgress(prev => {
                            const next = { ...prev };
                            Object.keys(prev).forEach(key => {
                                if (key.startsWith(`up-${fileId}-`)) {
                                    delete next[key];
                                }
                            });
                            return next;
                        });
                        
                        // 删除控制对象
                        delete transferControlRef.current[`up-${fileId}`];
                        
                        // 重置发送标志，允许发送新文件
                        isSendingFileRef.current = false;
                        
                        // 继续处理队列中的其他文件
                        if (fileQueueRef.current.length > 0) {
                            setTimeout(() => processFileQueue(), 100);
                        }
                        
                        log(`已取消发送`);
                    }
                };
            }
            
            // 为这个目标注册子控制
            transferControlRef.current[`up-${fileId}`].subPaused[targetId] = false;
            transferControlRef.current[`up-${fileId}`].subCancelled[targetId] = false;
            transferControlRef.current[`up-${fileId}`].subChannels[targetId] = dc;
            
            const sendBatch = () => {
                // 检查控制对象是否还存在
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) {
                    dc.onbufferedamountlow = null;
                    return; // 已被清理，静默退出
                }
                
                // 检查是否被取消
                if (ctrl.subCancelled[targetId]) {
                    dc.onbufferedamountlow = null;
                    return; // 已取消，静默退出
                }
                
                // 检查是否被暂停
                if (ctrl.subPaused[targetId]) {
                    return; // 暂停中，等待恢复
                }
                
                // 动态调整阈值
                if (totalChunks - offset > 16) {
                    dc.bufferedAmountLowThreshold = 16 * chunkSize; // 512KB
                } else {
                    dc.bufferedAmountLowThreshold = 0;
                }
                
                // 批量发送 32 个 chunk
                for (let i = 0; i < 32 && offset < totalChunks; i++) {
                    const start = offset * chunkSize;
                    const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
                    const chunk = arrayBuffer.slice(start, end);
                    
                    dc.send(chunk); // 直接发送 ArrayBuffer！
                    offset++;
                    
                    // 计算该目标的独立进度
                    const now = Date.now();
                    const percent = Math.round((offset / totalChunks) * 100);
                    const sent = offset * chunkSize;
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? sent / elapsed : 0;
                    const remaining = speed > 0 ? (arrayBuffer.byteLength - sent) / speed : 0;
                    
                    // 每 100ms 更新一次进度
                    if (now - lastUpdateTime > 100 || offset >= totalChunks) {
                        lastUpdateTime = now;
                        const progressKey = `up-${fileId}-${targetId}`;
                        setFileProgress(prev => {
                            if (!prev[progressKey]) return prev; // 已被取消
                            return {
                                ...prev,
                                [progressKey]: {
                                    ...prev[progressKey],
                                    percent,
                                    speed: formatSpeed(speed),
                                    remaining: formatTime(remaining)
                                }
                            };
                        });
                    }
                    
                    if (offset >= totalChunks) {
                        // 该目标传输完成
                        dc.onbufferedamountlow = null;
                        
                        // 清理该目标的控制引用
                        const ctrl = transferControlRef.current[`up-${fileId}`];
                        if (ctrl) {
                            delete ctrl.subPaused[targetId];
                            delete ctrl.subCancelled[targetId];
                            delete ctrl.subChannels[targetId];
                            delete ctrl.subSendBatch[targetId];
                        }
                        
                        resolve();
                        return;
                    }
                }
            };
            
            // 存储 sendBatch 函数引用
            const ctrl = transferControlRef.current[`up-${fileId}`];
            if (ctrl) {
                ctrl.subSendBatch[targetId] = sendBatch;
            }
            
            // 设置事件监听
            dc.onbufferedamountlow = sendBatch;
            
            // 开始发送
            sendBatch();
        });
    };
    
    const addFileSelfToChat = (file, arrayBuffer, isPrivate) => {
         // Add to chat (Me)
         const blob = new Blob([arrayBuffer], { type: file.type });
         const url = URL.createObjectURL(blob);
         
         // 记录 Blob URL 用于后续清理
         blobUrlsRef.current.add(url);
         
         const msgObj = { 
             type: 'file', 
             name: file.name, 
             data: url,
             mode: isPrivate ? 'private' : 'broadcast'
         };
         
         if (isPrivate) {
             addChat({ from: 'Me', to: activeUser, ...msgObj });
         } else {
             addChat({ from: 'Me', ...msgObj });
         }
    };

    const handlePaste = (e) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    sendFile(file);
                    e.preventDefault();
                }
            }
        }
    };

    // formatSize, formatSpeed, formatTime 已从 utils/formatters.js 导入
    
    const getInitials = (name) => name ? name.substring(0, 2).toUpperCase() : '??';
    
    const getDisplayName = (userId) => {
        if (userId === myIdRef.current) return nickname || myIdRef.current;
        return userNicknames[userId] || userId;
    };
    
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
                localNetworkRooms={localNetworkRooms}
                onRoomInputChange={setRoomInput}
                onJoinRoom={joinRoom}
            />
        );
    }

    return (
        <div id="app">
            <div className="main-layout">
                {/* Left Side: User List */}
                <div className={`user-list-container ${isSidebarOpen ? 'open' : ''}`}>
                    <div className="user-list-header">
                        Online Users ({onlineUsers.size})
                    </div>
                    <div className="user-list-content">
                        {/* Global Chat Option */}
                        <div 
                            key="global-chat" 
                            className={`user-item ${activeUser === null ? 'me' : ''}`}
                            onClick={() => {
                                setActiveUser(null);
                                setIsSidebarOpen(false);
                            }}
                            style={{cursor: 'pointer'}}
                        >
                            <div className="avatar">🌐</div>
                            <div className="user-info">
                                <span className="user-name">Global Chat</span>
                                <div className="user-status">
                                    <div className="status-dot" style={{backgroundColor: '#60a5fa'}}></div> Everyone
                                </div>
                            </div>
                        </div>
                        
                        {/* Individual Users */}
                        {[...onlineUsers].map(user => {
                            if (user === myIdRef.current) return null; // Don't show myself in private chat list
                            const displayName = getDisplayName(user);
                            return (
                                <div 
                                    key={user} 
                                    className={`user-item ${activeUser === user ? 'me' : ''}`}
                                    onClick={() => {
                                        setActiveUser(user);
                                        setIsSidebarOpen(false);
                                    }}
                                    style={{cursor: 'pointer'}}
                                >
                                    <div className="avatar">{getInitials(displayName)}</div>
                                    <div className="user-info">
                                        <span className="user-name">{displayName}</span>
                                        <div className="user-status">
                                            <div className="status-dot"></div> Online
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Overlay for mobile sidebar */}
                {isSidebarOpen && (
                    <div 
                        className="modal-overlay" 
                        style={{zIndex: 9}}
                        onClick={() => setIsSidebarOpen(false)}
                    />
                )}

                {/* Right Side: Chat */}
                <div className="chat-container">
                    <div className="chat-header">
                        <button className="mobile-menu-btn" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                            ☰
                        </button>
                        <div style={{flex: 1}}>
                            <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px'}}>
                                <h2 style={{margin: 0}}>{activeUser === null ? 'Global Chat' : getDisplayName(activeUser)}</h2>
                                <div style={{background: '#f3f4f6', padding: '4px 12px', borderRadius: '12px', fontSize: '0.85em', color: '#6b7280', fontWeight: '600'}}>
                                    🏠 {currentRoom}
                                </div>
                                <button 
                                    onClick={() => {
                                        setShowRoomInput(true);
                                        fetchRooms();
                                    }}
                                    style={{background: '#4f46e5', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', fontSize: '0.85em', fontWeight: '500'}}
                                    title="切换房间"
                                >
                                    切换
                                </button>
                            </div>
                            <div style={{fontSize: '0.8em', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '8px'}}>
                                {nickname ? (
                                    <span>You: {nickname} <button onClick={() => setIsEditingNickname(true)} style={{background:'none', border:'none', cursor:'pointer', fontSize:'1em'}}>✏️</button></span>
                                ) : (
                                    <button onClick={() => setIsEditingNickname(true)} style={{background:'#4f46e5', color:'white', border:'none', borderRadius:'4px', padding:'2px 8px', cursor:'pointer', fontSize:'0.9em'}}>Set Nickname</button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="chat-box" ref={chatBoxRef}>
                        {filteredChatHistory.map((c, i) => (
                            <div key={i} className={`message ${c.from === 'Me' ? 'mine' : 'others'}`}>
                                <div className="message-sender">{c.from === 'Me' ? 'You' : getDisplayName(c.from)}</div>
                                <div className="message-content">
                                    {c.type === 'text' ? (
                                        <span>{c.text}</span>
                                    ) : (
                                        <div>
                                            {c.savedToDisk ? (
                                                // 文件已保存到磁盘（现代 API）
                                                <div className="message-file" style={{padding:'10px', background:'#f0fdf4', border:'1px solid #86efac', borderRadius:'8px'}}>
                                                    ✅ {c.name} 
                                                    <div style={{fontSize:'0.85em', color:'#16a34a', marginTop:'4px'}}>
                                                        File saved to your selected location
                                                    </div>
                                                </div>
                                            ) : c.data && (c.data.startsWith('data:image') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(c.name)) ? (
                                                <img 
                                                    src={c.data} 
                                                    alt={c.name} 
                                                    className="message-image"
                                                    onClick={() => setPreviewImage(c.data)}
                                                />
                                            ) : c.data ? (
                                                <a href={c.data} download={c.name} className="message-file">
                                                    📄 {c.name} <span style={{fontSize:'0.8em', opacity:0.7}}>Download</span>
                                                </a>
                                            ) : (
                                                <div className="message-file">
                                                    📄 {c.name}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {/* File Progress Bars */}
                    {Object.keys(fileProgress).length > 0 && (
                        <div style={{padding: '10px 20px', background: '#f9fafb', borderTop: '1px solid #e5e7eb'}}>
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
                                                log(`恢复发送给 ${p.targetName || targetId}`);
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
                                                log(`暂停发送给 ${p.targetName || targetId}`);
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
                                            log(`已取消发送给 ${p.targetName || targetId}`);
                                            
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
                                
                                return (
                                <div key={id} style={{marginBottom: 10, fontSize: '0.85em'}}>
                                    <div style={{display:'flex', justifyContent:'space-between', alignItems: 'center', marginBottom:2}}>
                                        <div style={{flex: 1}}>
                                            <span style={{fontWeight: 500}}>{p.type === 'upload' ? '⬆️ 发送' : '⬇️ 接收'}: {p.name}</span>
                                            {p.type === 'upload' && p.targetName && (
                                                <span style={{marginLeft: '8px', padding: '2px 6px', background: '#e0e7ff', color: '#4f46e5', borderRadius: '4px', fontSize: '0.85em', fontWeight: '600'}}>
                                                    → {p.targetName}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{display: 'flex', gap: '4px', alignItems: 'center'}}>
                                            {control && (
                                                <button 
                                                    onClick={handlePauseResume}
                                                    style={{padding: '2px 8px', fontSize: '0.85em', cursor: 'pointer', border: '1px solid #d1d5db', borderRadius: '4px', background: 'white'}}
                                                >
                                                    {isPaused ? '▶️' : '⏸️'}
                                                </button>
                                            )}
                                            {control && (
                                                <button 
                                                    onClick={handleCancel}
                                                    style={{padding: '2px 8px', fontSize: '0.85em', cursor: 'pointer', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '4px', background: 'white'}}
                                                >
                                                    ✕
                                                </button>
                                            )}
                                            <span style={{fontWeight: 600, color: isPaused ? '#f59e0b' : '#4f46e5', marginLeft: '4px'}}>
                                                {isPaused ? '⏸ 已暂停' : `${p.percent}%`}
                                            </span>
                                        </div>
                                    </div>
                                    <div style={{display:'flex', justifyContent:'space-between', marginBottom:4, fontSize: '0.9em', color: '#6b7280'}}>
                                        <span>
                                            {p.type === 'upload' ? p.sent : p.received} / {p.totalSize}
                                        </span>
                                        <span>
                                            {isPaused ? '暂停中' : `${p.speed} · 剩余 ${p.remaining}`}
                                        </span>
                                    </div>
                                    <div style={{height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden'}}>
                                        <div style={{width: `${p.percent}%`, height: '100%', background: isPaused ? '#f59e0b' : 'linear-gradient(90deg, #4f46e5, #7c3aed)', transition: 'width 0.3s'}}></div>
                                    </div>
                                </div>
                            );})}
                        </div>
                    )}

                    <div className="input-area">
                        <input 
                            type="file" 
                            id="fileInput" 
                            style={{display:'none'}} 
                            onChange={e => {
                                if (e.target.files[0]) {
                                    sendFile(e.target.files[0]);
                                    // 重置文件输入框，允许重复选择同一文件
                                    e.target.value = '';
                                }
                            }}
                        />
                        <button onClick={() => document.getElementById('fileInput').click()} className="btn-icon" title="Send File">
                           📎
                        </button>
                        
                        <div className="input-wrapper">
                            <input 
                                type="text" 
                                value={message} 
                                onChange={e => setMessage(e.target.value)} 
                                onKeyDown={e => {
                                    // 只在非输入法状态下按 Enter 且消息不为空时发送
                                    if (e.key === 'Enter' && !isComposing && message.trim()) {
                                        e.preventDefault();
                                        sendMessage();
                                    }
                                }}
                                onCompositionStart={() => setIsComposing(true)}
                                onCompositionEnd={() => setIsComposing(false)}
                                onPaste={handlePaste}
                                placeholder="Type a message..."
                            />
                        </div>
                        
                        <button onClick={sendMessage} className="btn-send">Send</button>
                    </div>
                </div>
            </div>

            {/* Image Preview Modal */}
            {previewImage && (
                <div className="modal-overlay" onClick={() => setPreviewImage(null)}>
                    <div className="modal-content">
                        <img src={previewImage} alt="Preview" />
                    </div>
                </div>
            )}
            
            {/* Nickname Edit Modal */}
            {isEditingNickname && (
                <div className="modal-overlay" onClick={() => setIsEditingNickname(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{maxWidth: '400px', padding: '24px', background: 'white', borderRadius: '12px'}}>
                        <h3 style={{marginTop: 0}}>Set Your Nickname</h3>
                        <input 
                            type="text" 
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveNickname()}
                            placeholder="Enter your nickname..."
                            autoFocus
                            style={{width: '100%', padding: '10px', fontSize: '1em', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px'}}
                        />
                        <div style={{display: 'flex', gap: '8px', justifyContent: 'flex-end'}}>
                            <button onClick={() => setIsEditingNickname(false)} style={{padding: '8px 16px', border: '1px solid #d1d5db', background: 'white', borderRadius: '6px', cursor: 'pointer'}}>Cancel</button>
                            <button onClick={saveNickname} style={{padding: '8px 16px', border: 'none', background: '#4f46e5', color: 'white', borderRadius: '6px', cursor: 'pointer'}}>Save</button>
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
