import { useState, useRef, useCallback } from 'react';

/**
 * 通话状态枚举
 */
export const CALL_STATUS = {
    IDLE: 'idle',           // 空闲
    CALLING: 'calling',     // 呼叫中（等待对方接听）
    INCOMING: 'incoming',   // 来电中
    CONNECTED: 'connected', // 通话中
    ENDING: 'ending'        // 结束中
};

/**
 * 通话消息类型
 */
export const CALL_MESSAGE_TYPES = {
    CALL_REQUEST: 'call-request',     // 发起通话请求
    CALL_ACCEPT: 'call-accept',       // 接受通话
    CALL_REJECT: 'call-reject',       // 拒绝通话
    CALL_END: 'call-end',             // 结束通话
    CALL_BUSY: 'call-busy',           // 对方忙线
    TOGGLE_VIDEO: 'toggle-video',     // 切换视频开关状态
    TOGGLE_AUDIO: 'toggle-audio',     // 切换音频开关状态
    SCREEN_SHARE_START: 'screen-share-start',  // 开始屏幕共享
    SCREEN_SHARE_STOP: 'screen-share-stop'     // 停止屏幕共享
};

/**
 * 音视频通话 Hook
 * @param {Object} options
 * @param {Object} options.peersRef - PeerConnection 引用
 * @param {Function} options.sendSignal - 发送信令的函数
 * @param {Function} options.log - 日志函数
 * @param {string} options.myId - 当前用户 ID
 * @param {Function} options.getDisplayName - 获取显示名称的函数
 */
export function useVideoCall({ peersRef, sendSignal, log, myId, getDisplayName }) {
    // 通话状态
    const [callStatus, setCallStatus] = useState(CALL_STATUS.IDLE);
    const [remoteUser, setRemoteUser] = useState(null); // 通话对方
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [remoteVideoEnabled, setRemoteVideoEnabled] = useState(true);
    const [remoteAudioEnabled, setRemoteAudioEnabled] = useState(true);
    
    // 媒体流引用
    const localStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const originalVideoTrackRef = useRef(null); // 保存原始摄像头轨道，用于切换回来
    
    // 来电铃声
    const ringtoneRef = useRef(null);
    
    /**
     * 获取本地媒体流
     */
    const getLocalStream = useCallback(async (video = true, audio = true) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: video ? {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                } : false,
                audio: audio ? {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } : false
            });
            localStreamRef.current = stream;
            return stream;
        } catch (error) {
            log(`❌ 获取媒体设备失败: ${error.message}`);
            throw error;
        }
    }, [log]);
    
    /**
     * 添加媒体轨道到 PeerConnection
     */
    const addTracksToConnection = useCallback((stream, targetUserId) => {
        const peer = peersRef.current[targetUserId];
        if (!peer || !peer.pc) {
            log(`⚠️ 未找到与 ${targetUserId} 的连接`);
            return;
        }
        
        stream.getTracks().forEach(track => {
            peer.pc.addTrack(track, stream);
            log(`🎥 添加 ${track.kind} 轨道到连接`);
        });
    }, [peersRef, log]);
    
    /**
     * 设置远端轨道监听
     */
    const setupRemoteTrackListener = useCallback((targetUserId) => {
        const peer = peersRef.current[targetUserId];
        if (!peer || !peer.pc) return;
        
        peer.pc.ontrack = (event) => {
            log(`📹 收到远端 ${event.track.kind} 轨道`);
            if (!remoteStreamRef.current) {
                remoteStreamRef.current = new MediaStream();
            }
            remoteStreamRef.current.addTrack(event.track);
        };
    }, [peersRef, log]);
    
    /**
     * 发起通话
     */
    const startCall = useCallback(async (targetUserId, videoEnabled = true) => {
        if (callStatus !== CALL_STATUS.IDLE) {
            log('⚠️ 当前已在通话中');
            return false;
        }
        
        try {
            setCallStatus(CALL_STATUS.CALLING);
            setRemoteUser(targetUserId);
            setIsVideoEnabled(videoEnabled);
            
            // 获取本地媒体流
            const stream = await getLocalStream(videoEnabled, true);
            
            // 设置远端轨道监听
            setupRemoteTrackListener(targetUserId);
            
            // 发送通话请求信令
            sendSignal(CALL_MESSAGE_TYPES.CALL_REQUEST, targetUserId, {
                video: videoEnabled,
                callerId: myId,
                callerName: getDisplayName(myId)
            });
            
            log(`📞 正在呼叫 ${getDisplayName(targetUserId)}...`);
            return true;
        } catch (error) {
            log(`❌ 发起通话失败: ${error.message}`);
            setCallStatus(CALL_STATUS.IDLE);
            setRemoteUser(null);
            return false;
        }
    }, [callStatus, getLocalStream, setupRemoteTrackListener, sendSignal, myId, getDisplayName, log]);
    
    /**
     * 处理来电
     */
    const handleIncomingCall = useCallback((fromUserId, payload) => {
        if (callStatus !== CALL_STATUS.IDLE) {
            // 已在通话中，回复忙线
            sendSignal(CALL_MESSAGE_TYPES.CALL_BUSY, fromUserId, {});
            log(`📵 收到 ${getDisplayName(fromUserId)} 的来电，但当前忙线`);
            return;
        }
        
        setCallStatus(CALL_STATUS.INCOMING);
        setRemoteUser(fromUserId);
        setIsVideoEnabled(payload.video);
        
        log(`📲 收到来自 ${payload.callerName || fromUserId} 的${payload.video ? '视频' : '语音'}通话请求`);
        
        // 播放来电铃声（可选）
        // playRingtone();
    }, [callStatus, sendSignal, getDisplayName, log]);
    
    /**
     * 接听来电
     */
    const acceptCall = useCallback(async () => {
        if (callStatus !== CALL_STATUS.INCOMING || !remoteUser) {
            log('⚠️ 无来电可接听');
            return false;
        }
        
        try {
            // 获取本地媒体流
            const stream = await getLocalStream(isVideoEnabled, true);
            
            // 设置远端轨道监听
            setupRemoteTrackListener(remoteUser);
            
            // 添加轨道到连接
            addTracksToConnection(stream, remoteUser);
            
            // 发送接听信令
            sendSignal(CALL_MESSAGE_TYPES.CALL_ACCEPT, remoteUser, {
                video: isVideoEnabled
            });
            
            setCallStatus(CALL_STATUS.CONNECTED);
            log(`✅ 已接听 ${getDisplayName(remoteUser)} 的通话`);
            
            // 停止铃声
            // stopRingtone();
            
            return true;
        } catch (error) {
            log(`❌ 接听失败: ${error.message}`);
            rejectCall();
            return false;
        }
    }, [callStatus, remoteUser, isVideoEnabled, getLocalStream, setupRemoteTrackListener, addTracksToConnection, sendSignal, getDisplayName, log]);
    
    /**
     * 处理对方接听
     */
    const handleCallAccepted = useCallback((fromUserId, payload) => {
        if (callStatus !== CALL_STATUS.CALLING || remoteUser !== fromUserId) {
            return;
        }
        
        // 添加轨道到连接
        if (localStreamRef.current) {
            addTracksToConnection(localStreamRef.current, fromUserId);
        }
        
        setCallStatus(CALL_STATUS.CONNECTED);
        setRemoteVideoEnabled(payload.video);
        log(`✅ ${getDisplayName(fromUserId)} 已接听通话`);
    }, [callStatus, remoteUser, addTracksToConnection, getDisplayName, log]);
    
    /**
     * 拒绝来电
     */
    const rejectCall = useCallback(() => {
        if (remoteUser) {
            sendSignal(CALL_MESSAGE_TYPES.CALL_REJECT, remoteUser, {});
            log(`❌ 已拒绝 ${getDisplayName(remoteUser)} 的来电`);
        }
        
        // 停止铃声
        // stopRingtone();
        
        cleanupCall();
    }, [remoteUser, sendSignal, getDisplayName, log]);
    
    /**
     * 处理对方拒绝
     */
    const handleCallRejected = useCallback((fromUserId) => {
        if (callStatus === CALL_STATUS.CALLING && remoteUser === fromUserId) {
            log(`📵 ${getDisplayName(fromUserId)} 拒绝了通话`);
            cleanupCall();
        }
    }, [callStatus, remoteUser, getDisplayName, log]);
    
    /**
     * 结束通话
     */
    const endCall = useCallback(() => {
        if (remoteUser) {
            sendSignal(CALL_MESSAGE_TYPES.CALL_END, remoteUser, {});
            log(`📴 已结束与 ${getDisplayName(remoteUser)} 的通话`);
        }
        cleanupCall();
    }, [remoteUser, sendSignal, getDisplayName, log]);
    
    /**
     * 处理对方结束通话
     */
    const handleCallEnded = useCallback((fromUserId) => {
        if (remoteUser === fromUserId) {
            log(`📴 ${getDisplayName(fromUserId)} 结束了通话`);
            cleanupCall();
        }
    }, [remoteUser, getDisplayName, log]);
    
    /**
     * 清理通话资源
     */
    const cleanupCall = useCallback(() => {
        // 停止本地媒体流
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }
        
        // 停止屏幕共享流
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(track => track.stop());
            screenStreamRef.current = null;
        }
        
        // 清理远端流引用
        remoteStreamRef.current = null;
        originalVideoTrackRef.current = null;
        
        // 重置状态
        setCallStatus(CALL_STATUS.IDLE);
        setRemoteUser(null);
        setIsVideoEnabled(true);
        setIsAudioEnabled(true);
        setIsScreenSharing(false);
        setRemoteVideoEnabled(true);
        setRemoteAudioEnabled(true);
    }, []);
    
    /**
     * 切换视频开关
     */
    const toggleVideo = useCallback(() => {
        if (!localStreamRef.current) return;
        
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            setIsVideoEnabled(videoTrack.enabled);
            
            // 通知对方
            if (remoteUser) {
                sendSignal(CALL_MESSAGE_TYPES.TOGGLE_VIDEO, remoteUser, {
                    enabled: videoTrack.enabled
                });
            }
            
            log(`📹 视频已${videoTrack.enabled ? '开启' : '关闭'}`);
        }
    }, [remoteUser, sendSignal, log]);
    
    /**
     * 切换音频开关
     */
    const toggleAudio = useCallback(() => {
        if (!localStreamRef.current) return;
        
        const audioTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            setIsAudioEnabled(audioTrack.enabled);
            
            // 通知对方
            if (remoteUser) {
                sendSignal(CALL_MESSAGE_TYPES.TOGGLE_AUDIO, remoteUser, {
                    enabled: audioTrack.enabled
                });
            }
            
            log(`🎤 麦克风已${audioTrack.enabled ? '开启' : '静音'}`);
        }
    }, [remoteUser, sendSignal, log]);
    
    /**
     * 开始屏幕共享
     */
    const startScreenShare = useCallback(async () => {
        if (!remoteUser || callStatus !== CALL_STATUS.CONNECTED) {
            log('⚠️ 需要在通话中才能共享屏幕');
            return false;
        }
        
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: true
            });
            
            screenStreamRef.current = screenStream;
            
            // 保存原始视频轨道
            if (localStreamRef.current) {
                originalVideoTrackRef.current = localStreamRef.current.getVideoTracks()[0];
            }
            
            // 替换视频轨道
            const peer = peersRef.current[remoteUser];
            if (peer && peer.pc) {
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(screenStream.getVideoTracks()[0]);
                }
            }
            
            // 监听屏幕共享结束
            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };
            
            setIsScreenSharing(true);
            
            // 通知对方
            sendSignal(CALL_MESSAGE_TYPES.SCREEN_SHARE_START, remoteUser, {});
            
            log('🖥️ 屏幕共享已开始');
            return true;
        } catch (error) {
            log(`❌ 屏幕共享失败: ${error.message}`);
            return false;
        }
    }, [remoteUser, callStatus, peersRef, sendSignal, log]);
    
    /**
     * 停止屏幕共享
     */
    const stopScreenShare = useCallback(async () => {
        if (!isScreenSharing) return;
        
        // 停止屏幕共享流
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(track => track.stop());
            screenStreamRef.current = null;
        }
        
        // 恢复原始视频轨道
        if (originalVideoTrackRef.current && remoteUser) {
            const peer = peersRef.current[remoteUser];
            if (peer && peer.pc) {
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(originalVideoTrackRef.current);
                }
            }
        }
        
        setIsScreenSharing(false);
        
        // 通知对方
        if (remoteUser) {
            sendSignal(CALL_MESSAGE_TYPES.SCREEN_SHARE_STOP, remoteUser, {});
        }
        
        log('🖥️ 屏幕共享已停止');
    }, [isScreenSharing, remoteUser, peersRef, sendSignal, log]);
    
    /**
     * 处理通话相关信令消息
     */
    const handleCallSignal = useCallback((type, fromUserId, payload) => {
        switch (type) {
            case CALL_MESSAGE_TYPES.CALL_REQUEST:
                handleIncomingCall(fromUserId, payload);
                break;
            case CALL_MESSAGE_TYPES.CALL_ACCEPT:
                handleCallAccepted(fromUserId, payload);
                break;
            case CALL_MESSAGE_TYPES.CALL_REJECT:
                handleCallRejected(fromUserId);
                break;
            case CALL_MESSAGE_TYPES.CALL_END:
                handleCallEnded(fromUserId);
                break;
            case CALL_MESSAGE_TYPES.CALL_BUSY:
                log(`📵 ${getDisplayName(fromUserId)} 当前忙线`);
                cleanupCall();
                break;
            case CALL_MESSAGE_TYPES.TOGGLE_VIDEO:
                setRemoteVideoEnabled(payload.enabled);
                break;
            case CALL_MESSAGE_TYPES.TOGGLE_AUDIO:
                setRemoteAudioEnabled(payload.enabled);
                break;
            case CALL_MESSAGE_TYPES.SCREEN_SHARE_START:
                log(`🖥️ ${getDisplayName(fromUserId)} 开始了屏幕共享`);
                break;
            case CALL_MESSAGE_TYPES.SCREEN_SHARE_STOP:
                log(`🖥️ ${getDisplayName(fromUserId)} 停止了屏幕共享`);
                break;
        }
    }, [handleIncomingCall, handleCallAccepted, handleCallRejected, handleCallEnded, cleanupCall, getDisplayName, log]);
    
    return {
        // 状态
        callStatus,
        remoteUser,
        isVideoEnabled,
        isAudioEnabled,
        isScreenSharing,
        remoteVideoEnabled,
        remoteAudioEnabled,
        
        // 流引用
        localStreamRef,
        remoteStreamRef,
        
        // 方法
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
    };
}
