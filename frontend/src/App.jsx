import React, { useState, useEffect, useRef, useCallback, Component } from 'react';
import { ICE_SERVERS, fetchIceConfig, fetchSession } from './constants/config';
import { useRoom } from './hooks/useRoom';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useChatHistory } from './hooks/useChatHistory';
import { useDiagnostics } from './hooks/useDiagnostics';
import { usePeerRuntime, PEER_CHANNEL_STATUS, WS_STATUS } from './hooks/usePeerRuntime';
import { RoomSelector } from './components/RoomSelector';
import FileProgress from './components/FileProgress';
import MessageInput from './components/MessageInput';
import ChatMessage from './components/ChatMessage';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Badge } from './components/ui/badge';
import { Menu, Globe, Edit2, X, Trash2, Upload, Video, Phone, FolderOpen } from 'lucide-react';
import { useVideoCall, CALL_STATUS } from './hooks/useVideoCall';
import { IncomingCallModal, CallingModal, VideoCallWindow } from './components/VideoCall';
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
    // Refs for mutable objects
    const [myId, setMyId] = useState('');
    const myIdRef = useRef('');
    myIdRef.current = myId;

    const [logs, setLogs] = useState([]);
    const [message, setMessage] = useState("");
    const [isComposing, setIsComposing] = useState(false); // 输入法输入状态
    const [chatHistory, setChatHistory] = useState([]);
    const [pendingFiles, setPendingFiles] = useState([]); // 待发送的文件列表
    const [onlineUsers, setOnlineUsers] = useState(new Set());
    const [previewImage, setPreviewImage] = useState(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [activeUser, setActiveUser] = useState(null); // null = Global Chat, string = Private Chat User ID
    const activeUserRef = useRef(null); // Ref version of activeUser for callbacks
    const [isEditingNickname, setIsEditingNickname] = useState(false);
    const [nickname, setNickname] = useState(() => localStorage.getItem('nickname') || '');
    const nicknameRef = useRef(localStorage.getItem('nickname') || '');
    const [userNicknames, setUserNicknames] = useState({}); // id -> nickname mapping
    const [isPrivate, setIsPrivate] = useState(false); // 是否创建私有房间
    const [unreadCounts, setUnreadCounts] = useState({}); // 未读消息计数 { userId: count }
    const [lastReadTime, setLastReadTime] = useState({}); // 记录每个聊天窗口的最后已读时间 { chatKey: timestamp }
    const [sessionReady, setSessionReady] = useState(false);
    const [sessionError, setSessionError] = useState('');
    const [rtcConfig, setRtcConfig] = useState(ICE_SERVERS);
    const currentRoomRef = useRef(localStorage.getItem('lastRoom') || '');
    const connectionStatusRef = useRef({});
    const wsStatusRef = useRef(WS_STATUS.DISCONNECTED);
    const rtcConfigRef = useRef(ICE_SERVERS);
    const onlineUsersRef = useRef(new Set());
    const sessionRefreshPromiseRef = useRef(null);
    
    const peersRef = useRef({}); // id -> { pc, dc, chatDc, fileDc }
    const peerInstanceCounterRef = useRef(0);
    const eventQueueRef = useRef({}); // remoteId -> EventQueue
    const connectionTimeoutRef = useRef({}); // remoteId -> timeout handle
    const pendingIceCandidatesRef = useRef({}); // remoteId -> RTCIceCandidateInit[]
    const hasInitializedRoomRef = useRef(false);
    const callSignalHandlerRef = useRef(null);

    const getDiagnosticsContext = useCallback(() => ({
        clientId: myIdRef.current || '',
        roomId: currentRoomRef.current || '',
        activeUserId: activeUserRef.current || '',
        nickname: nicknameRef.current || '',
        onlineUserCount: onlineUsersRef.current.size,
        rtcProvider: rtcConfigRef.current?.provider || 'default',
        iceServerCount: Array.isArray(rtcConfigRef.current?.iceServers)
            ? rtcConfigRef.current.iceServers.length
            : 0,
        wsStatus: wsStatusRef.current,
        connectionStatus: connectionStatusRef.current,
        page: window.location.pathname
    }), []);

    const diagnostics = useDiagnostics({
        getContext: getDiagnosticsContext
    });

    const refreshAnonymousSession = useCallback(async ({ quiet = false, reason = 'manual' } = {}) => {
        if (sessionRefreshPromiseRef.current) {
            return sessionRefreshPromiseRef.current;
        }

        sessionRefreshPromiseRef.current = fetchSession()
            .then((session) => {
                myIdRef.current = session.clientId;
                setMyId(prev => prev === session.clientId ? prev : session.clientId);
                setSessionReady(true);
                setSessionError('');
                diagnostics.recordEvent('session_refreshed', {
                    clientId: session.clientId,
                    expiresAt: session.expiresAt,
                    reason
                });
                if (!quiet) {
                    log(`Anonymous session refreshed: ${session.clientId}`);
                }
                return session;
            })
            .catch((error) => {
                diagnostics.reportIssue('session_refresh_failed', {
                    message: error?.message || 'unknown',
                    name: error?.name || 'Error',
                    reason
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'session-refresh'
                    }
                });
                if (!quiet) {
                    setSessionError('匿名会话续期失败，请刷新页面重试。');
                }
                throw error;
            })
            .finally(() => {
                sessionRefreshPromiseRef.current = null;
            });

        return sessionRefreshPromiseRef.current;
    }, [diagnostics]);
    
    // 保存昵称到 localStorage
    useEffect(() => {
        if (nickname) {
            localStorage.setItem('nickname', nickname);
        }
        nicknameRef.current = nickname;
    }, [nickname]);

    useEffect(() => {
        rtcConfigRef.current = rtcConfig;
    }, [rtcConfig]);

    useEffect(() => {
        onlineUsersRef.current = onlineUsers;
    }, [onlineUsers]);

    useEffect(() => {
        if (!myId) {
            setLastReadTime({});
            return;
        }

        try {
            const stored = localStorage.getItem(`lastReadTime_${myId}`);
            setLastReadTime(stored ? JSON.parse(stored) : {});
        } catch {
            setLastReadTime({});
        }
    }, [myId]);
    
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
    } = useRoom({ diagnostics });
    
    // 聊天历史管理 Hook
    const { loadChatHistory, saveChatHistory } = useChatHistory(
        myId,
        currentRoom
    );
    
    // 存储 Blob URLs 用于清理
    const blobUrlsRef = useRef(new Set());
    
    const chatBoxRef = useRef(null);
    const firstUnreadRef = useRef(null); // 第一条未读消息的 ref
    const scrollTimeoutRef = useRef(null); // 滚动防抖定时器
    
    const [isDragging, setIsDragging] = useState(false);
    const dragCounter = useRef(0);

    const handleDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragging(false);
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        dragCounter.current = 0;
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            setPendingFiles(prev => [...prev, ...files]);
        }
    };

    // 同步 activeUser 到 ref
    useEffect(() => {
        activeUserRef.current = activeUser;
    }, [activeUser]);

    useEffect(() => {
        currentRoomRef.current = currentRoom;
    }, [currentRoom]);
    
    // 保存 lastReadTime 到 localStorage
    useEffect(() => {
        if (myIdRef.current && Object.keys(lastReadTime).length > 0) {
            localStorage.setItem(`lastReadTime_${myIdRef.current}`, JSON.stringify(lastReadTime));
        }
    }, [lastReadTime, myId]);
    
    // 滚动监听：滚动到底部时标记为已读
    useEffect(() => {
        const chatBox = chatBoxRef.current;
        if (!chatBox) return;
        
        const handleScroll = () => {
            // 清除之前的定时器
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
            
            // 防抖：滚动停止 300ms 后才处理
            scrollTimeoutRef.current = setTimeout(() => {
                const isAtBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 50;
                
                if (isAtBottom) {
                    // 滚动到底部，标记为已读
                    const chatKey = activeUser === null ? '__global__' : activeUser;
                    setLastReadTime(prev => ({
                        ...prev,
                        [chatKey]: Date.now()
                    }));
                    console.log('📜 滚动到底部，标记为已读');
                }
            }, 300);
        };
        
        chatBox.addEventListener('scroll', handleScroll);
        return () => {
            chatBox.removeEventListener('scroll', handleScroll);
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, [activeUser]);
    
    // 页面卸载时保存当前已读时间
    useEffect(() => {
        const handleBeforeUnload = () => {
            if (myIdRef.current && activeUser !== undefined) {
                const chatKey = activeUser === null ? '__global__' : activeUser;
                const updatedTime = {
                    ...lastReadTime,
                    [chatKey]: Date.now()
                };
                localStorage.setItem(`lastReadTime_${myIdRef.current}`, JSON.stringify(updatedTime));
                console.log('💾 页面卸载，保存已读时间');
            }
        };
        
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [activeUser, lastReadTime, myId]);
    
    const log = (msg) => setLogs(prev => [...prev, msg]);

    const getMessageMode = useCallback((msg) => {
        if (msg?.mode === 'private' || msg?.mode === 'broadcast') {
            return msg.mode;
        }

        return msg?.to ? 'private' : 'broadcast';
    }, []);

    const getMessageChatWindow = useCallback((msg) => {
        const mode = getMessageMode(msg);
        if (mode === 'broadcast') {
            return null;
        }

        if (msg.from === 'Me') {
            return msg.to || null;
        }

        if (msg.from === myIdRef.current) {
            return msg.to || null;
        }

        return msg.from || null;
    }, [getMessageMode]);
    
    // 添加聊天消息并自动保存到 localStorage
    const addChat = (msg) => {
        // 添加时间戳（如果没有）
        const messageWithTime = {
            ...msg,
            mode: getMessageMode(msg),
            timestamp: msg.timestamp || Date.now()
        };
        
        setChatHistory(prev => {
            const newHistory = [...prev, messageWithTime];
            // 异步保存，不阻塞UI
            setTimeout(() => saveChatHistory(newHistory, currentRoom), 0);
            
            // 滚动到底部（如果是当前活跃窗口的消息）
            setTimeout(() => {
                if (chatBoxRef.current && getMessageChatWindow(messageWithTime) === activeUserRef.current) {
                    chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
                }
            }, 0);
            
            return newHistory;
        });
        
        // 更新未读消息计数
        if (msg.from && msg.from !== 'Me' && msg.from !== myIdRef.current) {
            const chatWindow = getMessageChatWindow(messageWithTime);
            
            // 如果不是当前活跃的聊天窗口，增加未读计数
            if (chatWindow !== activeUserRef.current) {
                const key = chatWindow === null ? '__global__' : chatWindow;
                setUnreadCounts(prev => ({
                    ...prev,
                    [key]: (prev[key] || 0) + 1
                }));
            } else {
                // 如果是当前活跃窗口，直接更新已读时间，防止刷新后显示未读
                const key = chatWindow === null ? '__global__' : chatWindow;
                setLastReadTime(prev => ({
                    ...prev,
                    [key]: Date.now()
                }));
            }
        }
    };

    const patchChatMessages = useCallback((matcher, patch) => {
        setChatHistory(prev => {
            let changed = false;
            const nextHistory = prev.map(message => {
                if (!matcher(message)) {
                    return message;
                }
                changed = true;
                const nextPatch = typeof patch === 'function' ? patch(message) : patch;
                return {
                    ...message,
                    ...nextPatch
                };
            });

            if (!changed) {
                return prev;
            }

            setTimeout(() => saveChatHistory(nextHistory, currentRoom), 0);
            return nextHistory;
        });
    }, [currentRoom, saveChatHistory]);
    
    // 清除当前聊天窗口的历史记录
    const handleClearHistory = () => {
        const chatName = activeUser === null ? '全局聊天' : `与 ${getDisplayName(activeUser)} 的聊天`;
        if (window.confirm(`确定要清除 ${chatName} 记录吗？此操作不可恢复。`)) {
            clearIncomingFileOffersForWindow(activeUser);
            setChatHistory(prev => {
                // 过滤掉当前窗口的消息，保留其他窗口的消息
                const newHistory = prev.filter(msg => {
                    if (activeUser === null) {
                        // 如果是清除全局聊天，保留私聊消息
                        return getMessageChatWindow(msg) !== null;
                    }

                    // 如果是清除私聊，保留除当前私聊窗口外的其他消息
                    return getMessageChatWindow(msg) !== activeUser;
                });
                
                // 保存新的历史记录
                saveChatHistory(newHistory, currentRoom);
                return newHistory;
            });
            log(`${chatName} 记录已清除`);
        }
    };
    
    // 切换聊天窗口（清零未读计数并记录已读时间）
    const switchToUser = (userId) => {
        // 记录当前（旧）窗口的已读时间
        if (activeUser !== undefined) {
            const currentKey = activeUser === null ? '__global__' : activeUser;
            setLastReadTime(prev => ({
                ...prev,
                [currentKey]: Date.now()
            }));
        }
        
        // 重置第一条未读消息的 ref
        firstUnreadRef.current = null;
        
        setActiveUser(userId);
        
        // 清零该聊天窗口的未读计数
        const key = userId === null ? '__global__' : userId;
        setUnreadCounts(prev => {
            const newCounts = { ...prev };
            delete newCounts[key];
            return newCounts;
        });
        
        // 延迟滚动，等待DOM更新和ref绑定
        setTimeout(() => scrollToUnreadOrBottom(key), 200);
    };
    
    // 智能滚动：滚动到第一条未读消息或底部
    const scrollToUnreadOrBottom = (chatKey) => {
        if (!chatBoxRef.current) return;
        
        // 如果有第一条未读消息的 ref，滚动到那里
        if (firstUnreadRef.current) {
            console.log('👉 有未读消息，滚动到第一条');
            firstUnreadRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            console.log('👉 没有未读消息，滚动到底部');
            // 否则滚动到底部
            chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
            // 滚动到底部后标记为已读
            setLastReadTime(prev => ({
                ...prev,
                [chatKey]: Date.now()
            }));
        }
    };
    
    // getDisplayName 在下面定义（需要访问 nickname 状态）
    const getDisplayName = (userId) => {
        if (userId === myIdRef.current) return nickname || myIdRef.current;
        return userNicknames[userId] || userId;
    };
    
    // 文件传输 Hook
    const {
        fileProgress,
        transferControlRef,
        incomingFilesRef,
        sendFile,
        clearIncomingFileOffersForWindow,
        acceptIncomingFileOffer,
        rejectIncomingFileOffer,
        handleIncomingFileChunk,
        handleIncomingFileMessage,
        getTransferPausedState,
        toggleTransferPause,
        cancelTransfer,
        defaultReceiveDirectory,
        receiveDirectoryBusy,
        configureDefaultReceiveDirectory,
        clearDefaultReceiveDirectory
    } = useFileTransfer({
        log,
        addChat,
        patchChatMessages,
        peersRef,
        myId: myIdRef.current,
        getDisplayName,
        blobUrlsRef,
        activeUser,
        diagnostics
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

    const {
        connectionStatus,
        wsStatus,
        sendSignal,
        connectWs,
        cleanupConnections,
        getPeerChatChannel,
        getSignalPresence,
        isPeerChannelAvailable
    } = usePeerRuntime({
        diagnostics,
        myIdRef,
        nicknameRef,
        activeUserRef,
        onlineUsersRef,
        rtcConfigRef,
        connectionStatusRef,
        wsStatusRef,
        refreshAnonymousSession,
        log,
        addChat,
        setUserNicknames,
        switchToUser,
        updateOnlineUsers,
        incomingFilesRef,
        myICECandidatesRef,
        peersRef,
        peerInstanceCounterRef,
        eventQueueRef,
        connectionTimeoutRef,
        pendingIceCandidatesRef,
        callSignalHandlerRef,
        handleIncomingFileChunk,
        handleIncomingFileMessage
    });

    useEffect(() => {
        let isMounted = true;

        const initializeApp = async () => {
            try {
                const [session, config] = await Promise.all([
                    fetchSession(),
                    fetchIceConfig()
                ]);

                if (!isMounted) {
                    return;
                }

                myIdRef.current = session.clientId;
                setMyId(session.clientId);
                setRtcConfig(config);
                setSessionError('');
                setSessionReady(true);
                diagnostics.recordEvent('session_initialized', {
                    clientId: session.clientId,
                    expiresAt: session.expiresAt
                });
                diagnostics.recordEvent('ice_config_loaded', {
                    provider: config.provider || 'default',
                    iceServerCount: Array.isArray(config.iceServers) ? config.iceServers.length : 0
                });
            } catch (error) {
                console.error('Failed to initialize session:', error);
                if (!isMounted) {
                    return;
                }
                diagnostics.reportIssue('session_initialization_failed', {
                    message: error?.message || 'unknown',
                    name: error?.name || 'Error'
                }, {
                    flush: 'immediate',
                    context: {
                        feature: 'session-bootstrap'
                    }
                });
                setSessionError('无法初始化匿名会话，请刷新页面重试。');
            }
        };

        initializeApp();

        return () => {
            isMounted = false;
            cleanupConnections();
            blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
            blobUrlsRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (!sessionReady) {
            return;
        }

        diagnostics.retryPendingReports().then((count) => {
            if (count > 0) {
                diagnostics.recordEvent('pending_diagnostics_replayed', {
                    count
                });
            }
        });
    }, [sessionReady, diagnostics]);

    const joinRoom = (roomId, currentUserId = myIdRef.current) => {
        if (!roomId.trim() || !currentUserId) {
            return;
        }

        if (currentRoom && activeUser !== undefined) {
            const key = activeUser === null ? '__global__' : activeUser;
            setLastReadTime(prev => ({
                ...prev,
                [key]: Date.now()
            }));
        }

        cleanupConnections();

        const history = loadChatHistory(roomId);
        setChatHistory(history);

        if (history.length > 0) {
            log(`Loaded ${history.length} messages from history`);
        }

        setUnreadCounts({});
        setOnlineUsers(new Set([currentUserId]));
        setCurrentRoom(roomId);
        setShowRoomInput(false);
        localStorage.setItem('lastRoom', roomId);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const privateParam = isPrivate ? '&private=true' : '';
        const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomId)}${privateParam}`;
        connectWs(wsUrl);

        const privateStr = isPrivate ? ' (私有)' : '';
        log(`Joined room: ${roomId}${privateStr}`);
        diagnostics.recordEvent('room_joined', {
            roomId,
            isPrivate,
            clientId: currentUserId
        });

        setIsPrivate(false);
    };

    useEffect(() => {
        if (!sessionReady || !myId || hasInitializedRoomRef.current) {
            return;
        }

        hasInitializedRoomRef.current = true;

        if (currentRoom) {
            joinRoom(currentRoom, myId);
        } else {
            setShowRoomInput(true);
            fetchRooms();
        }
    }, [sessionReady, myId]);
    
    // 音视频通话 Hook
    const {
        callStatus,
        remoteUser: callRemoteUser,
        isVideoEnabled,
        isAudioEnabled,
        isScreenSharing,
        remoteVideoEnabled,
        remoteAudioEnabled,
        localStream,
        remoteStream,
        startCall,
        acceptCall,
        rejectCall,
        endCall,
        toggleVideo,
        toggleAudio,
        startScreenShare,
        stopScreenShare,
        handleCallSignal
    } = useVideoCall({
        peersRef,
        sendSignal, // 通话控制与视频重协商统一走 WebSocket
        log,
        myId: myIdRef.current,
        getDisplayName,
        diagnostics
    });
    callSignalHandlerRef.current = handleCallSignal;

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
                const dc = getPeerChatChannel(peersRef.current[activeUser]);
                const status = connectionStatus[activeUser]?.status;
                
                if (!dc || dc.readyState !== 'open') {
                    if (status === PEER_CHANNEL_STATUS.CONNECTING) {
                        diagnostics.reportIssue('private_message_send_blocked_connecting', {
                            targetUserId: activeUser
                        }, {
                            delayMs: 1000,
                            context: {
                                feature: 'message-send'
                            }
                        });
                        alert(`正在与 ${getDisplayName(activeUser)} 建立连接，请稍候...`);
                    } else {
                        diagnostics.reportIssue('private_message_send_no_connection', {
                            targetUserId: activeUser
                        }, {
                            delayMs: 1000,
                            context: {
                                feature: 'message-send'
                            }
                        });
                        alert(`无法发送消息：${getDisplayName(activeUser)} 未连接。`);
                    }
                    return;
                }
                dc.send(JSON.stringify(msgObj));
                addChat({ from: 'Me', to: activeUser, ...msgObj });
            } else {
                // Global Chat
                const activePeers = Object.keys(peersRef.current).filter(id => {
                    const dc = getPeerChatChannel(peersRef.current[id]);
                    return dc && dc.readyState === 'open';
                });
                
                const connectingPeers = Object.keys(connectionStatus).filter(id => 
                    connectionStatus[id]?.status === PEER_CHANNEL_STATUS.CONNECTING
                );
                
                if (activePeers.length === 0) {
                    if (connectingPeers.length > 0) {
                        diagnostics.reportIssue('broadcast_message_send_blocked_connecting', {
                            connectingPeerCount: connectingPeers.length
                        }, {
                            delayMs: 1000,
                            context: {
                                feature: 'message-send'
                            }
                        });
                        alert(`正在与 ${connectingPeers.length} 个用户建立连接，请稍候...`);
                    } else {
                        diagnostics.reportIssue('broadcast_message_send_no_peers', {}, {
                            delayMs: 1000,
                            context: {
                                feature: 'message-send'
                            }
                        });
                        alert('没有活跃连接。请等待其他用户加入。');
                    }
                    return;
                }
                
                activePeers.forEach(id => {
                    getPeerChatChannel(peersRef.current[id])?.send(JSON.stringify(msgObj));
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
            return getMessageChatWindow(msg) === null;
        }

        // Private chat: show only messages that belong to the active private window
        return getMessageChatWindow(msg) === activeUser;
    });

    const knownUsers = Array.from(new Set([
        ...onlineUsers,
        ...Object.keys(connectionStatus)
    ]));
    const wsStatusConfig = {
        [WS_STATUS.CONNECTING]: {
            tone: 'bg-amber-100 text-amber-700 border-amber-200',
            text: '信令连接中'
        },
        [WS_STATUS.CONNECTED]: {
            tone: 'bg-emerald-100 text-emerald-700 border-emerald-200',
            text: '信令在线'
        },
        [WS_STATUS.RECONNECTING]: {
            tone: 'bg-orange-100 text-orange-700 border-orange-200',
            text: '信令重连中'
        },
        [WS_STATUS.DISCONNECTED]: {
            tone: 'bg-slate-100 text-slate-600 border-slate-200',
            text: '信令离线'
        }
    };
    const currentWsStatus = wsStatusConfig[wsStatus] || wsStatusConfig[WS_STATUS.DISCONNECTED];
    const activeConnectionInfo = activeUser ? connectionStatus[activeUser] : null;
    const activePeerStatus = activeConnectionInfo?.status || PEER_CHANNEL_STATUS.DISCONNECTED;
    const activeSignalPresence = activeUser ? getSignalPresence(activeUser) : 'unknown';
    const activePeerLabel = activeUser === null
        ? null
        : ({
            [PEER_CHANNEL_STATUS.CONNECTING]: 'P2P 建立中',
            [PEER_CHANNEL_STATUS.CONNECTED]: activeConnectionInfo?.networkType === 'lan'
                ? 'P2P 直连(局域网)'
                : activeConnectionInfo?.networkType === 'wan'
                    ? 'P2P 已连(公网)'
                    : 'P2P 已连接',
            [PEER_CHANNEL_STATUS.STALE]: 'P2P 静默待确认',
            [PEER_CHANNEL_STATUS.DISCONNECTED]: 'P2P 未连接'
        }[activePeerStatus] || 'P2P 未连接');
    const activeSignalLabel = activeUser === null
        ? null
        : ({
            online: '信令在线',
            offline: '信令已离线',
            unknown: currentWsStatus.text
        }[activeSignalPresence] || currentWsStatus.text);
    const receiveDirectoryBadgeText = defaultReceiveDirectory.status === 'ready'
        ? `接收目录: ${defaultReceiveDirectory.name}`
        : defaultReceiveDirectory.status === 'needs-permission'
            ? `接收目录待授权: ${defaultReceiveDirectory.name}`
            : null;

    if (sessionError) {
        return (
            <div className="min-h-screen bg-blue-50 flex items-center justify-center p-6">
                <div className="max-w-md w-full rounded-2xl border bg-white p-6 shadow-sm space-y-4">
                    <div className="space-y-1">
                        <h2 className="text-lg font-semibold text-slate-900">会话初始化失败</h2>
                        <p className="text-sm text-slate-600">{sessionError}</p>
                    </div>
                    <Button onClick={() => window.location.reload()} className="w-full">
                        重新加载
                    </Button>
                </div>
            </div>
        );
    }

    if (!sessionReady) {
        return (
            <div className="min-h-screen bg-blue-50 flex items-center justify-center p-6">
                <div className="max-w-md w-full rounded-2xl border bg-white p-6 shadow-sm space-y-2">
                    <h2 className="text-lg font-semibold text-slate-900">正在建立匿名会话</h2>
                    <p className="text-sm text-slate-600">
                        正在向服务端申请匿名身份并准备进入房间...
                    </p>
                </div>
            </div>
        );
    }

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
        <div 
            className="w-full h-screen bg-blue-50 relative"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Drag & Drop Overlay */}
            {isDragging && (
                <div className="absolute inset-0 z-50 bg-blue-900/50 flex items-center justify-center backdrop-blur-sm border-4 border-dashed border-blue-500 m-4 rounded-xl pointer-events-none">
                    <div className="text-white text-xl font-medium flex flex-col items-center gap-4">
                        <div className="p-4 bg-blue-500/20 rounded-full">
                            <Upload className="w-16 h-16 text-blue-400" />
                        </div>
                        <span>释放文件以添加到发送列表</span>
                    </div>
                </div>
            )}

            <div className="w-full h-full flex relative">
                {/* Left Side: User List */}
                <div className={cn(
                    "w-full md:w-56 lg:w-64 bg-white border-r flex flex-col transition-transform duration-300 z-20",
                    "md:translate-x-0 md:relative",
                    isSidebarOpen ? "translate-x-0 fixed inset-0" : "-translate-x-full fixed md:relative"
                )}>
                    <div className="px-3 sm:px-4 py-3 sm:py-4 border-b">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                <h2 className="font-semibold text-sm">
                                    {knownUsers.filter(user => user !== myIdRef.current).length} Peers
                                </h2>
                            </div>
                            <Badge variant="outline" className={cn("text-[10px] h-5 px-1.5 shrink-0", currentWsStatus.tone)}>
                                {currentWsStatus.text}
                            </Badge>
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
                                    ? "bg-[#1e3a8a] text-white" 
                                    : unreadCounts['__global__'] > 0
                                        ? "hover:bg-blue-100 text-blue-900 ring-2 ring-green-400 shadow-lg shadow-green-200/50"
                                        : "hover:bg-blue-100 text-blue-900"
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
                                    : "bg-blue-100"
                            )}>
                                <Globe className={cn("w-5 h-5", activeUser === null ? "text-white" : "text-blue-600")} />
                            </div>
                            <div className="flex flex-col flex-1 min-w-0">
                                <span className="text-sm font-medium truncate">
                                    Global Chat
                                </span>
                                <span className={cn(
                                    "text-xs",
                                    activeUser === null ? "text-white/70" : "text-blue-500"
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
                        {knownUsers.map(user => {
                            if (user === myIdRef.current) return null; // Don't show myself in private chat list
                            const displayName = getDisplayName(user);
                            const connInfo = connectionStatus[user] || { status: PEER_CHANNEL_STATUS.DISCONNECTED };
                            const status = connInfo.status || PEER_CHANNEL_STATUS.DISCONNECTED;
                            const networkType = connInfo.networkType;
                            const signalPresence = getSignalPresence(user);
                            const p2pLabel = {
                                [PEER_CHANNEL_STATUS.CONNECTING]: 'P2P 建立中',
                                [PEER_CHANNEL_STATUS.CONNECTED]: networkType === 'lan'
                                    ? 'P2P 直连(局域网)'
                                    : networkType === 'wan'
                                        ? 'P2P 已连(公网)'
                                        : 'P2P 已连接',
                                [PEER_CHANNEL_STATUS.STALE]: 'P2P 静默待确认',
                                [PEER_CHANNEL_STATUS.DISCONNECTED]: 'P2P 未连接'
                            }[status] || 'P2P 未连接';
                            const signalLabel = {
                                online: '信令在线',
                                offline: '信令已离线',
                                unknown: currentWsStatus.text
                            }[signalPresence];
                            
                            const unreadCount = unreadCounts[user] || 0;
                            
                            return (
                                <div 
                                    key={user} 
                                    className={cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer relative",
                                        activeUser === user 
                                            ? "bg-[#1e3a8a] text-white" 
                                            : unreadCount > 0
                                                ? "hover:bg-blue-100 text-blue-900 ring-2 ring-green-400 shadow-lg shadow-green-200/50"
                                                : "hover:bg-blue-100 text-blue-900"
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
                                                : "bg-[#1e3a8a] text-white"
                                        )}>
                                            {getInitials(displayName)}
                                        </div>
                                        <div 
                                            className={cn(
                                                "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2",
                                                activeUser === user ? "border-[#1e3a8a]" : "border-white",
                                                status === PEER_CHANNEL_STATUS.CONNECTED && "bg-green-500",
                                                status === PEER_CHANNEL_STATUS.CONNECTING && "bg-amber-500",
                                                status === PEER_CHANNEL_STATUS.STALE && "bg-orange-400",
                                                status === PEER_CHANNEL_STATUS.DISCONNECTED && "bg-slate-400"
                                            )}
                                        />
                                    </div>
                                    <div className="flex flex-col flex-1 min-w-0">
                                        <span className="text-sm font-medium truncate">
                                            {displayName}
                                        </span>
                                        <span className={cn(
                                            "text-xs",
                                            activeUser === user ? "text-white/70" : "text-blue-500"
                                        )}>
                                            {p2pLabel}
                                        </span>
                                        <span className={cn(
                                            "text-[11px]",
                                            activeUser === user ? "text-white/60" : "text-slate-400"
                                        )}>
                                            {signalLabel}
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
                                <Badge variant="outline" className={cn("text-xs h-5 px-2", currentWsStatus.tone)}>
                                    {currentWsStatus.text}
                                </Badge>
                                {activeUser !== null && (
                                    <>
                                        <Badge variant="outline" className="text-xs h-5 px-2 border-blue-200 text-blue-700">
                                            {activePeerLabel}
                                        </Badge>
                                        <Badge variant="outline" className="text-xs h-5 px-2 border-slate-200 text-slate-600">
                                            {activeSignalLabel}
                                        </Badge>
                                    </>
                                )}
                                {receiveDirectoryBadgeText && (
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "text-xs h-5 px-2 max-w-[220px] truncate",
                                            defaultReceiveDirectory.status === 'ready'
                                                ? "border-amber-200 text-amber-700"
                                                : "border-orange-200 text-orange-700"
                                        )}
                                        title={receiveDirectoryBadgeText}
                                    >
                                        {receiveDirectoryBadgeText}
                                    </Badge>
                                )}
                                {nickname ? (
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-muted-foreground">
                                            {nickname}
                                        </span>
                                        <Button 
                                            variant="ghost" 
                                            size="icon" 
                                            className="h-5 w-5 p-0 hover:bg-blue-100"
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
                                        className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground hover:bg-blue-100"
                                        title="设置昵称"
                                    >
                                        <Edit2 className="w-3 h-3" />
                                    </Button>
                                )}
                            </div>
                        </div>
                        
                        {/* 通话按钮 - 仅在私聊时显示 */}
                        {activeUser !== null && isPeerChannelAvailable(activePeerStatus) && (
                            <div className="flex gap-1 shrink-0">
                                <Button
                                    onClick={() => startCall(activeUser, false)}
                                    disabled={callStatus !== CALL_STATUS.IDLE}
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 w-8 p-0"
                                    title="语音通话"
                                >
                                    <Phone className="w-4 h-4" />
                                </Button>
                                <Button
                                    onClick={() => startCall(activeUser, true)}
                                    disabled={callStatus !== CALL_STATUS.IDLE}
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 w-8 p-0"
                                    title="视频通话"
                                >
                                    <Video className="w-4 h-4" />
                                </Button>
                            </div>
                        )}
                        
                        <Button 
                            onClick={() => void configureDefaultReceiveDirectory()}
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs shrink-0"
                            disabled={receiveDirectoryBusy || !defaultReceiveDirectory.supported}
                            title={defaultReceiveDirectory.supported ? '设置默认接收目录' : '当前环境不支持默认接收目录'}
                        >
                            <FolderOpen className="w-3.5 h-3.5 mr-1" />
                            {defaultReceiveDirectory.name ? '收件目录' : '设置收件目录'}
                        </Button>
                        {defaultReceiveDirectory.name && (
                            <Button
                                onClick={() => void clearDefaultReceiveDirectory()}
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 shrink-0"
                                disabled={receiveDirectoryBusy}
                                title="清除默认接收目录"
                            >
                                <X className="w-4 h-4" />
                            </Button>
                        )}
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
                    <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-col gap-3 sm:gap-4 bg-blue-50" ref={chatBoxRef}>
                        {filteredChatHistory.map((c, i) => {
                            // 计算是否是第一条未读消息
                            const chatKey = activeUser === null ? '__global__' : activeUser;
                            const lastRead = lastReadTime[chatKey] || 0;
                            const isUnread = c.timestamp && c.timestamp > lastRead && c.from !== 'Me' && c.from !== myIdRef.current;
                            
                            // 调试日志
                            if (i === 0) {
                                console.log(`📱 渲染消息 - chatKey: ${chatKey}, lastRead: ${new Date(lastRead).toLocaleString()}, 消息总数: ${filteredChatHistory.length}`);
                            }
                            
                            if (isUnread) {
                                console.log(`✉️ 未读消息 #${i}: from=${c.from}, timestamp=${new Date(c.timestamp).toLocaleString()}`);
                            }
                            
                            // 检查这是否是第一条未读消息（往前找第一个非自己发送的消息）
                            let isFirstUnread = false;
                            if (isUnread) {
                                // 往前找，看前面是否还有未读消息
                                let hasUnreadBefore = false;
                                for (let j = i - 1; j >= 0; j--) {
                                    const prev = filteredChatHistory[j];
                                    // 跳过自己发送的消息
                                    if (prev.from === 'Me' || prev.from === myIdRef.current) continue;
                                    // 找到一条非自己的消息，检查是否已读
                                    if (prev.timestamp && prev.timestamp > lastRead) {
                                        hasUnreadBefore = true;
                                    }
                                    break;
                                }
                                isFirstUnread = !hasUnreadBefore;
                                
                                if (isFirstUnread) {
                                    console.log(`🔴 第一条未读消息在索引 #${i}`);
                                }
                            }
                            
                            return (
                                <React.Fragment key={i}>
                                    {isFirstUnread && (
                                        <div ref={firstUnreadRef} className="flex items-center gap-3 my-2">
                                            <div className="flex-1 h-px bg-red-300"></div>
                                            <span className="text-xs font-medium text-red-500 px-2 py-1 bg-red-50 rounded-full">
                                                未读消息
                                            </span>
                                            <div className="flex-1 h-px bg-red-300"></div>
                                        </div>
                                    )}
                                    <ChatMessage
                                        message={c}
                                        displayName={getDisplayName(c.from)}
                                        isMine={c.from === 'Me'}
                                        onImageClick={setPreviewImage}
                                        onAcceptFileOffer={acceptIncomingFileOffer}
                                        onRejectFileOffer={rejectIncomingFileOffer}
                                    />
                                </React.Fragment>
                            );
                        })}
                    </div>
                    
                    {/* File Progress Bars */}
                    {Object.keys(fileProgress).length > 0 && (
                        <div className="px-4 py-3 border-t bg-white">
                            {Object.entries(fileProgress).map(([id, p]) => {
                                const isUpload = id.startsWith('up-');
                                const controlKey = p.controlKey || (isUpload ? id.split('-').slice(0, 2).join('-') : id);
                                const targetId = p.targetId || null;
                                const control = transferControlRef.current[controlKey];
                                const isPaused = getTransferPausedState(controlKey, {
                                    type: p.type,
                                    targetId
                                });
                                
                                const handlePauseResume = () => {
                                    toggleTransferPause(controlKey, {
                                        type: p.type,
                                        targetId
                                    });
                                };
                                
                                const handleCancel = () => {
                                    cancelTransfer(controlKey, {
                                        type: p.type,
                                        targetId
                                    });
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
            
            {/* 来电弹窗 */}
            <IncomingCallModal
                isOpen={callStatus === CALL_STATUS.INCOMING}
                callerName={callRemoteUser ? getDisplayName(callRemoteUser) : ''}
                isVideoCall={isVideoEnabled}
                onAccept={acceptCall}
                onReject={rejectCall}
            />
            
            {/* 呼叫中弹窗 */}
            <CallingModal
                isOpen={callStatus === CALL_STATUS.CALLING}
                calleeName={callRemoteUser ? getDisplayName(callRemoteUser) : ''}
                onCancel={endCall}
            />
            
            {/* 视频通话窗口 */}
            <VideoCallWindow
                isOpen={callStatus === CALL_STATUS.CONNECTED}
                localStream={localStream}
                remoteStream={remoteStream}
                remoteName={callRemoteUser ? getDisplayName(callRemoteUser) : ''}
                isVideoEnabled={isVideoEnabled}
                isAudioEnabled={isAudioEnabled}
                isScreenSharing={isScreenSharing}
                remoteVideoEnabled={remoteVideoEnabled}
                onEndCall={endCall}
                onToggleVideo={toggleVideo}
                onToggleAudio={toggleAudio}
                onStartScreenShare={startScreenShare}
                onStopScreenShare={stopScreenShare}
            />
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
