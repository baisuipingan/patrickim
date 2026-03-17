import React, { useState, useEffect, useRef, useCallback, Component } from 'react';
import { formatSize, formatTime, formatSpeed } from './utils/formatters';
import { isModernFileAPISupported } from './utils/fileUtils';
import { ICE_SERVERS, fetchIceConfig, fetchSession } from './constants/config';
import { useRoom } from './hooks/useRoom';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useChatHistory } from './hooks/useChatHistory';
import { useDiagnostics } from './hooks/useDiagnostics';
import { RoomSelector } from './components/RoomSelector';
import FileProgress from './components/FileProgress';
import MessageInput from './components/MessageInput';
import ChatMessage from './components/ChatMessage';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Badge } from './components/ui/badge';
import { Avatar, AvatarFallback } from './components/ui/avatar';
import { Menu, Globe, Edit2, X, Trash2, Upload, Video, Phone } from 'lucide-react';
import { useVideoCall, CALL_STATUS, CALL_MESSAGE_TYPES } from './hooks/useVideoCall';
import { IncomingCallModal, CallingModal, VideoCallWindow, CallButton } from './components/VideoCall';
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

const WS_STATUS = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DISCONNECTED: 'disconnected'
};

const PEER_CHANNEL_STATUS = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    STALE: 'stale',
    DISCONNECTED: 'disconnected'
};

const PEER_HEARTBEAT_MESSAGE_TYPE = '__peer-heartbeat';
const PEER_HEARTBEAT_INTERVAL_MS = 15_000;
const PEER_STALE_THRESHOLD_MS = 60_000;
const PEER_STALE_SWEEP_INTERVAL_MS = 5_000;
const WS_CLOSE_REPORT_WINDOW_MS = 20_000;
const WS_CLOSE_REPORT_THRESHOLD = 2;

function ChatApp() {
    // Refs for mutable objects
    const [myId, setMyId] = useState('');
    const myIdRef = useRef('');
    const wsRef = useRef(null);
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
    const [connectionStatus, setConnectionStatus] = useState({}); // id -> P2P状态与诊断字段
    const [wsStatus, setWsStatus] = useState(WS_STATUS.DISCONNECTED);
    const [isPrivate, setIsPrivate] = useState(false); // 是否创建私有房间
    const [unreadCounts, setUnreadCounts] = useState({}); // 未读消息计数 { userId: count }
    const [lastReadTime, setLastReadTime] = useState({}); // 记录每个聊天窗口的最后已读时间 { chatKey: timestamp }
    const [sessionReady, setSessionReady] = useState(false);
    const [sessionError, setSessionError] = useState('');
    const isModernAPISupported = isModernFileAPISupported();
    const [rtcConfig, setRtcConfig] = useState(ICE_SERVERS);
    const currentRoomRef = useRef(localStorage.getItem('lastRoom') || '');
    const connectionStatusRef = useRef({});
    const wsStatusRef = useRef(WS_STATUS.DISCONNECTED);
    const rtcConfigRef = useRef(ICE_SERVERS);
    const onlineUsersRef = useRef(new Set());
    const sessionRefreshPromiseRef = useRef(null);
    const wsCloseBurstRef = useRef({
        count: 0,
        windowStartedAt: 0
    });
    
    const peersRef = useRef({}); // id -> {pc, dc}
    const peerInstanceCounterRef = useRef(0);
    const eventQueueRef = useRef({}); // remoteId -> EventQueue
    const connectionTimeoutRef = useRef({}); // remoteId -> timeout handle
    const pendingIceCandidatesRef = useRef({}); // remoteId -> RTCIceCandidateInit[]
    const hasInitializedRoomRef = useRef(false);

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
        connectionStatusRef.current = connectionStatus;
    }, [connectionStatus]);

    useEffect(() => {
        wsStatusRef.current = wsStatus;
    }, [wsStatus]);

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
    const { loadChatHistory, saveChatHistory, clearChatHistory } = useChatHistory(
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
    
    // 添加聊天消息并自动保存到 localStorage
    const addChat = (msg) => {
        // 添加时间戳（如果没有）
        const messageWithTime = {
            ...msg,
            timestamp: msg.timestamp || Date.now()
        };
        
        setChatHistory(prev => {
            const newHistory = [...prev, messageWithTime];
            // 异步保存，不阻塞UI
            setTimeout(() => saveChatHistory(newHistory, currentRoom), 0);
            
            // 滚动到底部（如果是当前活跃窗口的消息）
            setTimeout(() => {
                if (chatBoxRef.current) {
                    chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
                }
            }, 0);
            
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
    
    // 清除当前聊天窗口的历史记录
    const handleClearHistory = () => {
        const chatName = activeUser === null ? '全局聊天' : `与 ${getDisplayName(activeUser)} 的聊天`;
        if (window.confirm(`确定要清除 ${chatName} 记录吗？此操作不可恢复。`)) {
            setChatHistory(prev => {
                // 过滤掉当前窗口的消息，保留其他窗口的消息
                const newHistory = prev.filter(msg => {
                    if (activeUser === null) {
                        // 如果是清除全局聊天，保留私聊消息
                        return msg.mode === 'private';
                    } else {
                        // 如果是清除私聊，保留全局消息和其他人的私聊
                        // 删除条件：mode是private 且 (与activeUser有关)
                        const isTargetMessage = msg.mode === 'private' && (
                            (msg.from === 'Me' && msg.to === activeUser) || 
                            (msg.from === activeUser)
                        );
                        return !isTargetMessage;
                    }
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

    const updatePeerConnectionStatus = useCallback((remoteId, patch) => {
        if (!remoteId) return;

        setConnectionStatus(prev => {
            const current = prev[remoteId] || {
                status: PEER_CHANNEL_STATUS.DISCONNECTED,
                networkType: null,
                localType: null,
                remoteType: null,
                lastPeerActivityAt: 0,
                lastPeerActivitySource: '',
                lastHeartbeatSentAt: 0,
                staleSince: 0
            };
            const nextPatch = typeof patch === 'function' ? patch(current) : patch;
            return {
                ...prev,
                [remoteId]: {
                    ...current,
                    ...nextPatch
                }
            };
        });
    }, []);

    const removePeerConnectionStatus = useCallback((remoteId) => {
        if (!remoteId) return;

        setConnectionStatus(prev => {
            if (!prev[remoteId]) {
                return prev;
            }
            const next = { ...prev };
            delete next[remoteId];
            return next;
        });
    }, []);

    const markPeerChannelAlive = useCallback((remoteId, source = 'datachannel') => {
        if (!remoteId) return;

        const now = Date.now();
        const previous = connectionStatusRef.current[remoteId];
        updatePeerConnectionStatus(remoteId, {
            status: PEER_CHANNEL_STATUS.CONNECTED,
            lastPeerActivityAt: now,
            lastPeerActivitySource: source,
            staleSince: 0
        });

        if (previous?.status === PEER_CHANNEL_STATUS.STALE) {
            diagnostics.recordEvent('peer_channel_resumed', {
                remoteId,
                source,
                idleForMs: previous.staleSince ? now - previous.staleSince : null
            });
        }
    }, [diagnostics, updatePeerConnectionStatus]);

    const isPeerChannelAvailable = useCallback((status) => (
        status === PEER_CHANNEL_STATUS.CONNECTED || status === PEER_CHANNEL_STATUS.STALE
    ), []);

    const getSignalPresence = useCallback((userId) => {
        if (!userId) {
            return 'unknown';
        }
        if (wsStatusRef.current !== WS_STATUS.CONNECTED) {
            return 'unknown';
        }
        return onlineUsersRef.current.has(userId) ? 'online' : 'offline';
    }, []);

    const clearPeerRecoveryTimer = useCallback((remoteId) => {
        const peer = peersRef.current[remoteId];
        if (peer?.iceRestartTimer) {
            clearTimeout(peer.iceRestartTimer);
            peer.iceRestartTimer = null;
        }
    }, []);

    const resetPeerRecoveryState = useCallback((remoteId, { resetAttempts = false } = {}) => {
        const peer = peersRef.current[remoteId];
        if (!peer) {
            return;
        }

        clearPeerRecoveryTimer(remoteId);
        peer.iceRestartInFlight = false;
        peer.pendingRestartReason = '';
        if (resetAttempts) {
            peer.iceRestartAttempts = 0;
        }
    }, [clearPeerRecoveryTimer]);

    const shouldInitiatePeerConnection = useCallback((remoteId) => {
        const localId = myIdRef.current;
        if (!localId || !remoteId || localId === remoteId) {
            return false;
        }

        // 用稳定的 ID 排序来决定谁先发 offer，避免双方刷新时同时发起协商。
        return localId.localeCompare(remoteId) > 0;
    }, []);

    const isActivePeerInstance = useCallback((remoteId, instanceId) => {
        return peersRef.current[remoteId]?.instanceId === instanceId;
    }, []);

    const cleanupPeerConnection = useCallback((remoteId, { removeStatus = true } = {}) => {
        const peer = peersRef.current[remoteId];

        if (connectionTimeoutRef.current[remoteId]) {
            clearTimeout(connectionTimeoutRef.current[remoteId]);
            delete connectionTimeoutRef.current[remoteId];
        }

        if (peer?.iceRestartTimer) {
            clearTimeout(peer.iceRestartTimer);
        }

        if (peer?.dc) {
            peer.dc.onopen = null;
            peer.dc.onclose = null;
            peer.dc.onerror = null;
            peer.dc.onmessage = null;
            try {
                peer.dc.close();
            } catch {
                // 忽略已经关闭的 DataChannel。
            }
        }

        if (peer?.pc) {
            peer.pc.ondatachannel = null;
            peer.pc.onicecandidate = null;
            peer.pc.oniceconnectionstatechange = null;
            peer.pc.onconnectionstatechange = null;
            try {
                peer.pc.close();
            } catch {
                // 忽略已经关闭的 PeerConnection。
            }
        }

        delete peersRef.current[remoteId];
        delete eventQueueRef.current[remoteId];
        delete incomingFilesRef.current[remoteId];
        delete pendingIceCandidatesRef.current[remoteId];

        if (removeStatus) {
            removePeerConnectionStatus(remoteId);
            return;
        }

        updatePeerConnectionStatus(remoteId, {
            status: PEER_CHANNEL_STATUS.DISCONNECTED,
            networkType: null,
            localType: null,
            remoteType: null,
            lastPeerActivityAt: 0,
            lastPeerActivitySource: '',
            lastHeartbeatSentAt: 0,
            staleSince: 0
        });
    }, [incomingFilesRef, removePeerConnectionStatus, updatePeerConnectionStatus]);

    const queuePendingIceCandidate = useCallback((remoteId, candidate) => {
        if (!remoteId || !candidate) {
            return;
        }

        if (!pendingIceCandidatesRef.current[remoteId]) {
            pendingIceCandidatesRef.current[remoteId] = [];
        }
        pendingIceCandidatesRef.current[remoteId].push(candidate);
    }, []);

    const flushPendingIceCandidates = useCallback(async (remoteId) => {
        const peer = peersRef.current[remoteId];
        const queued = pendingIceCandidatesRef.current[remoteId];

        if (!peer?.pc || !peer.pc.remoteDescription || !queued?.length) {
            return;
        }

        const remaining = [];
        for (const candidate of queued) {
            try {
                await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                diagnostics.reportIssue('queued_ice_candidate_apply_failed', {
                    remoteId,
                    message: error?.message || 'unknown',
                    name: error?.name || 'Error'
                }, {
                    delayMs: 1500,
                    context: {
                        feature: 'ice-candidate'
                    }
                });
                remaining.push(candidate);
            }
        }

        if (remaining.length > 0) {
            pendingIceCandidatesRef.current[remoteId] = remaining;
        } else {
            delete pendingIceCandidatesRef.current[remoteId];
        }
    }, [diagnostics]);

    const sendPeerOffer = useCallback(async (remoteId, { iceRestart = false, reason = 'offer' } = {}) => {
        const peer = peersRef.current[remoteId];
        if (!peer?.pc) {
            return false;
        }

        const pc = peer.pc;
        if (pc.signalingState !== 'stable') {
            diagnostics.reportIssue('peer_offer_blocked_unstable_signaling', {
                remoteId,
                signalingState: pc.signalingState,
                iceRestart,
                reason
            }, {
                delayMs: 1500,
                context: {
                    feature: 'webrtc-offer'
                }
            });
            return false;
        }

        if (iceRestart && typeof pc.restartIce === 'function') {
            pc.restartIce();
        }

        try {
            peer.makingOffer = true;
            const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
            const offerPayload = {
                type: offer?.type || '',
                sdp: offer?.sdp || ''
            };

            if (!offerPayload.type || !offerPayload.sdp) {
                throw new Error('local_offer_description_missing');
            }

            await pc.setLocalDescription(offer);

            const finalDescription = pc.localDescription?.type && pc.localDescription?.sdp
                ? {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp
                }
                : offerPayload;

            const sent = sendSignal('offer', remoteId, {
                ...finalDescription,
                iceRestart,
                restartReason: reason,
                restartAttempt: peer.iceRestartAttempts || 0
            });

            if (!sent) {
                throw new Error('signaling_unavailable');
            }

            diagnostics.recordEvent(iceRestart ? 'ice_restart_offer_sent' : 'webrtc_offer_sent', {
                remoteId,
                reason,
                restartAttempt: peer.iceRestartAttempts || 0
            });
            return true;
        } catch (error) {
            if (iceRestart) {
                peer.iceRestartInFlight = false;
            }
            diagnostics.reportIssue(iceRestart ? 'ice_restart_offer_failed' : 'webrtc_offer_create_failed', {
                remoteId,
                message: error?.message || 'unknown',
                name: error?.name || 'Error',
                signalingState: pc.signalingState,
                reason
            }, {
                delayMs: 1500,
                context: {
                    feature: iceRestart ? 'ice-restart' : 'webrtc-offer'
                }
            });
            return false;
        } finally {
            if (peersRef.current[remoteId] === peer) {
                peer.makingOffer = false;
            }
        }
    }, [diagnostics]);

    const scheduleIceRestart = useCallback((remoteId, reason, delayMs = 1500) => {
        const peer = peersRef.current[remoteId];
        if (!peer?.pc || !peer.isInitiator) {
            return;
        }

        if (peer.iceRestartInFlight || peer.iceRestartTimer) {
            return;
        }

        peer.pendingRestartReason = reason;
        diagnostics.recordEvent('ice_restart_scheduled', {
            remoteId,
            reason,
            delayMs
        });
        peer.iceRestartTimer = setTimeout(async () => {
            peer.iceRestartTimer = null;

            const latestPeer = peersRef.current[remoteId];
            if (!latestPeer?.pc) {
                return;
            }

            const state = latestPeer.pc.iceConnectionState;
            if (!['failed', 'disconnected'].includes(state)) {
                return;
            }

            if (wsRef.current?.readyState !== WebSocket.OPEN) {
                diagnostics.recordEvent('ice_restart_waiting_for_signal', {
                    remoteId,
                    reason,
                    state
                });
                return;
            }

            latestPeer.iceRestartInFlight = true;
            latestPeer.iceRestartAttempts = (latestPeer.iceRestartAttempts || 0) + 1;
            latestPeer.pendingRestartReason = reason;

            const sent = await sendPeerOffer(remoteId, {
                iceRestart: true,
                reason
            });

            if (!sent) {
                latestPeer.iceRestartInFlight = false;
                scheduleIceRestart(remoteId, `${reason}_retry`, 3000);
                return;
            }

            latestPeer.iceRestartTimer = setTimeout(() => {
                const retryPeer = peersRef.current[remoteId];
                if (!retryPeer?.pc) {
                    return;
                }

                retryPeer.iceRestartTimer = null;
                if (
                    retryPeer.iceRestartInFlight &&
                    ['failed', 'disconnected'].includes(retryPeer.pc.iceConnectionState)
                ) {
                    retryPeer.iceRestartInFlight = false;
                    scheduleIceRestart(remoteId, `${reason}_watchdog_retry`, 0);
                }
            }, 8000);
        }, delayMs);
    }, [diagnostics, sendPeerOffer]);

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

        setWsStatus(WS_STATUS.DISCONNECTED);
        
        Object.entries(peersRef.current).forEach(([remoteId, peer]) => {
            if (peer.iceRestartTimer) {
                clearTimeout(peer.iceRestartTimer);
            }
            if (peer.dc) peer.dc.close();
            if (peer.pc) peer.pc.close();
            delete pendingIceCandidatesRef.current[remoteId];
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
        const heartbeatTimer = setInterval(() => {
            const now = Date.now();

            Object.entries(peersRef.current).forEach(([remoteId, peer]) => {
                const channel = peer?.dc;
                if (!channel || channel.readyState !== 'open') {
                    return;
                }

                try {
                    channel.send(JSON.stringify({
                        type: PEER_HEARTBEAT_MESSAGE_TYPE,
                        sentAt: now
                    }));
                    updatePeerConnectionStatus(remoteId, {
                        lastHeartbeatSentAt: now
                    });
                } catch (error) {
                    diagnostics.reportIssue('peer_heartbeat_send_failed', {
                        remoteId,
                        message: error?.message || 'unknown',
                        readyState: channel.readyState
                    }, {
                        delayMs: 1500,
                        context: {
                            feature: 'datachannel-heartbeat'
                        }
                    });
                }
            });
        }, PEER_HEARTBEAT_INTERVAL_MS);

        const staleSweepTimer = setInterval(() => {
            const now = Date.now();

            Object.entries(peersRef.current).forEach(([remoteId, peer]) => {
                const channel = peer?.dc;
                if (!channel || channel.readyState !== 'open') {
                    return;
                }

                const info = connectionStatusRef.current[remoteId];
                const lastPeerActivityAt = info?.lastPeerActivityAt || 0;
                if (!lastPeerActivityAt) {
                    return;
                }

                const idleForMs = now - lastPeerActivityAt;
                if (
                    idleForMs >= PEER_STALE_THRESHOLD_MS &&
                    info?.status === PEER_CHANNEL_STATUS.CONNECTED
                ) {
                    updatePeerConnectionStatus(remoteId, {
                        status: PEER_CHANNEL_STATUS.STALE,
                        staleSince: info?.staleSince || now
                    });
                    diagnostics.recordEvent('peer_channel_idle', {
                        remoteId,
                        idleForMs
                    });
                }
            });
        }, PEER_STALE_SWEEP_INTERVAL_MS);

        return () => {
            clearInterval(heartbeatTimer);
            clearInterval(staleSweepTimer);
        };
    }, [diagnostics, updatePeerConnectionStatus]);

    useEffect(() => {
        let isMounted = true;

        // 页面可见性变化监听
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // 页面隐藏时标记为手动关闭，避免自动重连
                isManualCloseRef.current = true;
            }
        };
        
        document.addEventListener('visibilitychange', handleVisibilityChange);

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
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            cleanupConnections();
            // 清理所有 Blob URLs
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

    useEffect(() => {
        if (wsStatus !== WS_STATUS.CONNECTED) {
            return;
        }

        Object.entries(peersRef.current).forEach(([remoteId, peer]) => {
            if (!peer?.pc || !peer.isInitiator) {
                return;
            }

            if (['failed', 'disconnected'].includes(peer.pc.iceConnectionState)) {
                scheduleIceRestart(remoteId, 'signal_restored', 800);
            }
        });
    }, [scheduleIceRestart, wsStatus]);

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
    
    const joinRoom = (roomId, currentUserId = myIdRef.current) => {
        if (!roomId.trim() || !currentUserId) return;
        
        // 记录当前房间当前窗口的已读时间
        if (currentRoom && activeUser !== undefined) {
            const key = activeUser === null ? '__global__' : activeUser;
            setLastReadTime(prev => ({
                ...prev,
                [key]: Date.now()
            }));
        }
        
        cleanupConnections();
        
        // 加载该房间的聊天历史
        const history = loadChatHistory(roomId);
        setChatHistory(history);
        
        if (history.length > 0) {
            log(`Loaded ${history.length} messages from history`);
        }
        
        // 清空未读计数（切换房间时）
        setUnreadCounts({});
        
        setOnlineUsers(new Set([currentUserId]));
        setCurrentRoom(roomId);
        setShowRoomInput(false);
        localStorage.setItem('lastRoom', roomId);
        
        // 连接到新房间，传递 isPrivate 参数
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
        
        // 重置私有房间选项
        setIsPrivate(false);
    };

    const reconnectTimeoutRef = useRef(null);
    const isManualCloseRef = useRef(false);
    
    const connectWs = (url, { isReconnect = false } = {}) => {
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
        
        setWsStatus(isReconnect ? WS_STATUS.RECONNECTING : WS_STATUS.CONNECTING);
        const ws = new WebSocket(url);
        wsRef.current = ws;
        isManualCloseRef.current = false;

        ws.onopen = () => {
            log("Connected to Signaling Server");
            // 连接成功，清除重连标记
            reconnectTimeoutRef.current = null;
            setWsStatus(WS_STATUS.CONNECTED);
            diagnostics.recordEvent('ws_opened', {
                url
            });
        };

        ws.onmessage = async (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                await handleSignalMessage(msg);
            } catch (err) {
                console.error('Failed to parse WebSocket message:', err);
                diagnostics.reportIssue('ws_message_parse_failed', {
                    message: err?.message || 'unknown'
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'websocket'
                    }
                });
            }
        };
        
        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            diagnostics.reportIssue('ws_error', {
                url,
                message: error?.message || 'WebSocket error event'
            }, {
                delayMs: 1000,
                context: {
                    feature: 'websocket'
                }
            });
        };
        
        ws.onclose = (event) => {
            const closeData = {
                url,
                code: event.code,
                wasClean: event.wasClean,
                reason: event.reason
            };
            const isManualOrHiddenClose = isManualCloseRef.current || document.hidden;
            const isAbnormalClose = event.code !== 1000 && !isManualOrHiddenClose;

            if (isAbnormalClose) {
                diagnostics.recordEvent('ws_closed', closeData);

                const now = Date.now();
                const burst = wsCloseBurstRef.current;
                if (
                    !burst.windowStartedAt ||
                    now - burst.windowStartedAt > WS_CLOSE_REPORT_WINDOW_MS
                ) {
                    burst.count = 1;
                    burst.windowStartedAt = now;
                } else {
                    burst.count += 1;
                }

                if (burst.count >= WS_CLOSE_REPORT_THRESHOLD) {
                    diagnostics.reportIssue('ws_closed_repeatedly', {
                        ...closeData,
                        repeatedCount: burst.count,
                        windowMs: WS_CLOSE_REPORT_WINDOW_MS
                    }, {
                        delayMs: 1500,
                        context: {
                            feature: 'websocket'
                        }
                    });
                    burst.count = 0;
                    burst.windowStartedAt = now;
                }
            }

            // 如果是手动关闭或页面卸载，不自动重连
            if (isManualOrHiddenClose) {
                setWsStatus(WS_STATUS.DISCONNECTED);
                log("Connection closed");
                return;
            }
            
            // 只有在非正常关闭时才重连
            if (event.code !== 1000) {
                setWsStatus(WS_STATUS.RECONNECTING);
                log("Connection lost. Reconnecting in 3 seconds...");
                reconnectTimeoutRef.current = setTimeout(() => {
                    // 确保当前没有活跃连接
                    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
                        void (async () => {
                            try {
                                await refreshAnonymousSession({
                                    quiet: true,
                                    reason: 'ws_reconnect'
                                });
                            } catch {
                                // 后端如果此时还没起来，继续按原来的重连节奏尝试即可。
                            }

                            connectWs(url, { isReconnect: true });
                        })();
                    }
                }, 3000);
            } else {
                setWsStatus(WS_STATUS.DISCONNECTED);
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
                if (peersRef.current[from]) {
                    log(`User ${from} rejoined, resetting stale peer state`);
                    cleanupPeerConnection(from, {
                        removeStatus: false
                    });
                }
                updatePeerConnectionStatus(from, {
                    status: PEER_CHANNEL_STATUS.CONNECTING
                });
                if (shouldInitiatePeerConnection(from)) {
                    await createPeerConnection(from, true);
                }
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
                        if (shouldInitiatePeerConnection(id)) {
                            void createPeerConnection(id, true);
                        } else {
                            updatePeerConnectionStatus(id, {
                                status: PEER_CHANNEL_STATUS.CONNECTING
                            });
                        }
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
                cleanupPeerConnection(from);
                // 如果正在与该用户私聊，切回全局聊天
                if (activeUser === from) {
                    switchToUser(null);
                    log(`User ${from} left. Switched to Global Chat.`);
                }
                break;
            case 'offer':
                if (payload?.type !== 'offer' || !payload?.sdp) {
                    diagnostics.reportIssue('webrtc_offer_payload_invalid', {
                        from,
                        receivedType: payload?.type ?? null,
                        hasSdp: Boolean(payload?.sdp)
                    }, {
                        delayMs: 1500,
                        context: {
                            feature: 'webrtc-offer'
                        }
                    });
                    break;
                }
                await createPeerConnection(from, false);
                try {
                    const peer = peersRef.current[from];
                    if (!peer?.pc) {
                        break;
                    }
                    const pc = peer.pc;
                    if (pc.signalingState !== 'stable') {
                        await pc.setLocalDescription({ type: 'rollback' });
                    }
                    await pc.setRemoteDescription(new RTCSessionDescription({
                        type: payload.type,
                        sdp: payload.sdp
                    }));
                    await flushPendingIceCandidates(from);
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    sendSignal('answer', from, {
                        ...answer,
                        iceRestart: payload?.iceRestart === true,
                        restartReason: payload?.restartReason || ''
                    });
                    if (payload?.iceRestart) {
                        diagnostics.recordEvent('ice_restart_offer_handled', {
                            remoteId: from,
                            restartReason: payload?.restartReason || 'unknown',
                            restartAttempt: payload?.restartAttempt || 0
                        });
                    }
                } catch (error) {
                    diagnostics.reportIssue('webrtc_offer_handle_failed', {
                        from,
                        message: error?.message || 'unknown',
                        name: error?.name || 'Error'
                    }, {
                        delayMs: 1500,
                        context: {
                            feature: 'webrtc-offer'
                        }
                    });
                }
                break;
            case 'answer':
                 if (payload?.type !== 'answer' || !payload?.sdp) {
                     diagnostics.reportIssue('webrtc_answer_payload_invalid', {
                         from,
                         receivedType: payload?.type ?? null,
                         hasSdp: Boolean(payload?.sdp)
                     }, {
                         delayMs: 1500,
                         context: {
                             feature: 'webrtc-answer'
                         }
                     });
                     break;
                 }

                 if (peersRef.current[from]) {
                     try {
                         await peersRef.current[from].pc.setRemoteDescription(new RTCSessionDescription({
                             type: payload.type,
                             sdp: payload.sdp
                         }));
                         await flushPendingIceCandidates(from);
                         if (payload?.iceRestart) {
                             diagnostics.recordEvent('ice_restart_answer_received', {
                                 remoteId: from,
                                 restartReason: payload?.restartReason || 'unknown'
                             });
                         }
                         resetPeerRecoveryState(from);
                     } catch (error) {
                         diagnostics.reportIssue('webrtc_answer_handle_failed', {
                             from,
                             message: error?.message || 'unknown',
                             name: error?.name || 'Error'
                         }, {
                             delayMs: 1500,
                             context: {
                                 feature: 'webrtc-answer'
                             }
                         });
                     }
                 }
                break;
            case 'candidate':
                 if (!peersRef.current[from]) {
                     queuePendingIceCandidate(from, payload);
                     diagnostics.recordEvent('ice_candidate_buffered', {
                         remoteId: from,
                         reason: 'missing_peer'
                     });
                     break;
                 }

                 if (peersRef.current[from]) {
                     const pc = peersRef.current[from].pc;
                     if (!pc.remoteDescription) {
                         queuePendingIceCandidate(from, payload);
                         diagnostics.recordEvent('ice_candidate_buffered', {
                             remoteId: from,
                             reason: 'missing_remote_description'
                         });
                         break;
                     }

                     try {
                         await pc.addIceCandidate(new RTCIceCandidate(payload));
                     } catch (error) {
                         diagnostics.reportIssue('ice_candidate_apply_failed', {
                             from,
                             message: error?.message || 'unknown',
                             name: error?.name || 'Error'
                         }, {
                             delayMs: 1500,
                             context: {
                                 feature: 'ice-candidate'
                             }
                         });
                     }
                 }
                break;
            case 'file-done':
                // 文件传输完成
                const transfer = incomingFilesRef.current[from]?.[payload.fileId];
                if (transfer) {
                    log(`✅ File received: ${transfer.meta.name}`);
                    
                    // 关闭 writer（如果有）
                    if (transfer.writer) {
                        await transfer.writer.close();
                    }
                    
                    // 创建 Blob URL
                    let fileUrl = null;
                    if (transfer.chunks && transfer.chunks.length > 0) {
                        const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                        fileUrl = URL.createObjectURL(blob);
                        blobUrlsRef.current.add(fileUrl);
                    } else {
                        log(`⚠️ Warning: No chunks data for ${transfer.meta.name}`);
                    }
                    
                    // 添加到聊天记录
                    if (fileUrl) {
                        const fileMsg = {
                            type: 'file',
                            name: transfer.meta.name,
                            data: fileUrl,
                            mode: transfer.meta.mode || 'broadcast',
                            savedToDisk: false
                        };
                        addChat({ from, ...fileMsg });
                    }
                    
                    delete incomingFilesRef.current[from][payload.fileId];
                    delete transferControlRef.current[`down-${payload.fileId}`];
                }
                break;
            case 'file-start':
                await initFileReceive(from, payload);
                break;
        }
    };

    const createPeerConnection = async (remoteId, initiator) => {
        if (peersRef.current[remoteId]) return;
        diagnostics.recordEvent('peer_connection_creating', {
            remoteId,
            initiator
        });

        const instanceId = ++peerInstanceCounterRef.current;

        // 清除之前的超时定时器（如果存在）
        if (connectionTimeoutRef.current[remoteId]) {
            clearTimeout(connectionTimeoutRef.current[remoteId]);
        }

        // 设置连接状态为连接中
        updatePeerConnectionStatus(remoteId, {
            status: PEER_CHANNEL_STATUS.CONNECTING
        });
        
        // 设置连接超时（30秒）
        connectionTimeoutRef.current[remoteId] = setTimeout(() => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            const peer = peersRef.current[remoteId];
            if (peer && (!peer.dc || peer.dc.readyState !== 'open')) {
                log(`Connection timeout with ${remoteId}, retrying...`);
                diagnostics.reportIssue('peer_connection_timeout', {
                    remoteId,
                    initiator
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'peer-connection'
                    }
                });

                cleanupPeerConnection(remoteId, {
                    removeStatus: false
                });
                
                // 如果我们是发起方，尝试重新连接
                if (initiator) {
                    log(`Initiating reconnection with ${remoteId} after timeout...`);
                    setTimeout(() => {
                        createPeerConnection(remoteId, true);
                    }, 1000);
                }
            }
        }, 30000); // 30秒超时

        const pc = new RTCPeerConnection(rtcConfig);
        let dc;

        peersRef.current[remoteId] = {
            instanceId,
            pc,
            dc: null,
            isInitiator: initiator,
            iceRestartTimer: null,
            iceRestartInFlight: false,
            iceRestartAttempts: 0,
            pendingRestartReason: '',
            makingOffer: false
        };

        if (initiator) {
            // 配置 DataChannel 以优化大文件传输
            dc = pc.createDataChannel("chat", {
                ordered: true,  // 保证顺序，文件传输需要
                maxRetransmits: undefined  // 可靠传输
            });
            peersRef.current[remoteId].dc = dc;
            setupDataChannel(dc, remoteId, instanceId);
        } else {
            pc.ondatachannel = (e) => {
                if (!isActivePeerInstance(remoteId, instanceId)) {
                    try {
                        e.channel.close();
                    } catch {
                        // 忽略已关闭通道。
                    }
                    return;
                }
                setupDataChannel(e.channel, remoteId, instanceId);
            };
        }
        
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
                                        updatePeerConnectionStatus(remoteId, {
                                            status: PEER_CHANNEL_STATUS.CONNECTED,
                                            networkType,
                                            localAddress,
                                            remoteAddress,
                                            localType,
                                            remoteType
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            }).catch(err => {
                console.error('Failed to get connection stats:', err);
                diagnostics.reportIssue('peer_stats_capture_failed', {
                    remoteId,
                    message: err?.message || 'unknown'
                }, {
                    delayMs: 1500,
                    context: {
                        feature: 'peer-stats'
                    }
                });
            });
        };

        pc.onicecandidate = (e) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
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
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            const state = pc.iceConnectionState;
            log(`ICE connection state with ${remoteId}: ${state}`);
            
            if (state === 'failed' || state === 'disconnected') {
                log(`Connection ${state} with ${remoteId}, attempting ICE restart...`);
                diagnostics.reportIssue('ice_connection_unstable', {
                    remoteId,
                    state
                }, {
                    delayMs: 1500,
                    context: {
                        feature: 'ice-state'
                    }
                });
                void diagnostics.capturePeerStats({
                    peerId: remoteId,
                    pc,
                    peerType: 'webrtc',
                    scopeType: 'call'
                });

                updatePeerConnectionStatus(remoteId, {
                    status: PEER_CHANNEL_STATUS.STALE
                });
                scheduleIceRestart(
                    remoteId,
                    state === 'failed' ? 'ice_failed' : 'ice_disconnected',
                    state === 'failed' ? 500 : 2000
                );
            } else if (state === 'connected' || state === 'completed') {
                log(`ICE connection established with ${remoteId}`);
                diagnostics.recordEvent('ice_connection_established', {
                    remoteId,
                    state
                });
                resetPeerRecoveryState(remoteId, { resetAttempts: true });
                markPeerChannelAlive(remoteId, 'ice_connected');
                // ICE连接稳定后，延迟500ms检测网络类型（等待候选者对最终确定）
                setTimeout(() => {
                    if (peersRef.current[remoteId]) {
                        void diagnostics.capturePeerStats({
                            peerId: remoteId,
                            pc,
                            peerType: 'webrtc',
                            scopeType: 'call'
                        });
                        detectNetworkType();
                    }
                }, 500);
            }
        };
        
        // 监听整体连接状态
        pc.onconnectionstatechange = () => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            const state = pc.connectionState;
            log(`Connection state with ${remoteId}: ${state}`);
            
            if (state === 'failed') {
                log(`Connection failed with ${remoteId}`);
                diagnostics.reportIssue('peer_connection_failed', {
                    remoteId
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'peer-connection'
                    }
                });
                void diagnostics.capturePeerStats({
                    peerId: remoteId,
                    pc,
                    peerType: 'webrtc',
                    scopeType: 'call'
                });
                updatePeerConnectionStatus(remoteId, {
                    status: PEER_CHANNEL_STATUS.STALE
                });
                scheduleIceRestart(remoteId, 'peer_connection_failed', 500);
            }
        };

        if (initiator) {
            if (isActivePeerInstance(remoteId, instanceId)) {
                await sendPeerOffer(remoteId, {
                    iceRestart: false,
                    reason: 'initial_offer'
                });
            }
        }
    };

    const setupDataChannel = (dc, remoteId, instanceId) => {
        if (!isActivePeerInstance(remoteId, instanceId)) {
            return;
        }

        if (peersRef.current[remoteId]) {
            peersRef.current[remoteId].dc = dc;
        }
        
        // 重要：设置为 arraybuffer 以便接收二进制数据
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 0;

        dc.onopen = () => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            log(`Connected to ${remoteId}`);
            diagnostics.recordEvent('datachannel_opened', {
                remoteId
            });
            // 清除连接超时定时器
            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }
            // 更新连接状态为已连接（先设置基本状态）
            updatePeerConnectionStatus(remoteId, {
                status: PEER_CHANNEL_STATUS.CONNECTED,
                lastPeerActivityAt: Date.now(),
                lastPeerActivitySource: 'datachannel_open',
                staleSince: 0
            });
            // 注意：网络类型检测移到 ICE 状态变化监听中，等待连接稳定后再检测
        };
        
        dc.onclose = () => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            log(`DataChannel closed with ${remoteId}`);
            diagnostics.recordEvent('datachannel_closed', {
                remoteId
            }, {
                flush: true,
                delayMs: 1000,
                reason: 'datachannel_closed'
            });
            // 清除连接超时定时器
            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }
            // 更新连接状态为已断开
            updatePeerConnectionStatus(remoteId, {
                status: PEER_CHANNEL_STATUS.DISCONNECTED
            });
            // 清理该用户的事件队列
            delete eventQueueRef.current[remoteId];
        };
        
        dc.onerror = (error) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            // DataChannel 错误通常是连接断开或关闭时的正常现象
            // 只有在 DataChannel 处于 open 状态时才是真正的错误
            if (dc.readyState === 'open' || dc.readyState === 'connecting') {
                console.warn(`DataChannel error with ${remoteId}:`, error);
                log(`⚠️ Connection issue with ${remoteId}`);
                diagnostics.reportIssue('datachannel_error', {
                    remoteId,
                    readyState: dc.readyState,
                    message: error?.message || 'DataChannel error'
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'datachannel'
                    }
                });
            }
            // readyState 为 'closing' 或 'closed' 时是正常清理，忽略
        };
        
        // 创建事件队列保证接收顺序
        if (!eventQueueRef.current[remoteId]) {
            eventQueueRef.current[remoteId] = createEventQueue();
        }
        
        dc.onmessage = (e) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }
            // 添加到事件队列，保证顺序处理
            eventQueueRef.current[remoteId].enqueue(() => handleMessage(remoteId, e.data));
        };
    };
    
    // 创建事件队列
    const createEventQueue = () => {
        let tail = Promise.resolve();
        return {
            enqueue: (handler) => {
                tail = tail.then(handler).catch(err => {
                    console.error('EventQueue error:', err);
                    diagnostics.reportIssue('event_queue_handler_failed', {
                        message: err?.message || 'unknown',
                        name: err?.name || 'Error'
                    }, {
                        delayMs: 1500,
                        context: {
                            feature: 'event-queue'
                        }
                    });
                });
            }
        };
    };
    
    const handleMessage = async (remoteId, data) => {
        // 1. 处理二进制 chunk
        if (data instanceof ArrayBuffer) {
            markPeerChannelAlive(remoteId, 'binary_chunk');
            handleBinaryChunk(remoteId, data);
            return;
        }
        
        // 2. 处理 JSON 消息
        try {
            const msg = JSON.parse(data);
            if (msg.type === PEER_HEARTBEAT_MESSAGE_TYPE) {
                markPeerChannelAlive(remoteId, 'heartbeat');
                return;
            }

            markPeerChannelAlive(remoteId, 'datachannel_message');
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
                // 文件传输完成
                const transfer = incomingFilesRef.current[remoteId]?.[msg.fileId];
                if (transfer) {
                    log(`✅ File received: ${transfer.meta.name}`);
                    
                    // 关闭 writer（如果有）
                    if (transfer.writer) {
                        await transfer.writer.close();
                    }
                    
                    // 创建 Blob URL
                    let fileUrl = null;
                    if (transfer.chunks && transfer.chunks.length > 0) {
                        const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
                        fileUrl = URL.createObjectURL(blob);
                        blobUrlsRef.current.add(fileUrl);
                    } else {
                        log(`⚠️ Warning: No chunks data for ${transfer.meta.name}`);
                    }
                    
                    // 添加到聊天记录
                    if (fileUrl) {
                        const fileMsg = {
                            type: 'file',
                            name: transfer.meta.name,
                            data: fileUrl,
                            mode: transfer.meta.mode || 'broadcast',
                            savedToDisk: false
                        };
                        addChat({ from: remoteId, ...fileMsg });
                    }
                    
                    delete incomingFilesRef.current[remoteId][msg.fileId];
                    delete transferControlRef.current[`down-${msg.fileId}`];
                }
            } else if (msg.type === 'file-start') {
                await initFileReceive(remoteId, msg);
            } else if (Object.values(CALL_MESSAGE_TYPES).includes(msg.type) || 
                       msg.type === 'video-offer' || msg.type === 'video-answer') {
                // 处理通话相关信令（包括视频重新协商）
                handleCallSignal(msg.type, remoteId, msg);
            } else {
                // Normal chat or other signaling
                if (!msg.mode) {
                    msg.mode = 'broadcast';
                }
                addChat({ from: remoteId, ...msg });
            }
        } catch {
            diagnostics.recordEvent('datachannel_text_fallback', {
                remoteId
            });
            markPeerChannelAlive(remoteId, 'text_fallback');
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
            return true;
        }
        diagnostics.reportIssue('ws_send_while_closed', {
            type,
            to,
            readyState: wsRef.current?.readyState ?? 'missing'
        }, {
            delayMs: 1000,
            context: {
                feature: 'websocket'
            }
        });
        return false;
    };
    
    // 发送 DataChannel 消息（用于通话信令等）
    // 参数格式与 WebSocket sendSignal 保持一致: (type, targetUserId, payload)
    const sendDataChannelMessage = (type, targetUserId, payload) => {
        const peer = peersRef.current[targetUserId];
        if (peer && peer.dc && peer.dc.readyState === 'open') {
            peer.dc.send(JSON.stringify({ type, ...payload }));
            return true;
        }
        diagnostics.reportIssue('datachannel_send_unavailable', {
            type,
            targetUserId,
            readyState: peer?.dc?.readyState || 'missing'
        }, {
            delayMs: 1000,
            context: {
                feature: 'datachannel'
            }
        });
        return false;
    };
    
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
        handleCallSignal,
        cleanupCall
    } = useVideoCall({
        peersRef,
        sendSignal: sendDataChannelMessage, // 通话信令通过 DataChannel 发送
        log,
        myId: myIdRef.current,
        getDisplayName,
        diagnostics
    });

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
                    const { dc } = peersRef.current[id];
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
                                                            fileId: controlKey.replace(/^up-/, '')
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
                                                            fileId: controlKey.replace(/^up-/, '')
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
