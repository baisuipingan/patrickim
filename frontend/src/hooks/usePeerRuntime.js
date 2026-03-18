import { useCallback, useEffect, useRef, useState } from 'react';
import { CALL_MESSAGE_TYPES } from './useVideoCall';

export const WS_STATUS = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DISCONNECTED: 'disconnected'
};

export const PEER_CHANNEL_STATUS = {
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

function createEventQueue(diagnostics) {
    let tail = Promise.resolve();

    return {
        enqueue: (handler) => {
            tail = tail.then(() => handler()).catch(err => {
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
}

function createDefaultConnectionStatus() {
    return {
        status: PEER_CHANNEL_STATUS.DISCONNECTED,
        networkType: null,
        localType: null,
        remoteType: null,
        lastPeerActivityAt: 0,
        lastPeerActivitySource: '',
        lastHeartbeatSentAt: 0,
        staleSince: 0
    };
}

export function usePeerRuntime({
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
}) {
    const [connectionStatus, setConnectionStatus] = useState({});
    const [wsStatus, setWsStatus] = useState(WS_STATUS.DISCONNECTED);

    const wsRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const isManualCloseRef = useRef(false);
    const wsCloseBurstRef = useRef({
        count: 0,
        windowStartedAt: 0
    });

    useEffect(() => {
        connectionStatusRef.current = connectionStatus;
    }, [connectionStatus, connectionStatusRef]);

    useEffect(() => {
        wsStatusRef.current = wsStatus;
    }, [wsStatus, wsStatusRef]);

    const updatePeerConnectionStatus = useCallback((remoteId, patch) => {
        if (!remoteId) {
            return;
        }

        setConnectionStatus(prev => {
            const current = prev[remoteId] || createDefaultConnectionStatus();
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
        if (!remoteId) {
            return;
        }

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
        if (!remoteId) {
            return;
        }

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
    }, [connectionStatusRef, diagnostics, updatePeerConnectionStatus]);

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
    }, [onlineUsersRef, wsStatusRef]);

    const clearPeerRecoveryTimer = useCallback((remoteId) => {
        const peer = peersRef.current[remoteId];
        if (peer?.iceRestartTimer) {
            clearTimeout(peer.iceRestartTimer);
            peer.iceRestartTimer = null;
        }
    }, [peersRef]);

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
    }, [clearPeerRecoveryTimer, peersRef]);

    const shouldInitiatePeerConnection = useCallback((remoteId) => {
        const localId = myIdRef.current;
        if (!localId || !remoteId || localId === remoteId) {
            return false;
        }

        // 用稳定的 ID 排序来决定谁先发 offer，避免双方刷新时同时发起协商。
        return localId.localeCompare(remoteId) > 0;
    }, [myIdRef]);

    const isActivePeerInstance = useCallback((remoteId, instanceId) => {
        return peersRef.current[remoteId]?.instanceId === instanceId;
    }, [peersRef]);

    const getPeerChatChannel = useCallback((peer) => {
        return peer?.chatDc || peer?.dc || null;
    }, []);

    const closePeerDataChannels = useCallback((peer) => {
        const uniqueChannels = Array.from(new Set([peer?.chatDc, peer?.fileDc, peer?.dc].filter(Boolean)));
        uniqueChannels.forEach((channel) => {
            channel.onopen = null;
            channel.onclose = null;
            channel.onerror = null;
            channel.onmessage = null;
            channel.onbufferedamountlow = null;
            try {
                channel.close();
            } catch {
                // 忽略已经关闭的 DataChannel。
            }
        });
    }, []);

    const ensurePeerEventQueues = useCallback((remoteId) => {
        if (!eventQueueRef.current[remoteId]) {
            eventQueueRef.current[remoteId] = {
                chat: createEventQueue(diagnostics),
                file: createEventQueue(diagnostics)
            };
        } else {
            if (!eventQueueRef.current[remoteId].chat) {
                eventQueueRef.current[remoteId].chat = createEventQueue(diagnostics);
            }
            if (!eventQueueRef.current[remoteId].file) {
                eventQueueRef.current[remoteId].file = createEventQueue(diagnostics);
            }
        }

        return eventQueueRef.current[remoteId];
    }, [diagnostics, eventQueueRef]);

    const cleanupPeerConnection = useCallback((remoteId, { removeStatus = true } = {}) => {
        const peer = peersRef.current[remoteId];

        if (connectionTimeoutRef.current[remoteId]) {
            clearTimeout(connectionTimeoutRef.current[remoteId]);
            delete connectionTimeoutRef.current[remoteId];
        }

        if (peer?.iceRestartTimer) {
            clearTimeout(peer.iceRestartTimer);
        }

        closePeerDataChannels(peer);

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

        updatePeerConnectionStatus(remoteId, createDefaultConnectionStatus());
    }, [
        closePeerDataChannels,
        connectionTimeoutRef,
        eventQueueRef,
        incomingFilesRef,
        pendingIceCandidatesRef,
        peersRef,
        removePeerConnectionStatus,
        updatePeerConnectionStatus
    ]);

    const queuePendingIceCandidate = useCallback((remoteId, candidate) => {
        if (!remoteId || !candidate) {
            return;
        }

        if (!pendingIceCandidatesRef.current[remoteId]) {
            pendingIceCandidatesRef.current[remoteId] = [];
        }
        pendingIceCandidatesRef.current[remoteId].push(candidate);
    }, [pendingIceCandidatesRef]);

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
    }, [diagnostics, pendingIceCandidatesRef, peersRef]);

    const sendSignal = useCallback((type, to, payload) => {
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
    }, [diagnostics, peersRef, sendSignal]);

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
    }, [diagnostics, peersRef, sendPeerOffer]);

    const runCallSignalHandler = useCallback((type, remoteId, payload) => {
        if (typeof callSignalHandlerRef.current === 'function') {
            callSignalHandlerRef.current(type, remoteId, payload);
            return;
        }

        diagnostics.recordEvent('call_signal_dropped_no_handler', {
            remoteId,
            signalType: type
        });
    }, [callSignalHandlerRef, diagnostics]);

    const handleMessage = useCallback(async (remoteId, data, { channelLabel = 'chat' } = {}) => {
        if (data instanceof ArrayBuffer) {
            markPeerChannelAlive(remoteId, `${channelLabel}_binary_chunk`);
            const handled = await handleIncomingFileChunk(remoteId, data);
            if (handled) {
                return;
            }
            return;
        }

        try {
            const msg = JSON.parse(data);
            if (msg.type === PEER_HEARTBEAT_MESSAGE_TYPE) {
                markPeerChannelAlive(remoteId, 'heartbeat');
                return;
            }

            markPeerChannelAlive(remoteId, `${channelLabel}_message`);

            const handledFileMessage = await handleIncomingFileMessage(remoteId, msg);
            if (handledFileMessage) {
                return;
            }

            if (Object.values(CALL_MESSAGE_TYPES).includes(msg.type) || msg.type === 'video-offer' || msg.type === 'video-answer') {
                // 兼容旧标签页：如果仍有通话控制从 DataChannel 过来，继续接收。
                runCallSignalHandler(msg.type, remoteId, msg);
            } else {
                if (!msg.mode) {
                    msg.mode = 'broadcast';
                }
                addChat({ from: remoteId, ...msg });
            }
        } catch {
            diagnostics.recordEvent('datachannel_text_fallback', {
                remoteId,
                channelLabel
            });
            markPeerChannelAlive(remoteId, 'text_fallback');
            addChat({ from: remoteId, text: data, type: 'text', mode: 'broadcast' });
        }
    }, [
        addChat,
        diagnostics,
        handleIncomingFileChunk,
        handleIncomingFileMessage,
        markPeerChannelAlive,
        runCallSignalHandler,
    ]);

    const setupDataChannel = useCallback((dc, remoteId, instanceId, channelLabel = 'chat') => {
        if (!isActivePeerInstance(remoteId, instanceId)) {
            return;
        }

        const lane = channelLabel === 'file' ? 'file' : 'chat';
        if (peersRef.current[remoteId]) {
            if (lane === 'file') {
                peersRef.current[remoteId].fileDc = dc;
            } else {
                peersRef.current[remoteId].chatDc = dc;
                peersRef.current[remoteId].dc = dc;
            }
        }

        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 0;

        dc.onopen = () => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            if (lane === 'file') {
                log(`File channel ready with ${remoteId}`);
                diagnostics.recordEvent('file_datachannel_opened', {
                    remoteId
                });
                return;
            }

            log(`Connected to ${remoteId}`);
            diagnostics.recordEvent('datachannel_opened', {
                remoteId
            });

            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }

            updatePeerConnectionStatus(remoteId, {
                status: PEER_CHANNEL_STATUS.CONNECTED,
                lastPeerActivityAt: Date.now(),
                lastPeerActivitySource: 'datachannel_open',
                staleSince: 0
            });
        };

        dc.onclose = () => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            if (peersRef.current[remoteId]) {
                if (lane === 'file' && peersRef.current[remoteId].fileDc === dc) {
                    peersRef.current[remoteId].fileDc = null;
                }
                if (lane === 'chat' && peersRef.current[remoteId].chatDc === dc) {
                    peersRef.current[remoteId].chatDc = null;
                    peersRef.current[remoteId].dc = null;
                }
            }

            if (lane === 'file') {
                log(`File channel closed with ${remoteId}`);
                diagnostics.recordEvent('file_datachannel_closed', {
                    remoteId
                }, {
                    delayMs: 1000,
                    reason: 'file_datachannel_closed'
                });
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

            if (connectionTimeoutRef.current[remoteId]) {
                clearTimeout(connectionTimeoutRef.current[remoteId]);
                delete connectionTimeoutRef.current[remoteId];
            }

            updatePeerConnectionStatus(remoteId, {
                status: PEER_CHANNEL_STATUS.DISCONNECTED
            });
            delete eventQueueRef.current[remoteId];
        };

        dc.onerror = (error) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            if (dc.readyState === 'open' || dc.readyState === 'connecting') {
                console.warn(`${lane === 'file' ? 'File' : 'Chat'} DataChannel error with ${remoteId}:`, error);
                log(`⚠️ Connection issue with ${remoteId}`);
                diagnostics.reportIssue('datachannel_error', {
                    remoteId,
                    channelLabel: lane,
                    readyState: dc.readyState,
                    message: error?.message || 'DataChannel error'
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'datachannel'
                    }
                });
            }
        };

        const peerQueues = ensurePeerEventQueues(remoteId);
        dc.onmessage = (event) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            peerQueues[lane].enqueue(() => handleMessage(remoteId, event.data, { channelLabel: lane }));
        };
    }, [
        connectionTimeoutRef,
        diagnostics,
        ensurePeerEventQueues,
        eventQueueRef,
        handleMessage,
        isActivePeerInstance,
        log,
        peersRef,
        updatePeerConnectionStatus
    ]);

    const createPeerConnection = useCallback(async (remoteId, initiator) => {
        if (peersRef.current[remoteId]) {
            return;
        }

        diagnostics.recordEvent('peer_connection_creating', {
            remoteId,
            initiator
        });

        const instanceId = ++peerInstanceCounterRef.current;

        if (connectionTimeoutRef.current[remoteId]) {
            clearTimeout(connectionTimeoutRef.current[remoteId]);
        }

        updatePeerConnectionStatus(remoteId, {
            status: PEER_CHANNEL_STATUS.CONNECTING
        });

        connectionTimeoutRef.current[remoteId] = setTimeout(() => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            const peer = peersRef.current[remoteId];
            const chatChannel = getPeerChatChannel(peer);
            if (peer && (!chatChannel || chatChannel.readyState !== 'open')) {
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

                if (initiator) {
                    log(`Initiating reconnection with ${remoteId} after timeout...`);
                    setTimeout(() => {
                        void createPeerConnection(remoteId, true);
                    }, 1000);
                }
            }
        }, 30_000);

        const pc = new RTCPeerConnection(rtcConfigRef.current);

        peersRef.current[remoteId] = {
            instanceId,
            pc,
            dc: null,
            chatDc: null,
            fileDc: null,
            isInitiator: initiator,
            iceRestartTimer: null,
            iceRestartInFlight: false,
            iceRestartAttempts: 0,
            pendingRestartReason: '',
            makingOffer: false
        };

        if (initiator) {
            const chatDc = pc.createDataChannel('chat', {
                ordered: true
            });
            const fileDc = pc.createDataChannel('file', {
                ordered: true,
                maxRetransmits: undefined
            });
            peersRef.current[remoteId].dc = chatDc;
            peersRef.current[remoteId].chatDc = chatDc;
            peersRef.current[remoteId].fileDc = fileDc;
            setupDataChannel(chatDc, remoteId, instanceId, 'chat');
            setupDataChannel(fileDc, remoteId, instanceId, 'file');
        } else {
            pc.ondatachannel = (event) => {
                if (!isActivePeerInstance(remoteId, instanceId)) {
                    try {
                        event.channel.close();
                    } catch {
                        // 忽略已关闭通道。
                    }
                    return;
                }

                setupDataChannel(event.channel, remoteId, instanceId, event.channel.label || 'chat');
            };
        }

        const detectNetworkType = () => {
            pc.getStats().then(stats => {
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        stats.forEach(candidate => {
                            if (candidate.id === report.localCandidateId) {
                                const localType = candidate.candidateType;
                                const localAddress = candidate.address || candidate.ip;

                                stats.forEach(remote => {
                                    if (remote.id === report.remoteCandidateId) {
                                        const remoteType = remote.candidateType;
                                        const remoteAddress = remote.address || remote.ip;
                                        const isLAN = localType === 'host' && remoteType === 'host';
                                        const networkType = isLAN ? 'lan' : 'wan';

                                        log(`${remoteId} 连接类型: ${networkType.toUpperCase()} (${localType} -> ${remoteType})`);

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

        pc.onicecandidate = (event) => {
            if (!isActivePeerInstance(remoteId, instanceId)) {
                return;
            }

            if (event.candidate) {
                if (event.candidate.address) {
                    myICECandidatesRef.current.push({
                        type: event.candidate.type,
                        address: event.candidate.address,
                        candidate: event.candidate.candidate
                    });
                }
                sendSignal('candidate', remoteId, event.candidate);
            }
        };

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

        if (initiator && isActivePeerInstance(remoteId, instanceId)) {
            await sendPeerOffer(remoteId, {
                iceRestart: false,
                reason: 'initial_offer'
            });
        }
    }, [
        cleanupPeerConnection,
        connectionTimeoutRef,
        diagnostics,
        getPeerChatChannel,
        isActivePeerInstance,
        log,
        markPeerChannelAlive,
        myICECandidatesRef,
        peerInstanceCounterRef,
        peersRef,
        resetPeerRecoveryState,
        rtcConfigRef,
        scheduleIceRestart,
        sendPeerOffer,
        sendSignal,
        setupDataChannel,
        updatePeerConnectionStatus
    ]);

    const handleSignalMessage = useCallback(async (msg) => {
        const { type, from, payload } = msg;

        switch (type) {
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
                if (nicknameRef.current) {
                    sendSignal('nickname', from, { nickname: nicknameRef.current });
                }
                break;
            case 'nickname':
                if (payload && payload.nickname) {
                    setUserNicknames(prev => ({ ...prev, [from]: payload.nickname }));
                    log(`User ${from} is now "${payload.nickname}"`);
                }
                break;
            case 'existing_users':
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
                        if (nicknameRef.current) {
                            setTimeout(() => sendSignal('nickname', id, { nickname: nicknameRef.current }), 100);
                        }
                    });
                }
                break;
            case 'user_left':
                log(`User ${from} left`);
                updateOnlineUsers('remove', from);
                cleanupPeerConnection(from);
                if (activeUserRef.current === from) {
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

                if (!peersRef.current[from].pc.remoteDescription) {
                    queuePendingIceCandidate(from, payload);
                    diagnostics.recordEvent('ice_candidate_buffered', {
                        remoteId: from,
                        reason: 'missing_remote_description'
                    });
                    break;
                }

                try {
                    await peersRef.current[from].pc.addIceCandidate(new RTCIceCandidate(payload));
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
                break;
            case 'file-done':
            case 'file-start':
            case 'file-offer':
            case 'file-accept':
            case 'file-reject':
            case 'file-offer-cancel': {
                const handled = await handleIncomingFileMessage(from, {
                    ...payload,
                    type
                });
                if (handled) {
                    break;
                }
                break;
            }
            case CALL_MESSAGE_TYPES.CALL_REQUEST:
            case CALL_MESSAGE_TYPES.CALL_ACCEPT:
            case CALL_MESSAGE_TYPES.CALL_REJECT:
            case CALL_MESSAGE_TYPES.CALL_END:
            case CALL_MESSAGE_TYPES.CALL_BUSY:
            case CALL_MESSAGE_TYPES.TOGGLE_VIDEO:
            case CALL_MESSAGE_TYPES.TOGGLE_AUDIO:
            case CALL_MESSAGE_TYPES.SCREEN_SHARE_START:
            case CALL_MESSAGE_TYPES.SCREEN_SHARE_STOP:
            case 'video-offer':
            case 'video-answer':
                runCallSignalHandler(type, from, payload || {});
                break;
        }
    }, [
        activeUserRef,
        addChat,
        cleanupPeerConnection,
        createPeerConnection,
        diagnostics,
        flushPendingIceCandidates,
        handleIncomingFileMessage,
        log,
        myIdRef,
        nicknameRef,
        peersRef,
        queuePendingIceCandidate,
        resetPeerRecoveryState,
        runCallSignalHandler,
        sendSignal,
        setUserNicknames,
        shouldInitiatePeerConnection,
        switchToUser,
        updateOnlineUsers,
        updatePeerConnectionStatus
    ]);

    const connectWs = useCallback((url, { isReconnect = false } = {}) => {
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
            isManualCloseRef.current = true;
            wsRef.current.close();
        }

        setWsStatus(isReconnect ? WS_STATUS.RECONNECTING : WS_STATUS.CONNECTING);
        const ws = new WebSocket(url);
        wsRef.current = ws;
        isManualCloseRef.current = false;

        ws.onopen = () => {
            log('Connected to Signaling Server');
            reconnectTimeoutRef.current = null;
            setWsStatus(WS_STATUS.CONNECTED);
            diagnostics.recordEvent('ws_opened', {
                url
            });
        };

        ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
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
            console.error('WebSocket error:', error);
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
                if (!burst.windowStartedAt || now - burst.windowStartedAt > WS_CLOSE_REPORT_WINDOW_MS) {
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

            if (isManualOrHiddenClose) {
                setWsStatus(WS_STATUS.DISCONNECTED);
                log('Connection closed');
                return;
            }

            if (event.code !== 1000) {
                setWsStatus(WS_STATUS.RECONNECTING);
                log('Connection lost. Reconnecting in 3 seconds...');
                reconnectTimeoutRef.current = setTimeout(() => {
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
                log('Disconnected from server');
            }
        };
    }, [diagnostics, handleSignalMessage, log, refreshAnonymousSession]);

    const cleanupConnections = useCallback(() => {
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

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
            closePeerDataChannels(peer);
            if (peer.pc) {
                peer.pc.close();
            }
            delete pendingIceCandidatesRef.current[remoteId];
        });

        peersRef.current = {};
        eventQueueRef.current = {};

        Object.values(connectionTimeoutRef.current).forEach(timer => {
            if (timer) {
                clearTimeout(timer);
            }
        });
        connectionTimeoutRef.current = {};

        setConnectionStatus({});
    }, [
        closePeerDataChannels,
        connectionTimeoutRef,
        eventQueueRef,
        pendingIceCandidatesRef,
        peersRef
    ]);

    useEffect(() => {
        const heartbeatTimer = setInterval(() => {
            const now = Date.now();

            Object.entries(peersRef.current).forEach(([remoteId, peer]) => {
                const channel = getPeerChatChannel(peer);
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
                const channel = getPeerChatChannel(peer);
                if (!channel || channel.readyState !== 'open') {
                    return;
                }

                const info = connectionStatusRef.current[remoteId];
                const lastPeerActivityAt = info?.lastPeerActivityAt || 0;
                if (!lastPeerActivityAt) {
                    return;
                }

                const idleForMs = now - lastPeerActivityAt;
                if (idleForMs >= PEER_STALE_THRESHOLD_MS && info?.status === PEER_CHANNEL_STATUS.CONNECTED) {
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
    }, [connectionStatusRef, diagnostics, getPeerChatChannel, peersRef, updatePeerConnectionStatus]);

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
    }, [peersRef, scheduleIceRestart, wsStatus]);

    return {
        connectionStatus,
        wsStatus,
        sendSignal,
        connectWs,
        cleanupConnections,
        getPeerChatChannel,
        getSignalPresence,
        isPeerChannelAvailable
    };
}
