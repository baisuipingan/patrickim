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
    
    // 媒体流状态（用于触发重新渲染）
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    
    // 使用 ref 存储状态，避免闭包陷阱
    const callStatusRef = useRef(callStatus);
    const remoteUserRef = useRef(remoteUser);
    
    // 同步 ref 和 state
    callStatusRef.current = callStatus;
    remoteUserRef.current = remoteUser;
    
    // 媒体流引用（内部使用）
    const localStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const originalVideoTrackRef = useRef(null); // 保存原始摄像头轨道，用于切换回来
    
    // 来电铃声
    const ringtoneRef = useRef(null);
    
    /**
     * 获取本地媒体流（支持无摄像头/麦克风设备降级）
     */
    const getLocalStream = useCallback(async (video = true, audio = true) => {
        // 检查是否在安全上下文中
        if (!window.isSecureContext) {
            const msg = '⚠️ 摄像头/麦克风需要安全连接。请使用 localhost 或 HTTPS 访问，或在 Chrome 设置中添加例外：chrome://flags/#unsafely-treat-insecure-origin-as-secure';
            log(msg);
            alert(msg);
            throw new Error('不安全的上下文');
        }
        
        // 检查是否支持 mediaDevices API
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const msg = '❌ 浏览器不支持摄像头/麦克风访问';
            log(msg);
            alert(msg);
            throw new Error('不支持 getUserMedia');
        }
        
        let stream = null;
        
        // 尝试获取请求的媒体
        try {
            stream = await navigator.mediaDevices.getUserMedia({
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
        } catch (error) {
            log(`⚠️ 获取媒体失败 (video=${video}, audio=${audio}): ${error.message}`);
            
            // 降级处理：如果请求了视频但失败，尝试只获取音频
            if (video && audio) {
                try {
                    log('📞 尝试只获取音频...');
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: false,
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                    });
                    setIsVideoEnabled(false);
                } catch (audioError) {
                    log(`⚠️ 获取音频也失败: ${audioError.message}`);
                }
            }
            
            // 如果还是没有流，创建空的 MediaStream（仅接收模式）
            if (!stream) {
                log('📺 无本地媒体设备，进入仅接收模式');
                stream = new MediaStream();
                setIsVideoEnabled(false);
                setIsAudioEnabled(false);
            }
        }
        
        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
    }, [log]);
    
    /**
     * 添加媒体轨道到 PeerConnection 并触发重新协商
     */
    const addTracksToConnection = useCallback(async (stream, targetUserId, initiateRenegotiation = false) => {
        const peer = peersRef.current[targetUserId];
        if (!peer || !peer.pc) {
            log(`⚠️ 未找到与 ${targetUserId} 的连接`);
            return;
        }
        
        stream.getTracks().forEach(track => {
            // 检查是否已经添加过相同的轨道
            const senders = peer.pc.getSenders();
            const existingSender = senders.find(s => s.track === track);
            if (!existingSender) {
                peer.pc.addTrack(track, stream);
                log(`🎥 添加 ${track.kind} 轨道到连接`);
            }
        });
        
        // 如果需要发起重新协商（主叫方）
        if (initiateRenegotiation) {
            try {
                log(`🔄 发起 SDP 重新协商...`);
                const offer = await peer.pc.createOffer();
                await peer.pc.setLocalDescription(offer);
                // 通过 DataChannel 发送 offer
                sendSignal('video-offer', targetUserId, {
                    sdp: peer.pc.localDescription
                });
            } catch (error) {
                log(`❌ 重新协商失败: ${error.message}`);
            }
        }
    }, [peersRef, log, sendSignal]);
    
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
            setRemoteStream(remoteStreamRef.current); // 触发重新渲染
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
        // 使用 ref 获取最新状态
        if (callStatusRef.current !== CALL_STATUS.IDLE) {
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
    }, [sendSignal, getDisplayName, log]);
    
    /**
     * 清理通话资源（必须在 acceptCall/rejectCall 等函数之前定义）
     */
    const cleanupCall = useCallback(() => {
        // 移除 PeerConnection 上的媒体轨道（保留 DataChannel）
        const currentRemoteUser = remoteUserRef.current;
        if (currentRemoteUser && peersRef.current[currentRemoteUser]) {
            const pc = peersRef.current[currentRemoteUser].pc;
            if (pc) {
                // 移除所有媒体发送器
                pc.getSenders().forEach(sender => {
                    if (sender.track) {
                        pc.removeTrack(sender);
                    }
                });
                // 清除 ontrack 监听器
                pc.ontrack = null;
            }
        }
        
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
        setLocalStream(null);
        setRemoteStream(null);
    }, [peersRef]);
    
    /**
     * 接听来电
     */
    const acceptCall = useCallback(async () => {
        // 使用 ref 获取最新状态
        const currentRemoteUser = remoteUserRef.current;
        if (callStatusRef.current !== CALL_STATUS.INCOMING || !currentRemoteUser) {
            log('⚠️ 无来电可接听');
            return false;
        }
        
        try {
            // 获取本地媒体流
            const stream = await getLocalStream(isVideoEnabled, true);
            
            // 设置远端轨道监听
            setupRemoteTrackListener(currentRemoteUser);
            
            // 添加轨道到连接
            addTracksToConnection(stream, currentRemoteUser);
            
            // 发送接听信令
            sendSignal(CALL_MESSAGE_TYPES.CALL_ACCEPT, currentRemoteUser, {
                video: isVideoEnabled
            });
            
            setCallStatus(CALL_STATUS.CONNECTED);
            log(`✅ 已接听 ${getDisplayName(currentRemoteUser)} 的通话`);
            
            // 停止铃声
            // stopRingtone();
            
            return true;
        } catch (error) {
            log(`❌ 接听失败: ${error.message}`);
            // 接听失败时直接清理资源（不发拒绝信令，因为还没成功建立连接）
            cleanupCall();
            return false;
        }
    }, [isVideoEnabled, getLocalStream, setupRemoteTrackListener, addTracksToConnection, sendSignal, getDisplayName, log, cleanupCall]);
    
    /**
     * 处理对方接听
     */
    const handleCallAccepted = useCallback(async (fromUserId, payload) => {
        // 使用 ref 获取最新状态，避免闭包陷阱
        if (callStatusRef.current !== CALL_STATUS.CALLING || remoteUserRef.current !== fromUserId) {
            log(`⚠️ 忽略接听信令: status=${callStatusRef.current}, remoteUser=${remoteUserRef.current}, from=${fromUserId}`);
            return;
        }
        
        // 添加轨道到连接，并发起重新协商（发送端负责发起）
        if (localStreamRef.current) {
            await addTracksToConnection(localStreamRef.current, fromUserId, true);
        }
        
        setCallStatus(CALL_STATUS.CONNECTED);
        setRemoteVideoEnabled(payload.video);
        log(`✅ ${getDisplayName(fromUserId)} 已接听通话`);
    }, [addTracksToConnection, getDisplayName, log]);
    
    /**
     * 拒绝来电
     */
    const rejectCall = useCallback(() => {
        // 使用 ref 获取最新状态
        const currentRemoteUser = remoteUserRef.current;
        if (currentRemoteUser) {
            sendSignal(CALL_MESSAGE_TYPES.CALL_REJECT, currentRemoteUser, {});
            log(`❌ 已拒绝 ${getDisplayName(currentRemoteUser)} 的来电`);
        }
        
        // 停止铃声
        // stopRingtone();
        
        cleanupCall();
    }, [sendSignal, getDisplayName, log, cleanupCall]);
    
    /**
     * 处理对方拒绝
     */
    const handleCallRejected = useCallback((fromUserId) => {
        // 使用 ref 获取最新状态
        if (callStatusRef.current === CALL_STATUS.CALLING && remoteUserRef.current === fromUserId) {
            log(`📵 ${getDisplayName(fromUserId)} 拒绝了通话`);
            cleanupCall();
        }
    }, [getDisplayName, log, cleanupCall]);
    
    /**
     * 结束通话
     */
    const endCall = useCallback(() => {
        // 使用 ref 获取最新状态
        if (remoteUserRef.current) {
            sendSignal(CALL_MESSAGE_TYPES.CALL_END, remoteUserRef.current, {});
            log(`📴 已结束与 ${getDisplayName(remoteUserRef.current)} 的通话`);
        }
        cleanupCall();
    }, [sendSignal, getDisplayName, log, cleanupCall]);
    
    /**
     * 处理对方结束通话
     */
    const handleCallEnded = useCallback((fromUserId) => {
        // 使用 ref 获取最新状态
        if (remoteUserRef.current === fromUserId) {
            log(`📴 ${getDisplayName(fromUserId)} 结束了通话`);
            cleanupCall();
        }
    }, [getDisplayName, log, cleanupCall]);
    
    /**
     * 切换视频开关
     */
    const toggleVideo = useCallback(async () => {
        const currentRemoteUser = remoteUserRef.current;
        if (callStatusRef.current !== CALL_STATUS.CONNECTED || !currentRemoteUser) {
            log('⚠️ 需要在通话中才能切换视频');
            return;
        }
        
        const videoTrack = localStreamRef.current?.getVideoTracks()[0];
        
        if (videoTrack) {
            // 已有视频轨道，切换 enabled
            videoTrack.enabled = !videoTrack.enabled;
            setIsVideoEnabled(videoTrack.enabled);
            
            sendSignal(CALL_MESSAGE_TYPES.TOGGLE_VIDEO, currentRemoteUser, {
                enabled: videoTrack.enabled
            });
            
            log(`📹 视频已${videoTrack.enabled ? '开启' : '关闭'}`);
        } else {
            // 没有视频轨道（语音通话），需要获取摄像头并添加
            try {
                log('📹 正在开启摄像头...');
                const videoStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
                });
                
                const newVideoTrack = videoStream.getVideoTracks()[0];
                
                // 添加到本地流
                if (localStreamRef.current) {
                    localStreamRef.current.addTrack(newVideoTrack);
                } else {
                    localStreamRef.current = videoStream;
                }
                setLocalStream(localStreamRef.current);
                
                // 添加到 PeerConnection 并重新协商
                const peer = peersRef.current[currentRemoteUser];
                if (peer && peer.pc) {
                    const pc = peer.pc;
                    pc.addTrack(newVideoTrack, localStreamRef.current);
                    
                    // 重新协商
                    await new Promise(r => setTimeout(r, 100));
                    if (pc.signalingState === 'stable') {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        sendSignal('video-offer', currentRemoteUser, { sdp: pc.localDescription });
                    }
                }
                
                setIsVideoEnabled(true);
                sendSignal(CALL_MESSAGE_TYPES.TOGGLE_VIDEO, currentRemoteUser, { enabled: true });
                log('📹 摄像头已开启');
            } catch (error) {
                log(`❌ 开启摄像头失败: ${error.message}`);
            }
        }
    }, [peersRef, sendSignal, log]);
    
    /**
     * 切换音频开关
     */
    const toggleAudio = useCallback(() => {
        if (!localStreamRef.current) return;
        
        const audioTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            setIsAudioEnabled(audioTrack.enabled);
            
            // 通知对方（使用 ref 获取最新状态）
            const currentRemoteUser = remoteUserRef.current;
            if (currentRemoteUser) {
                sendSignal(CALL_MESSAGE_TYPES.TOGGLE_AUDIO, currentRemoteUser, {
                    enabled: audioTrack.enabled
                });
            }
            
            log(`🎙️ 麦克风已${audioTrack.enabled ? '开启' : '静音'}`);
        }
    }, [sendSignal, log]);
    
    /**
     * 开始屏幕共享
     */
    const startScreenShare = useCallback(async () => {
        // 使用 ref 获取最新状态
        const currentRemoteUser = remoteUserRef.current;
        if (!currentRemoteUser || callStatusRef.current !== CALL_STATUS.CONNECTED) {
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
            
            // 替换视频轨道并重新协商
            const peer = peersRef.current[currentRemoteUser];
            if (peer && peer.pc) {
                const pc = peer.pc;
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(screenStream.getVideoTracks()[0]);
                    log('🔄 已替换视频轨道为屏幕共享');
                    
                    // 等待一帧确保轨道替换生效
                    await new Promise(r => setTimeout(r, 100));
                    
                    // 重新协商 SDP（屏幕分辨率可能与摄像头不同）
                    try {
                        // 确保信令状态稳定
                        if (pc.signalingState !== 'stable') {
                            log(`⚠️ 等待信令状态稳定: ${pc.signalingState}`);
                            await new Promise(r => setTimeout(r, 500));
                        }
                        
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        sendSignal('video-offer', currentRemoteUser, {
                            sdp: pc.localDescription
                        });
                        log('🔄 已发送屏幕共享重新协商');
                    } catch (err) {
                        log(`⚠️ 屏幕共享重新协商失败: ${err.message}`);
                    }
                }
            }
            
            // 更新本地预览显示屏幕共享内容
            setLocalStream(screenStream);
            
            // 监听屏幕共享结束（用户点击浏览器的停止共享按钮）
            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };
            
            setIsScreenSharing(true);
            
            // 通知对方
            sendSignal(CALL_MESSAGE_TYPES.SCREEN_SHARE_START, currentRemoteUser, {});
            
            log('🖥️ 屏幕共享已开始');
            return true;
        } catch (error) {
            log(`❌ 屏幕共享失败: ${error.message}`);
            return false;
        }
    }, [peersRef, sendSignal, log]);
    
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
        
        // 使用 ref 获取最新的 remoteUser
        const currentRemoteUser = remoteUserRef.current;
        
        // 恢复原始视频轨道
        if (originalVideoTrackRef.current && currentRemoteUser) {
            const peer = peersRef.current[currentRemoteUser];
            if (peer && peer.pc) {
                const pc = peer.pc;
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(originalVideoTrackRef.current);
                    
                    // 等待一帧确保轨道替换生效
                    await new Promise(r => setTimeout(r, 100));
                    
                    // 重新协商 SDP（切回摄像头分辨率）
                    try {
                        if (pc.signalingState !== 'stable') {
                            await new Promise(r => setTimeout(r, 500));
                        }
                        
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        sendSignal('video-offer', currentRemoteUser, {
                            sdp: pc.localDescription
                        });
                    } catch (err) {
                        log(`⚠️ 停止共享重新协商失败: ${err.message}`);
                    }
                }
            }
            
            // 恢复本地预览为摄像头
            if (localStreamRef.current) {
                setLocalStream(localStreamRef.current);
            }
        }
        
        setIsScreenSharing(false);
        
        // 通知对方
        if (currentRemoteUser) {
            sendSignal(CALL_MESSAGE_TYPES.SCREEN_SHARE_STOP, currentRemoteUser, {});
        }
        
        log('🖥️ 屏幕共享已停止');
    }, [isScreenSharing, peersRef, sendSignal, log]);
    
    /**
     * 处理视频 offer（接收端收到发送端的重新协商请求）
     */
    const handleVideoOffer = useCallback(async (fromUserId, payload) => {
        const peer = peersRef.current[fromUserId];
        if (!peer || !peer.pc) {
            log(`⚠️ 收到 video-offer 但未找到连接`);
            return;
        }
        
        const pc = peer.pc;
        
        try {
            log(`📥 收到视频 offer，signalingState=${pc.signalingState}`);
            
            // 如果当前不是 stable 状态，等待或回滚
            if (pc.signalingState !== 'stable') {
                log(`⚠️ 信令状态非 stable (${pc.signalingState})，尝试回滚...`);
                // 回滚当前的本地描述
                await pc.setLocalDescription({ type: 'rollback' });
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            // 发送 answer
            sendSignal('video-answer', fromUserId, {
                sdp: pc.localDescription
            });
            log(`📤 已发送视频 answer`);
        } catch (error) {
            log(`❌ 处理 video-offer 失败: ${error.message}`);
        }
    }, [peersRef, sendSignal, log]);
    
    /**
     * 处理视频 answer（发送端收到接收端的回应）
     */
    const handleVideoAnswer = useCallback(async (fromUserId, payload) => {
        const peer = peersRef.current[fromUserId];
        if (!peer || !peer.pc) {
            log(`⚠️ 收到 video-answer 但未找到连接`);
            return;
        }
        
        try {
            log(`📥 收到视频 answer，正在处理...`);
            await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            log(`✅ 视频连接已建立`);
        } catch (error) {
            log(`❌ 处理 video-answer 失败: ${error.message}`);
        }
    }, [peersRef, log]);
    
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
            // 视频重新协商信令
            case 'video-offer':
                handleVideoOffer(fromUserId, payload);
                break;
            case 'video-answer':
                handleVideoAnswer(fromUserId, payload);
                break;
        }
    }, [handleIncomingCall, handleCallAccepted, handleCallRejected, handleCallEnded, cleanupCall, getDisplayName, log, handleVideoOffer, handleVideoAnswer]);
    
    return {
        // 状态
        callStatus,
        remoteUser,
        isVideoEnabled,
        isAudioEnabled,
        isScreenSharing,
        remoteVideoEnabled,
        remoteAudioEnabled,
        
        // 媒体流（state，触发重新渲染）
        localStream,
        remoteStream,
        
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
