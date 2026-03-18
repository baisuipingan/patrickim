import { useEffect, useState, useRef, useCallback } from 'react';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters';
import {
    clearDefaultReceiveDirectory as clearStoredDefaultReceiveDirectory,
    createWritableInDirectory,
    getDefaultReceiveDirectory as getStoredDefaultReceiveDirectory,
    isDirectoryPickerSupported,
    isImageFile,
    isModernFileAPISupported,
    pickDefaultReceiveDirectory,
    queryFileSystemPermission,
    requestFileSystemPermission,
    showSaveFilePicker
} from '../utils/fileUtils';
import { FILE_TRANSFER_CONFIG } from '../constants/config';

const {
    CHUNK_SIZE,
    MAX_CHUNKS_PER_BURST,
    MAX_BUFFERED_AMOUNT,
    BUFFER_LOW_THRESHOLD,
    PROGRESS_UPDATE_INTERVAL
} = FILE_TRANSFER_CONFIG;

const OFFER_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const FILE_DATA_CHANNEL_WAIT_MS = 5_000;
const OFFER_ACCEPTED_START_TIMEOUT_MS = 15_000;
const FILE_PICKER_ABORT_ERROR_NAMES = new Set(['AbortError', 'NotAllowedError', 'NotFoundError']);

/**
 * useFileTransfer Hook
 * 管理文件传输的发送和接收逻辑
 * 
 * @param {Object} params
 * @param {Function} params.log - 日志函数
 * @param {Function} params.addChat - 添加聊天消息函数
 * @param {Object} params.peersRef - peers 引用
 * @param {string} params.myId - 当前用户 ID
 * @param {Function} params.getDisplayName - 获取显示名称函数
 * @param {Object} params.blobUrlsRef - Blob URLs 引用，用于清理
 * @param {string|null} params.activeUser - 当前私聊用户 ID（null 表示广播）
 * @param {Object} params.diagnostics - 诊断上报对象
 * @returns {Object} 文件传输相关的状态和方法
 */
export function useFileTransfer({ log, addChat, patchChatMessages, peersRef, myId, getDisplayName, blobUrlsRef, activeUser, diagnostics }) {
    const [fileProgress, setFileProgress] = useState({});
    const [defaultReceiveDirectory, setDefaultReceiveDirectory] = useState(() => ({
        supported: isDirectoryPickerSupported(),
        status: isDirectoryPickerSupported() ? 'loading' : 'unsupported',
        name: ''
    }));
    const [receiveDirectoryBusy, setReceiveDirectoryBusy] = useState(false);
    
    const transferControlRef = useRef({});
    const incomingFilesRef = useRef({});
    const incomingFileOffersRef = useRef({});
    const pendingIncomingChunksRef = useRef({});
    const pendingIncomingDoneRef = useRef({});
    const fileQueueRef = useRef([]);
    const isSendingFileRef = useRef(false);
    const defaultReceiveDirectoryRef = useRef(null);

    const recordFileEvent = useCallback((kind, data = {}, options = {}) => {
        diagnostics?.recordEvent(kind, data, {
            scopeType: 'file-transfer',
            ...options
        });
    }, [diagnostics]);

    const reportFileIssue = useCallback((issueKey, data = {}, options = {}) => {
        diagnostics?.reportIssue(issueKey, data, {
            scopeType: 'file-transfer',
            ...options
        });
    }, [diagnostics]);

    const applyDefaultReceiveDirectoryState = useCallback((handle, status) => {
        defaultReceiveDirectoryRef.current = handle || null;
        setDefaultReceiveDirectory({
            supported: isDirectoryPickerSupported(),
            status,
            name: handle?.name || ''
        });
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadDefaultReceiveDirectory = async () => {
            if (!isDirectoryPickerSupported()) {
                applyDefaultReceiveDirectoryState(null, 'unsupported');
                return;
            }

            try {
                const handle = await getStoredDefaultReceiveDirectory();
                if (cancelled) {
                    return;
                }

                if (!handle) {
                    applyDefaultReceiveDirectoryState(null, 'not-configured');
                    return;
                }

                const permission = await queryFileSystemPermission(handle, {
                    writable: true
                });
                if (cancelled) {
                    return;
                }

                applyDefaultReceiveDirectoryState(handle, permission === 'granted' ? 'ready' : 'needs-permission');
            } catch (error) {
                console.warn('Failed to load default receive directory:', error);
                applyDefaultReceiveDirectoryState(null, 'not-configured');
            }
        };

        void loadDefaultReceiveDirectory();

        return () => {
            cancelled = true;
        };
    }, [applyDefaultReceiveDirectoryState]);

    const configureDefaultReceiveDirectory = useCallback(async () => {
        if (!isDirectoryPickerSupported() || receiveDirectoryBusy) {
            return false;
        }

        setReceiveDirectoryBusy(true);
        try {
            const handle = await pickDefaultReceiveDirectory();
            const permission = await queryFileSystemPermission(handle, {
                writable: true
            });
            applyDefaultReceiveDirectoryState(handle, permission === 'granted' ? 'ready' : 'needs-permission');
            recordFileEvent('default_receive_directory_configured', {
                directoryName: handle?.name || ''
            });
            return true;
        } catch (error) {
            if (FILE_PICKER_ABORT_ERROR_NAMES.has(error?.name)) {
                return false;
            }

            console.error('Failed to configure default receive directory:', error);
            reportFileIssue('default_receive_directory_config_failed', {
                message: error?.message || 'unknown',
                name: error?.name || 'Error'
            }, {
                delayMs: 1500,
                context: {
                    feature: 'file-receive'
                }
            });
            return false;
        } finally {
            setReceiveDirectoryBusy(false);
        }
    }, [applyDefaultReceiveDirectoryState, receiveDirectoryBusy, recordFileEvent, reportFileIssue]);

    const clearDefaultReceiveDirectory = useCallback(async () => {
        if (receiveDirectoryBusy) {
            return false;
        }

        setReceiveDirectoryBusy(true);
        try {
            await clearStoredDefaultReceiveDirectory();
            applyDefaultReceiveDirectoryState(null, isDirectoryPickerSupported() ? 'not-configured' : 'unsupported');
            recordFileEvent('default_receive_directory_cleared');
            return true;
        } catch (error) {
            console.error('Failed to clear default receive directory:', error);
            reportFileIssue('default_receive_directory_clear_failed', {
                message: error?.message || 'unknown',
                name: error?.name || 'Error'
            }, {
                delayMs: 1500,
                context: {
                    feature: 'file-receive'
                }
            });
            return false;
        } finally {
            setReceiveDirectoryBusy(false);
        }
    }, [applyDefaultReceiveDirectoryState, receiveDirectoryBusy, recordFileEvent, reportFileIssue]);

    const prepareWriterFromDefaultDirectory = useCallback(async (fileName) => {
        const directoryHandle = defaultReceiveDirectoryRef.current;
        if (!directoryHandle || !isDirectoryPickerSupported()) {
            return null;
        }

        let permission = await queryFileSystemPermission(directoryHandle, {
            writable: true
        });
        if (permission !== 'granted') {
            permission = await requestFileSystemPermission(directoryHandle, {
                writable: true
            });
        }

        if (permission !== 'granted') {
            applyDefaultReceiveDirectoryState(directoryHandle, 'needs-permission');
            return null;
        }

        const prepared = await createWritableInDirectory(directoryHandle, fileName);
        applyDefaultReceiveDirectoryState(directoryHandle, 'ready');
        return prepared;
    }, [applyDefaultReceiveDirectoryState]);

    async function settleFileWriter(target, { abort = false } = {}) {
        if (!target?.writer) {
            return true;
        }

        if (target.writerState === 'closed') {
            target.writer = null;
            return true;
        }

        if (target.writerState === 'aborted') {
            target.writer = null;
            return abort;
        }

        try {
            if (abort && typeof target.writer.abort === 'function') {
                await target.writer.abort();
                target.writerState = 'aborted';
            } else {
                await target.writer.close();
                target.writerState = 'closed';
            }
            return true;
        } catch (error) {
            console.error(`Failed to ${abort ? 'abort' : 'close'} file writer:`, error);
            reportFileIssue('file_writer_finalize_failed', {
                action: abort ? 'abort' : 'close',
                fileId: target.fileId || target.meta?.fileId || '',
                fileName: target.name || target.meta?.name || '',
                fromUserId: target.remoteId || '',
                message: error?.message || 'unknown',
                name: error?.name || 'Error'
            }, {
                delayMs: 1500,
                context: {
                    feature: 'file-receive'
                }
            });
            return false;
        } finally {
            target.writer = null;
            if (abort) {
                target.fileHandle = null;
            }
        }
    }

    async function cleanupIncomingTransfer(remoteId, fileId, { abortWriter = false } = {}) {
        const transfer = incomingFilesRef.current[remoteId]?.[fileId];
        if (transfer) {
            await settleFileWriter(transfer, {
                abort: abortWriter
            });

            delete incomingFilesRef.current[remoteId][fileId];
            if (Object.keys(incomingFilesRef.current[remoteId]).length === 0) {
                delete incomingFilesRef.current[remoteId];
            }
        }

        delete transferControlRef.current[`down-${fileId}`];
        clearPendingIncomingState(remoteId, fileId);
        removeTransferProgress(`down-${fileId}`);
        return transfer;
    }

    const getFirstOpenChannel = useCallback((channels = []) => {
        return channels.find(channel => channel?.readyState === 'open') || null;
    }, []);

    const getPeerTransferChannels = useCallback((peer) => {
        const controlDc = getFirstOpenChannel([peer?.chatDc, peer?.dc, peer?.fileDc])
            || peer?.chatDc
            || peer?.dc
            || peer?.fileDc
            || null;
        const dataDc = getFirstOpenChannel([peer?.fileDc, peer?.dc, peer?.chatDc])
            || peer?.fileDc
            || peer?.dc
            || peer?.chatDc
            || null;

        return {
            controlDc,
            dataDc
        };
    }, [getFirstOpenChannel]);

    const waitForPeerTransferChannels = useCallback((targetId, { timeoutMs = FILE_DATA_CHANNEL_WAIT_MS } = {}) => (
        new Promise((resolve) => {
            const startedAt = Date.now();

            const poll = () => {
                const peer = peersRef.current[targetId];
                if (!peer) {
                    resolve(null);
                    return;
                }

                const controlDc = getFirstOpenChannel([peer.chatDc, peer.dc, peer.fileDc]);
                if (!controlDc || controlDc.readyState !== 'open') {
                    if (Date.now() - startedAt >= timeoutMs) {
                        resolve(null);
                        return;
                    }

                    setTimeout(poll, 100);
                    return;
                }

                const fileDc = getFirstOpenChannel([peer.fileDc]);
                if (fileDc) {
                    resolve({
                        controlDc,
                        dataDc: fileDc,
                        transport: 'file'
                    });
                    return;
                }

                if (Date.now() - startedAt >= timeoutMs) {
                    const fallbackDc = getFirstOpenChannel([peer.dc, peer.chatDc, peer.fileDc]);

                    if (fallbackDc) {
                        resolve({
                            controlDc,
                            dataDc: fallbackDc,
                            transport: 'chat-fallback'
                        });
                        return;
                    }

                    resolve(null);
                    return;
                }

                setTimeout(poll, 100);
            };

            poll();
        })
    ), [getFirstOpenChannel, peersRef]);

    const sendJsonMessage = useCallback((channel, payload) => {
        if (!channel || channel.readyState !== 'open') {
            return false;
        }
        try {
            channel.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }, []);

    const updateFileOfferMessage = useCallback((fromUserId, fileId, patch) => {
        patchChatMessages?.(
            (message) => (
                message.type === 'file-offer' &&
                message.fileId === fileId &&
                message.from === fromUserId
            ),
            patch
        );
    }, [patchChatMessages]);

    const removeTransferProgress = useCallback((key) => {
        setFileProgress(prev => {
            if (!prev[key]) {
                return prev;
            }
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, []);

    const patchTransferProgress = useCallback((key, patch) => {
        setFileProgress(prev => {
            const current = prev[key];
            if (!current) {
                return prev;
            }

            const nextPatch = typeof patch === 'function' ? patch(current) : patch;
            return {
                ...prev,
                [key]: {
                    ...current,
                    ...nextPatch
                }
            };
        });
    }, []);

    const patchUploadProgress = useCallback((fileId, targetId, patch) => {
        patchTransferProgress(`up-${fileId}-${targetId}`, patch);
    }, [patchTransferProgress]);

    const patchDownloadProgress = useCallback((fileId, patch) => {
        patchTransferProgress(`down-${fileId}`, patch);
    }, [patchTransferProgress]);

    const setUploadAwaitingProgress = useCallback((fileId, file, targetId, targetName) => {
        setFileProgress(prev => ({
            ...prev,
            [`up-${fileId}-${targetId}`]: {
                controlKey: `up-${fileId}`,
                type: 'upload',
                name: file.name,
                totalSize: formatSize(file.size),
                sent: '等待接收方确认',
                percent: 0,
                speed: '',
                remaining: '',
                targetId,
                targetName,
                canPause: false,
                phase: 'awaiting-acceptance',
                statusText: '等待对方点击接收'
            }
        }));
    }, []);

    const resolveOfferDecision = useCallback((fileId, targetId, decision) => {
        const control = transferControlRef.current[`up-${fileId}`];
        if (!control) {
            return;
        }

        const timer = control.subOfferTimers[targetId];
        if (timer) {
            clearTimeout(timer);
            delete control.subOfferTimers[targetId];
        }

        control.subOfferStatus[targetId] = decision;
        const resolver = control.subOfferResolvers[targetId];
        if (resolver) {
            delete control.subOfferResolvers[targetId];
            resolver(decision);
        }
    }, []);

    const waitForOfferDecision = useCallback((fileId, targetId) => (
        new Promise((resolve) => {
            const control = transferControlRef.current[`up-${fileId}`];
            if (!control) {
                resolve('cancelled');
                return;
            }

            const existingDecision = control.subOfferStatus[targetId];
            if (existingDecision && existingDecision !== 'pending') {
                resolve(existingDecision);
                return;
            }

            control.subOfferResolvers[targetId] = resolve;
            control.subOfferTimers[targetId] = setTimeout(() => {
                const latestControl = transferControlRef.current[`up-${fileId}`];
                if (!latestControl) {
                    resolve('cancelled');
                    return;
                }

                const latestDecision = latestControl.subOfferStatus[targetId];
                if (latestDecision && latestDecision !== 'pending') {
                    resolve(latestDecision);
                    return;
                }

                delete latestControl.subOfferResolvers[targetId];
                delete latestControl.subOfferTimers[targetId];
                latestControl.subOfferStatus[targetId] = 'timeout';
                resolve('timeout');
            }, OFFER_RESPONSE_TIMEOUT_MS);
        })
    ), []);
    
    /**
     * 发送文件
     */
    const sendFile = useCallback(async (file) => {
        if (file.size > 50 * 1024 * 1024 * 1024) {
            reportFileIssue('file_too_large', {
                fileName: file.name,
                size: file.size
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-send'
                }
            });
            alert(`文件 "${file.name}" 过大（最大支持 50GB）\n当前文件大小：${formatSize(file.size)}`);
            return;
        }
        
        // 添加到队列，同时记录当时的 activeUser（避免闭包陷阱）
        fileQueueRef.current.push({
            file,
            targetUser: activeUser // 记录发送时的目标用户
        });
        
        // 如果没有正在发送的文件，开始处理队列
        if (!isSendingFileRef.current) {
            processFileQueue();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeUser, reportFileIssue]);
    
    /**
     * 处理文件队列
     */
    const processFileQueue = useCallback(async () => {
        if (isSendingFileRef.current || fileQueueRef.current.length === 0) {
            return;
        }
        
        isSendingFileRef.current = true;
        const queueItem = fileQueueRef.current.shift();
        
        try {
            await sendFileActual(queueItem.file, queueItem.targetUser);
        } catch (error) {
            console.error('Failed to send file:', error);
            log(`发送文件失败: ${queueItem.file.name} - ${error.message}`);
            reportFileIssue('file_send_failed', {
                fileName: queueItem.file.name,
                targetUser: queueItem.targetUser,
                message: error.message,
                name: error.name || 'Error'
            }, {
                delayMs: 1500,
                context: {
                    feature: 'file-send'
                }
            });
        } finally {
            // 确保即使出错也能重置状态
            isSendingFileRef.current = false;
            
            // 继续处理下一个文件
            if (fileQueueRef.current.length > 0) {
                setTimeout(() => processFileQueue(), 100);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [log]);
    
    /**
     * 实际发送文件
     * @param {File} file - 要发送的文件
     * @param {string|null} targetUser - 目标用户ID（null表示广播）
     */
    const sendFileActual = useCallback(async (file, targetUser) => {
        const fileId = Math.random().toString(36).substr(2, 9);
        const chunkSize = CHUNK_SIZE;
        const totalChunks = Math.ceil(file.size / chunkSize);
        const isImageTransfer = isImageFile(file.name, file.type);
        const requiresOfferApproval = !isImageTransfer;
        
        // 检查文件是否有效
        if (!file || file.size === undefined) {
            throw new Error('Invalid file object');
        }

        recordFileEvent('file_send_started', {
            fileId,
            fileName: file.name,
            size: file.size,
            targetUser,
            mode: targetUser !== null ? 'private' : 'broadcast',
            transferKind: isImageTransfer ? 'image' : 'file',
            approvalMode: requiresOfferApproval ? 'manual' : 'direct'
        });
        
        const isPrivate = targetUser !== null;
        
        // 获取目标的通道。控制消息优先走 chat 通道，文件二进制优先走 file 通道。
        let targets;
        if (isPrivate) {
            // 私聊：只发送给指定用户
            const peer = peersRef.current[targetUser];
            const { controlDc } = getPeerTransferChannels(peer);
            if (peer && controlDc?.readyState === 'open') {
                targets = [{
                    id: targetUser,
                    name: getDisplayName(targetUser)
                }];
            } else {
                targets = [];
            }
        } else {
            // 广播：发送给所有在线用户
            targets = Object.entries(peersRef.current)
                .map(([id, peer]) => {
                    const { controlDc } = getPeerTransferChannels(peer);
                    if (!controlDc || controlDc.readyState !== 'open') {
                        return null;
                    }
                    return {
                        id,
                        name: getDisplayName(id)
                    };
                })
                .filter(Boolean);
        }
        
        if (targets.length === 0) {
            log('No connected peers to send file');
            reportFileIssue('file_send_no_connected_peers', {
                fileId,
                fileName: file.name,
                targetUser,
                mode: isPrivate ? 'private' : 'broadcast'
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-send'
                }
            });
            return;
        }
        
        // 创建文件传输控制对象
        const control = {
            paused: false,
            cancelled: false,
            subPaused: {},
            subCancelled: {},
            subChannels: {},
            subDataChannels: {},
            subOfferStatus: {},
            subOfferResolvers: {},
            subOfferTimers: {},
            subSendBatch: {},
            pauseTarget: (targetId, options = {}) => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl || ctrl.subCancelled[targetId]) return;

                const {
                    notifyRemote = true,
                    phase = 'pausing',
                    statusText = '正在暂停，等待已发送缓存排空'
                } = options;

                ctrl.subPaused[targetId] = true;
                patchUploadProgress(fileId, targetId, {
                    phase,
                    statusText
                });

                const channel = ctrl.subChannels[targetId];
                if (notifyRemote && ctrl.subOfferStatus[targetId] === 'accepted') {
                    sendJsonMessage(channel, {
                        type: 'pause-transfer-by-sender',
                        fileId
                    });
                }

                const sendBatch = ctrl.subSendBatch[targetId];
                if (sendBatch) {
                    try {
                        sendBatch();
                    } catch (error) {
                        console.error('Failed to flush pause state:', error);
                    }
                }
            },
            resumeTarget: (targetId, options = {}) => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl || ctrl.subCancelled[targetId]) return;

                const {
                    notifyRemote = true,
                    phase = 'transferring',
                    statusText = ''
                } = options;

                ctrl.subPaused[targetId] = false;
                patchUploadProgress(fileId, targetId, {
                    phase,
                    statusText
                });

                const channel = ctrl.subChannels[targetId];
                if (notifyRemote && ctrl.subOfferStatus[targetId] === 'accepted') {
                    sendJsonMessage(channel, {
                        type: 'resume-transfer-by-sender',
                        fileId
                    });
                }

                const sendBatch = ctrl.subSendBatch[targetId];
                if (sendBatch) {
                    sendBatch();
                }
            },
            cancelTarget: (targetId, options = {}) => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl || ctrl.subCancelled[targetId]) return;

                const {
                    notifyRemote = true,
                    logCancel = true
                } = options;

                ctrl.subCancelled[targetId] = true;
                ctrl.subPaused[targetId] = false;

                const offerStatus = ctrl.subOfferStatus?.[targetId];
                const offerTimer = ctrl.subOfferTimers?.[targetId];
                const resolver = ctrl.subOfferResolvers?.[targetId];
                if (offerTimer) {
                    clearTimeout(offerTimer);
                    delete ctrl.subOfferTimers[targetId];
                }
                if (ctrl.subOfferStatus) {
                    ctrl.subOfferStatus[targetId] = 'cancelled';
                }
                if (resolver) {
                    delete ctrl.subOfferResolvers[targetId];
                    resolver('cancelled');
                }

                const dataChannel = ctrl.subDataChannels[targetId];
                if (dataChannel) {
                    dataChannel.onbufferedamountlow = null;
                }

                const channel = ctrl.subChannels[targetId];
                if (notifyRemote && channel && channel.readyState === 'open') {
                    sendJsonMessage(channel, offerStatus === 'accepted'
                        ? {
                            type: 'cancel-transfer',
                            fileId
                        }
                        : {
                            type: 'file-offer-cancel',
                            fileId
                        });
                }

                const sendBatch = ctrl.subSendBatch[targetId];
                if (sendBatch) {
                    try {
                        sendBatch();
                    } catch (error) {
                        console.error('Failed to flush cancel state:', error);
                    }
                } else {
                    delete ctrl.subPaused[targetId];
                    delete ctrl.subCancelled[targetId];
                    delete ctrl.subChannels[targetId];
                    delete ctrl.subDataChannels[targetId];
                }

                removeTransferProgress(`up-${fileId}-${targetId}`);
                if (logCancel) {
                    log(`已取消发送给 ${getDisplayName(targetId)}`);
                }
            },
            pause: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.paused = true;
                Object.keys(ctrl.subPaused).forEach(id => {
                    ctrl.pauseTarget?.(id);
                });
            },
            resume: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.paused = false;
                Object.keys(ctrl.subPaused).forEach(id => {
                    ctrl.resumeTarget?.(id);
                });
            },
            cancel: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.cancelled = true;
                
                Object.keys(ctrl.subChannels).forEach(id => {
                    ctrl.cancelTarget?.(id);
                    resolveOfferDecision(fileId, id, 'cancelled');
                });
                
                setFileProgress(prev => {
                    const next = { ...prev };
                    Object.keys(prev).forEach(key => {
                        if (key.startsWith(`up-${fileId}-`)) {
                            delete next[key];
                        }
                    });
                    return next;
                });
                
                delete transferControlRef.current[`up-${fileId}`];
                
                log(`已取消发送`);
                
                // 注意：不在这里重置 isSendingFileRef 和调用 processFileQueue
                // 让 processFileQueue 自然完成当前文件的处理后继续下一个
            }
        };
        
        transferControlRef.current[`up-${fileId}`] = control;

        const startTransferToTarget = (target) => {
            if (requiresOfferApproval) {
                patchUploadProgress(fileId, target.id, {
                    phase: 'preparing-transfer-channel',
                    statusText: '等待文件通道就绪',
                    canPause: false
                });
            }

            return waitForPeerTransferChannels(target.id).then((channels) => {
                if (!channels?.controlDc || !channels?.dataDc) {
                    const fallbackControlChannel = control.subChannels[target.id];
                    if (fallbackControlChannel?.readyState === 'open') {
                        sendJsonMessage(fallbackControlChannel, {
                            type: 'cancel-transfer',
                            fileId
                        });
                    }

                    removeTransferProgress(`up-${fileId}-${target.id}`);
                    reportFileIssue('file_transfer_channel_unavailable', {
                        fileId,
                        fileName: file.name,
                        targetId: target.id,
                        targetName: target.name
                    }, {
                        delayMs: 1000,
                        context: {
                            feature: 'file-send'
                        }
                    });
                    return { status: 'failed', targetId: target.id };
                }

                control.subChannels[target.id] = channels.controlDc;
                control.subDataChannels[target.id] = channels.dataDc;

                if (channels.transport === 'chat-fallback') {
                    recordFileEvent('file_datachannel_fallback_to_chat', {
                        fileId,
                        fileName: file.name,
                        targetId: target.id,
                        targetName: target.name
                    });
                }

                return sendFileToChannel(
                    channels.dataDc,
                    channels.controlDc,
                    file,
                    fileId,
                    target.id,
                    file.name,
                    totalChunks,
                    chunkSize,
                    target.name,
                    file.type,
                    isPrivate
                ).then((status) => ({
                    status,
                    targetId: target.id
                }));
            });
        };
        
        // 为每个目标发送文件
        const promises = targets.map(target => {
            control.subPaused[target.id] = false;
            control.subCancelled[target.id] = false;
            control.subOfferStatus[target.id] = requiresOfferApproval ? 'pending' : 'accepted';

            const initialPeer = peersRef.current[target.id];
            const initialChannels = getPeerTransferChannels(initialPeer);
            control.subChannels[target.id] = initialChannels.controlDc;
            control.subDataChannels[target.id] = initialChannels.dataDc;

            if (!requiresOfferApproval) {
                recordFileEvent('image_transfer_started_without_offer', {
                    fileId,
                    fileName: file.name,
                    targetId: target.id,
                    targetName: target.name
                });
                return startTransferToTarget(target);
            }

            setUploadAwaitingProgress(fileId, file, target.id, target.name);

            const offerSent = sendJsonMessage(initialChannels.controlDc, {
                type: 'file-offer',
                fileId,
                name: file.name,
                size: file.size,
                fileType: file.type,
                mode: isPrivate ? 'private' : 'broadcast'
            });

            if (!offerSent) {
                resolveOfferDecision(fileId, target.id, 'cancelled');
                removeTransferProgress(`up-${fileId}-${target.id}`);
                reportFileIssue('file_offer_send_failed', {
                    fileId,
                    fileName: file.name,
                    targetId: target.id,
                    targetName: target.name
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'file-offer'
                    }
                });
                return Promise.resolve({ status: 'failed', targetId: target.id });
            }

            recordFileEvent('file_offer_sent', {
                fileId,
                fileName: file.name,
                targetId: target.id,
                targetName: target.name
            });

            return waitForOfferDecision(fileId, target.id).then((decision) => {
                if (decision !== 'accepted') {
                    removeTransferProgress(`up-${fileId}-${target.id}`);
                    if (decision === 'rejected') {
                        log(`${target.name} 拒绝接收 ${file.name}`);
                        recordFileEvent('file_offer_rejected', {
                            fileId,
                            fileName: file.name,
                            targetId: target.id,
                            targetName: target.name
                        });
                    } else if (decision === 'timeout') {
                        log(`${target.name} 长时间未确认接收 ${file.name}`);
                        recordFileEvent('file_offer_timed_out', {
                            fileId,
                            fileName: file.name,
                            targetId: target.id,
                            targetName: target.name,
                            timeoutMs: OFFER_RESPONSE_TIMEOUT_MS
                        });
                    }
                    return { status: decision, targetId: target.id };
                }

                return startTransferToTarget(target);
            });
        });
        
        const results = await Promise.all(promises);
        
        // 检查是否在传输过程中被取消
        const ctrl = transferControlRef.current[`up-${fileId}`];
        if (!ctrl || ctrl.cancelled) {
            // 已被取消，不添加到聊天记录
            log(`File cancelled: ${file.name}`);
            recordFileEvent('file_send_cancelled', {
                fileId,
                fileName: file.name
            });
            // 清理所有相关的进度条
            setFileProgress(prev => {
                const next = { ...prev };
                Object.keys(next).forEach(key => {
                    if (key.startsWith(`up-${fileId}`)) {
                        delete next[key];
                    }
                });
                return next;
            });
            return;
        }
        
        const sentTargets = results.filter(result => result?.status === 'sent');
        if (sentTargets.length === 0) {
            delete transferControlRef.current[`up-${fileId}`];
            log(`文件未开始传输: ${file.name}`);
            recordFileEvent('file_send_skipped_without_acceptance', {
                fileId,
                fileName: file.name,
                targetCount: targets.length
            });
            return;
        }

        // 清理控制对象
        delete transferControlRef.current[`up-${fileId}`];
        
        // 添加到自己的聊天记录
        const url = URL.createObjectURL(file);
        blobUrlsRef.current.add(url);
        
        const msgObj = {
            type: 'file',
            name: file.name,
            data: url,
            mode: isPrivate ? 'private' : 'broadcast'
        };
        
        if (isPrivate) {
            addChat({ from: 'Me', to: targetUser, ...msgObj });
        } else {
            addChat({ from: 'Me', ...msgObj });
        }
        
        log(`File sent: ${file.name}`);
        recordFileEvent('file_send_completed', {
            fileId,
            fileName: file.name,
            size: file.size,
            targetCount: sentTargets.length
        });
    }, [addChat, blobUrlsRef, getDisplayName, getPeerTransferChannels, log, patchUploadProgress, recordFileEvent, removeTransferProgress, reportFileIssue, resolveOfferDecision, sendJsonMessage, setUploadAwaitingProgress, waitForOfferDecision, waitForPeerTransferChannels]);
    
    /**
     * 向单个 Channel 发送文件
     */
    function sendFileToChannel(dataDc, controlDc, file, fileId, targetId, fileName, totalChunks, chunkSize, targetName, fileType, isPrivate) {
        return new Promise((resolve, reject) => {
            let offset = 0;
            const startTime = Date.now();
            let lastTime = startTime;
            let sendTimer = null;
            const usesDedicatedFileChannel = dataDc !== controlDc;
            const bufferLowThreshold = usesDedicatedFileChannel ? (BUFFER_LOW_THRESHOLD * 2) : BUFFER_LOW_THRESHOLD;
            const maxBufferedAmount = usesDedicatedFileChannel ? (MAX_BUFFERED_AMOUNT * 2) : MAX_BUFFERED_AMOUNT;
            const maxChunksPerBurst = usesDedicatedFileChannel ? (MAX_CHUNKS_PER_BURST * 2) : MAX_CHUNKS_PER_BURST;
            
            const ctrl = transferControlRef.current[`up-${fileId}`];
            if (!ctrl) {
                resolve('cancelled');
                return;
            }

            const getLatestControl = () => transferControlRef.current[`up-${fileId}`];
            const isTargetCancelled = (currentCtrl) => Boolean(currentCtrl?.cancelled || currentCtrl?.subCancelled[targetId]);
            const isTargetPaused = (currentCtrl) => Boolean(currentCtrl?.subPaused[targetId]);
            const cleanupTargetState = () => {
                const latestCtrl = getLatestControl();
                if (!latestCtrl) {
                    return;
                }

                delete latestCtrl.subPaused[targetId];
                delete latestCtrl.subCancelled[targetId];
                delete latestCtrl.subChannels[targetId];
                delete latestCtrl.subDataChannels[targetId];
                delete latestCtrl.subSendBatch[targetId];
            };

            const cleanupChannelLoop = () => {
                if (sendTimer) {
                    clearTimeout(sendTimer);
                    sendTimer = null;
                }
                if (dataDc.onbufferedamountlow === sendBatch) {
                    dataDc.onbufferedamountlow = null;
                }
            };

            const scheduleNextBurst = (delay = 0) => {
                if (sendTimer) {
                    return;
                }

                sendTimer = setTimeout(() => {
                    sendTimer = null;
                    sendBatch();
                }, delay);
            };

            const commitUploadProgress = (force = false) => {
                const now = Date.now();
                if (!force && now - lastTime <= PROGRESS_UPDATE_INTERVAL && chunkCount < totalChunksCount) {
                    return;
                }

                lastTime = now;
                const percent = Math.round((chunkCount / totalChunksCount) * 100);
                const elapsed = (now - startTime) / 1000;
                const speed = elapsed > 0 ? offset / elapsed : 0;
                const remaining = speed > 0 ? (file.size - offset) / speed : 0;

                setFileProgress(prev => {
                    if (!prev[`up-${fileId}-${targetId}`]) return prev;
                    return {
                        ...prev,
                        [`up-${fileId}-${targetId}`]: {
                            ...prev[`up-${fileId}-${targetId}`],
                            percent,
                            sent: formatSize(offset),
                            speed: formatSpeed(speed),
                            remaining: formatTime(remaining)
                        }
                    };
                });
            };
            
            // 发送文件元数据
            const meta = {
                type: 'file-start',
                fileId,
                name: fileName,
                size: file.size,
                fileType: fileType,
                mode: isPrivate ? 'private' : 'broadcast',
                totalChunks
            };
            
            if (!controlDc || controlDc.readyState !== 'open') {
                reportFileIssue('file_channel_not_open', {
                    fileId,
                    fileName,
                    targetId,
                    targetName,
                    readyState: controlDc?.readyState || 'missing'
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'file-send'
                    }
                });
                reject(new Error('Control DataChannel not open'));
                return;
            }

            if (!dataDc || dataDc.readyState !== 'open') {
                reportFileIssue('file_data_channel_not_open', {
                    fileId,
                    fileName,
                    targetId,
                    targetName,
                    readyState: dataDc?.readyState || 'missing'
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'file-send'
                    }
                });
                reject(new Error('File DataChannel not open'));
                return;
            }

            const metaSent = sendJsonMessage(controlDc, meta);
            if (!metaSent) {
                reportFileIssue('file_start_signal_failed', {
                    fileId,
                    fileName,
                    targetId,
                    targetName
                }, {
                    delayMs: 1000,
                    context: {
                        feature: 'file-send'
                    }
                });
                reject(new Error('Failed to send file-start control message'));
                return;
            }
            
            // 初始化进度
            setFileProgress(prev => ({
                ...prev,
                    [`up-${fileId}-${targetId}`]: {
                        controlKey: `up-${fileId}`,
                        type: 'upload',
                    name: fileName,
                    totalSize: formatSize(file.size),
                    sent: formatSize(0),
                    percent: 0,
                    speed: '0 B/s',
                    remaining: 'calculating...',
                        targetId,
                        targetName: targetName,
                        canPause: true,
                    phase: 'transferring',
                    statusText: ''
                }
            }));
            
            let chunkCount = 0;
            const totalChunksCount = totalChunks;
            
            const sendBatch = () => {
                const currentCtrl = getLatestControl();
                if (!currentCtrl) {
                    cleanupChannelLoop();
                    resolve('cancelled');
                    return;
                }
                
                if (isTargetCancelled(currentCtrl)) {
                    cleanupChannelLoop();
                    cleanupTargetState();
                    resolve('cancelled');
                    return;
                }
                
                if (isTargetPaused(currentCtrl)) {
                    patchUploadProgress(fileId, targetId, {
                        phase: 'paused',
                        statusText: '已暂停'
                    });
                    return;
                }
                
                dataDc.bufferedAmountLowThreshold = bufferLowThreshold;

                // 每个 burst 只发送有限分片，避免主线程长时间不让出执行权，
                // 也避免一次性灌太多缓冲导致暂停按钮“看起来没反应”。
                let sentInBurst = 0;
                while (
                    chunkCount < totalChunksCount &&
                    dataDc.bufferedAmount < maxBufferedAmount &&
                    sentInBurst < maxChunksPerBurst
                ) {
                    const liveCtrl = getLatestControl();
                    if (!liveCtrl) {
                        cleanupChannelLoop();
                        resolve('cancelled');
                        return;
                    }

                    if (isTargetCancelled(liveCtrl)) {
                        cleanupChannelLoop();
                        cleanupTargetState();
                        resolve('cancelled');
                        return;
                    }

                    if (isTargetPaused(liveCtrl)) {
                        const waitingForDrain = dataDc.bufferedAmount > 0;
                        patchUploadProgress(fileId, targetId, {
                            phase: waitingForDrain ? 'pausing' : 'paused',
                            statusText: waitingForDrain ? '已暂停，等待缓存排空' : '已暂停'
                        });
                        return;
                    }

                    const start = chunkCount * chunkSize;
                    const end = Math.min(start + chunkSize, file.size);
                    const chunk = file.slice(start, end);
                    
                    try {
                        dataDc.send(chunk);
                        chunkCount++;
                        offset += chunk.size;
                        sentInBurst++;
                        commitUploadProgress(chunkCount >= totalChunksCount);
                    } catch (e) {
                        console.error('Send error:', e);
                        reportFileIssue('file_chunk_send_failed', {
                            fileId,
                            fileName,
                            targetId,
                            targetName,
                            message: e.message,
                            name: e.name || 'Error'
                        }, {
                            delayMs: 1500,
                            context: {
                                feature: 'file-send'
                            }
                        });
                        cleanupChannelLoop();
                        reject(e);
                        return;
                    }
                    
                    if (chunkCount >= totalChunksCount) {
                        break;
                    }
                }

                if (sentInBurst > 0) {
                    // 即使当前只是把数据先送进浏览器缓冲，也要尽快刷新一次上传进度，
                    // 避免发送端长时间停留在 0% 看起来像“卡死”。
                    commitUploadProgress(true);
                }
                
                // 检查是否完成
                if (chunkCount >= totalChunksCount) {
                    // 该目标传输完成
                    cleanupChannelLoop();
                    
                    // 发送完成消息
                    const sent = sendJsonMessage(controlDc, {
                        type: 'file-done',
                        fileId
                    });
                    if (!sent) {
                        reportFileIssue('file_done_signal_failed', {
                            fileId,
                            fileName,
                            targetId,
                            targetName
                        }, {
                            delayMs: 1000,
                            context: {
                                feature: 'file-send'
                            }
                        });
                        reject(new Error('Failed to send file-done control message'));
                        return;
                    }
                    
                    // 删除该目标的进度条
                    setFileProgress(prev => {
                        const next = { ...prev };
                        delete next[`up-${fileId}-${targetId}`];
                        return next;
                    });
                    
                    // 清理该目标的控制引用
                    cleanupTargetState();
                    
                    log(`Sent ${fileName} to ${targetName}`);
                    recordFileEvent('file_target_send_completed', {
                        fileId,
                        fileName,
                        targetId,
                        targetName
                    });
                    resolve('sent');
                    return;
                }

                const latestCtrl = getLatestControl();
                if (isTargetPaused(latestCtrl) || isTargetCancelled(latestCtrl)) {
                    return;
                }

                if (dataDc.bufferedAmount < maxBufferedAmount) {
                    scheduleNextBurst(0);
                    return;
                }

                // 某些浏览器的 bufferedamountlow 触发并不积极，这里保留一个轻量轮询兜底，
                // 避免传输长时间“卡在某一步”。
                scheduleNextBurst(25);
            };
            
            // 存储 sendBatch 函数供暂停/恢复使用
            ctrl.subSendBatch[targetId] = sendBatch;
            
            // 设置事件监听器（只设置一次）
            dataDc.onbufferedamountlow = sendBatch;
            
            // 立即开始发送
            sendBatch();
        });
    }
    
    const handleIncomingFileOffer = useCallback((remoteId, fileMeta) => {
        if (!remoteId || !fileMeta?.fileId || !fileMeta?.name) {
            return;
        }

        const offerKey = `${remoteId}:${fileMeta.fileId}`;
        const existingOffer = incomingFileOffersRef.current[offerKey];
        if (existingOffer?.status === 'pending' || existingOffer?.status === 'accepted') {
            return;
        }

        incomingFileOffersRef.current[offerKey] = {
            remoteId,
            fileId: fileMeta.fileId,
            name: fileMeta.name,
            size: fileMeta.size,
            fileType: fileMeta.fileType,
            mode: fileMeta.mode || 'broadcast',
            status: 'pending'
        };

        addChat({
            from: remoteId,
            to: myId,
            type: 'file-offer',
            fileId: fileMeta.fileId,
            name: fileMeta.name,
            size: fileMeta.size,
            fileType: fileMeta.fileType,
            mode: fileMeta.mode || 'broadcast',
            offerStatus: 'pending'
        });

        recordFileEvent('file_offer_received', {
            fileId: fileMeta.fileId,
            fileName: fileMeta.name,
            fromUserId: remoteId,
            size: fileMeta.size
        });
    }, [addChat, myId, recordFileEvent]);

    const clearIncomingFileOffersForWindow = useCallback((windowUserId) => {
        const removedOfferKeys = [];

        Object.entries(incomingFileOffersRef.current).forEach(([offerKey, offer]) => {
            const offerWindowId = offer.mode === 'private' ? offer.remoteId : null;
            if (offerWindowId !== windowUserId) {
                return;
            }

            if (offer.startTimeoutId) {
                clearTimeout(offer.startTimeoutId);
            }
            if (offer.writer) {
                void settleFileWriter(offer, {
                    abort: true
                });
            }
            removedOfferKeys.push(offerKey);
            delete incomingFileOffersRef.current[offerKey];
        });

        return removedOfferKeys.length;
    }, [settleFileWriter]);

    const clearIncomingFileOfferStartTimer = useCallback((remoteId, fileId) => {
        const offerKey = `${remoteId}:${fileId}`;
        const offer = incomingFileOffersRef.current[offerKey];
        if (offer?.startTimeoutId) {
            clearTimeout(offer.startTimeoutId);
            delete offer.startTimeoutId;
        }
    }, []);

    const handleFileOfferResponse = useCallback((remoteId, message) => {
        const fileId = message?.fileId;
        if (!remoteId || !fileId || !message?.type) {
            return;
        }

        if (message.type === 'file-accept' || message.type === 'file-reject') {
            const decision = message.type === 'file-accept' ? 'accepted' : 'rejected';
            resolveOfferDecision(fileId, remoteId, decision);

            if (decision === 'accepted') {
                recordFileEvent('file_offer_accepted', {
                    fileId,
                    targetId: remoteId
                });
            } else {
                recordFileEvent('file_offer_rejected', {
                    fileId,
                    targetId: remoteId
                });
            }
            return;
        }

        if (message.type === 'file-offer-cancel') {
            const offerKey = `${remoteId}:${fileId}`;
            const offer = incomingFileOffersRef.current[offerKey];
            if (!offer) {
                return;
            }

            clearIncomingFileOfferStartTimer(remoteId, fileId);
            if (offer.writer) {
                void settleFileWriter(offer, {
                    abort: true
                });
            }
            offer.status = 'cancelled';
            updateFileOfferMessage(remoteId, fileId, {
                offerStatus: 'cancelled'
            });
            delete incomingFileOffersRef.current[offerKey];
        }
    }, [clearIncomingFileOfferStartTimer, recordFileEvent, resolveOfferDecision, settleFileWriter, updateFileOfferMessage]);

    const acceptIncomingFileOffer = useCallback(async (fileId, fromUserId) => {
        const offerKey = `${fromUserId}:${fileId}`;
        const offer = incomingFileOffersRef.current[offerKey];
        if (!offer || offer.status !== 'pending') {
            return false;
        }

        const isImageTransfer = isImageFile(offer.name, offer.fileType);

        offer.status = 'preparing';
        updateFileOfferMessage(fromUserId, fileId, {
            offerStatus: 'preparing'
        });

        const shouldStreamToDisk = !isImageTransfer && isModernFileAPISupported();
        if (shouldStreamToDisk) {
            try {
                let preparedTarget = null;

                if (defaultReceiveDirectoryRef.current) {
                    try {
                        preparedTarget = await prepareWriterFromDefaultDirectory(offer.name);
                    } catch (error) {
                        console.warn('Failed to use default receive directory, falling back to save picker:', error);

                        if (['InvalidStateError', 'NotFoundError'].includes(error?.name)) {
                            await clearStoredDefaultReceiveDirectory();
                            applyDefaultReceiveDirectoryState(null, 'not-configured');
                        }
                    }
                }

                if (!preparedTarget) {
                    preparedTarget = await showSaveFilePicker(offer.name);
                }

                const { fileHandle, writer, finalName } = preparedTarget;
                offer.fileHandle = fileHandle;
                offer.writer = writer;
                offer.writerState = 'open';
                offer.saveStrategy = 'disk';
                offer.savedFileName = finalName || offer.name;
            } catch (error) {
                offer.status = 'pending';
                updateFileOfferMessage(fromUserId, fileId, {
                    offerStatus: 'pending'
                });

                if (FILE_PICKER_ABORT_ERROR_NAMES.has(error?.name)) {
                    log(`已取消选择保存位置: ${offer.name}`);
                    recordFileEvent('file_receive_save_picker_cancelled', {
                        fileId,
                        fileName: offer.name,
                        fromUserId
                    });
                    return false;
                }

                console.error('Failed to prepare save location:', error);
                reportFileIssue('file_save_picker_failed', {
                    fileId,
                    fileName: offer.name,
                    fromUserId,
                    message: error?.message || 'unknown',
                    name: error?.name || 'Error'
                }, {
                    delayMs: 1500,
                    context: {
                        feature: 'file-receive'
                    }
                });
                return false;
            }
        } else {
            offer.saveStrategy = 'memory';
            if (!isImageTransfer) {
                const fallbackReason = window.isSecureContext ? 'api-unavailable' : 'insecure-context';
                log(
                    `当前页面环境不支持预先选择保存位置，将先接收到浏览器内存后再下载: ${offer.name}`
                );
                recordFileEvent('file_receive_memory_fallback', {
                    fileId,
                    fileName: offer.name,
                    fromUserId,
                    reason: fallbackReason
                });
            }
        }

        const peer = peersRef.current[fromUserId];
        const { controlDc } = getPeerTransferChannels(peer);
        const sent = sendJsonMessage(controlDc, {
            type: 'file-accept',
            fileId,
            receiverId: myId
        });

        if (!sent) {
            await settleFileWriter(offer, {
                abort: true
            });
            offer.status = 'pending';
            delete offer.writerState;
            offer.saveStrategy = 'memory';
            reportFileIssue('file_accept_send_failed', {
                fileId,
                fromUserId
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-offer'
                }
            });
            updateFileOfferMessage(fromUserId, fileId, {
                offerStatus: 'pending'
            });
            return false;
        }

        offer.status = 'accepted';
        if (offer.startTimeoutId) {
            clearTimeout(offer.startTimeoutId);
        }
        offer.startTimeoutId = setTimeout(() => {
            const latestOffer = incomingFileOffersRef.current[offerKey];
            if (!latestOffer || latestOffer.status !== 'accepted') {
                return;
            }

            delete latestOffer.startTimeoutId;
            if (latestOffer.writer) {
                void settleFileWriter(latestOffer, {
                    abort: true
                });
            }
            latestOffer.status = 'timed_out';
            updateFileOfferMessage(fromUserId, fileId, {
                offerStatus: 'timed_out'
            });
            delete incomingFileOffersRef.current[offerKey];
            reportFileIssue('file_offer_start_timed_out', {
                fileId,
                fromUserId,
                timeoutMs: OFFER_ACCEPTED_START_TIMEOUT_MS
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-offer'
                }
            });
        }, OFFER_ACCEPTED_START_TIMEOUT_MS);
        updateFileOfferMessage(fromUserId, fileId, {
            offerStatus: 'accepted'
        });
        recordFileEvent('file_offer_accepted_locally', {
            fileId,
            fromUserId
        });
        return true;
    }, [getPeerTransferChannels, log, myId, peersRef, recordFileEvent, reportFileIssue, sendJsonMessage, settleFileWriter, updateFileOfferMessage]);

    const rejectIncomingFileOffer = useCallback((fileId, fromUserId) => {
        const offerKey = `${fromUserId}:${fileId}`;
        const offer = incomingFileOffersRef.current[offerKey];
        if (!offer) {
            return false;
        }

        const peer = peersRef.current[fromUserId];
        const { controlDc } = getPeerTransferChannels(peer);
        const sent = sendJsonMessage(controlDc, {
            type: 'file-reject',
            fileId,
            receiverId: myId
        });

        if (!sent) {
            reportFileIssue('file_reject_send_failed', {
                fileId,
                fromUserId
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-offer'
                }
            });
            return false;
        }

        offer.status = 'rejected';
        updateFileOfferMessage(fromUserId, fileId, {
            offerStatus: 'rejected'
        });
        delete incomingFileOffersRef.current[offerKey];
        recordFileEvent('file_offer_rejected_locally', {
            fileId,
            fromUserId
        });
        return true;
    }, [getPeerTransferChannels, myId, peersRef, recordFileEvent, reportFileIssue, sendJsonMessage, updateFileOfferMessage]);

    const markIncomingFileOfferReceiving = useCallback((remoteId, fileId) => {
        if (!remoteId || !fileId) {
            return;
        }

        const offerKey = `${remoteId}:${fileId}`;
        if (incomingFileOffersRef.current[offerKey]) {
            clearIncomingFileOfferStartTimer(remoteId, fileId);
            incomingFileOffersRef.current[offerKey].status = 'receiving';
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'receiving'
        });
    }, [clearIncomingFileOfferStartTimer, updateFileOfferMessage]);

    const markIncomingFileOfferCompleted = useCallback((remoteId, fileId) => {
        if (!remoteId || !fileId) {
            return;
        }

        const offerKey = `${remoteId}:${fileId}`;
        if (incomingFileOffersRef.current[offerKey]) {
            clearIncomingFileOfferStartTimer(remoteId, fileId);
            incomingFileOffersRef.current[offerKey].status = 'completed';
            delete incomingFileOffersRef.current[offerKey];
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'completed'
        });
    }, [clearIncomingFileOfferStartTimer, updateFileOfferMessage]);

    const markIncomingFileOfferCancelled = useCallback((remoteId, fileId) => {
        if (!remoteId || !fileId) {
            return;
        }

        const offerKey = `${remoteId}:${fileId}`;
        if (incomingFileOffersRef.current[offerKey]) {
            clearIncomingFileOfferStartTimer(remoteId, fileId);
            incomingFileOffersRef.current[offerKey].status = 'cancelled';
            delete incomingFileOffersRef.current[offerKey];
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'cancelled'
        });
    }, [clearIncomingFileOfferStartTimer, updateFileOfferMessage]);

    const getIncomingTransferEntry = useCallback((remoteId, fileId = null) => {
        const transfers = incomingFilesRef.current[remoteId];
        if (!transfers) {
            return null;
        }

        if (fileId) {
            const transfer = transfers[fileId];
            return transfer ? { fileId, transfer } : null;
        }

        for (const [currentFileId, transfer] of Object.entries(transfers)) {
            if (transfer.received < transfer.meta.size || !transfer.doneReceived) {
                return { fileId: currentFileId, transfer };
            }
        }

        return null;
    }, [incomingFilesRef]);

    const pushPendingIncomingChunk = useCallback((remoteId, chunk) => {
        if (!pendingIncomingChunksRef.current[remoteId]) {
            pendingIncomingChunksRef.current[remoteId] = [];
        }
        pendingIncomingChunksRef.current[remoteId].push(chunk);
    }, []);

    const takePendingIncomingChunks = useCallback((remoteId) => {
        const chunks = pendingIncomingChunksRef.current[remoteId] || [];
        delete pendingIncomingChunksRef.current[remoteId];
        return chunks;
    }, []);

    const markPendingIncomingDone = useCallback((remoteId, fileId) => {
        if (!pendingIncomingDoneRef.current[remoteId]) {
            pendingIncomingDoneRef.current[remoteId] = {};
        }
        pendingIncomingDoneRef.current[remoteId][fileId] = true;
    }, []);

    const takePendingIncomingDone = useCallback((remoteId, fileId) => {
        const pending = pendingIncomingDoneRef.current[remoteId];
        if (!pending?.[fileId]) {
            return false;
        }

        delete pending[fileId];
        if (Object.keys(pending).length === 0) {
            delete pendingIncomingDoneRef.current[remoteId];
        }
        return true;
    }, []);

    const clearPendingIncomingState = useCallback((remoteId, fileId = null) => {
        if (fileId) {
            const pendingDone = pendingIncomingDoneRef.current[remoteId];
            if (pendingDone) {
                delete pendingDone[fileId];
                if (Object.keys(pendingDone).length === 0) {
                    delete pendingIncomingDoneRef.current[remoteId];
                }
            }
        } else {
            delete pendingIncomingDoneRef.current[remoteId];
        }

        if (!incomingFilesRef.current[remoteId] || Object.keys(incomingFilesRef.current[remoteId]).length === 0) {
            delete pendingIncomingChunksRef.current[remoteId];
        }
    }, [incomingFilesRef]);

    const appendIncomingChunkToTransfer = useCallback(async (fileId, transfer, chunk) => {
        const control = transferControlRef.current[`down-${fileId}`];

        if (control?.cancelled) {
            await settleFileWriter(transfer, {
                abort: true
            });
            return false;
        }

        if (transfer.received >= transfer.meta.size) {
            return true;
        }

        if (transfer.writer) {
            await transfer.writer.write(chunk);
        }
        if (transfer.chunks) {
            transfer.chunks.push(chunk);
        }

        transfer.received += typeof chunk?.byteLength === 'number' ? chunk.byteLength : (chunk?.size || 0);

        if (!control?.paused) {
            const now = Date.now();
            const elapsed = (now - transfer.startTime) / 1000;
            const percent = Math.round((transfer.received / transfer.meta.size) * 100);
            const speed = elapsed > 0 ? transfer.received / elapsed : 0;
            const remaining = speed > 0 ? (transfer.meta.size - transfer.received) / speed : 0;

            if (now - transfer.lastUpdateTime > PROGRESS_UPDATE_INTERVAL) {
                transfer.lastUpdateTime = now;
                patchDownloadProgress(fileId, {
                    name: transfer.meta.name,
                    type: 'download',
                    percent,
                    speed: formatSpeed(speed),
                    totalSize: formatSize(transfer.meta.size),
                    received: formatSize(transfer.received),
                    remaining: formatTime(remaining)
                });
            }
        }

        if (transfer.received >= transfer.meta.size) {
            removeTransferProgress(`down-${fileId}`);
            return true;
        }

        return false;
    }, [patchDownloadProgress, removeTransferProgress, settleFileWriter, transferControlRef]);

    /**
     * 初始化文件接收
     */
    const initFileReceive = useCallback(async (remoteId, fileMeta) => {
        const offerKey = `${remoteId}:${fileMeta.fileId}`;
        const offer = incomingFileOffersRef.current[offerKey];
        if (offer?.status === 'rejected' || offer?.status === 'cancelled') {
            reportFileIssue('file_receive_blocked_after_reject', {
                fileId: fileMeta.fileId,
                fromUserId: remoteId,
                status: offer.status
            }, {
                delayMs: 1000,
                context: {
                    feature: 'file-receive'
                }
            });
            return false;
        }

        if (!incomingFilesRef.current[remoteId]) {
            incomingFilesRef.current[remoteId] = {};
        }
        
        const isImage = isImageFile(fileMeta.name, fileMeta.fileType);
        const usesStreamToDisk = Boolean(offer?.writer) && !isImage;
        const preparedFileHandle = usesStreamToDisk ? offer.fileHandle || null : null;
        const preparedWriter = usesStreamToDisk ? offer.writer : null;
        const preparedWriterState = usesStreamToDisk ? (offer.writerState || 'open') : 'none';

        incomingFilesRef.current[remoteId][fileMeta.fileId] = {
            meta: fileMeta,
            received: 0,
            chunks: usesStreamToDisk ? null : [],
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            doneReceived: takePendingIncomingDone(remoteId, fileMeta.fileId),
            finalizing: false,
            fileHandle: preparedFileHandle,
            writer: preparedWriter,
            writerState: preparedWriterState,
            storageMode: usesStreamToDisk ? 'disk' : 'memory',
            savedFileName: usesStreamToDisk ? (offer?.savedFileName || fileMeta.name) : fileMeta.name
        };

        if (offer) {
            offer.fileHandle = null;
            offer.writer = null;
            delete offer.writerState;
            delete offer.savedFileName;
        }

        recordFileEvent('file_receive_started', {
            fileId: fileMeta.fileId,
            fileName: fileMeta.name,
            size: fileMeta.size,
            fromUserId: remoteId,
            mode: fileMeta.mode || 'broadcast',
            storageMode: usesStreamToDisk ? 'disk' : 'memory'
        });
        
        const fileId = fileMeta.fileId;
        transferControlRef.current[`down-${fileId}`] = {
            cancelled: false,
            paused: false,
            setPausedState: (paused, options = {}) => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (!ctrl) return;

                const {
                    notifyRemote = true,
                    statusText = paused ? '已暂停' : ''
                } = options;

                ctrl.paused = paused;
                patchDownloadProgress(fileId, {
                    statusText
                });

                const peer = peersRef.current[remoteId];
                const { controlDc } = getPeerTransferChannels(peer);
                if (notifyRemote && controlDc && controlDc.readyState === 'open') {
                    try {
                        controlDc.send(JSON.stringify({
                            type: paused ? 'pause-transfer-by-receiver' : 'resume-transfer-by-receiver',
                            fileId: fileId,
                            receiverId: myId
                        }));
                    } catch (e) {
                        console.error(`Failed to send ${paused ? 'pause' : 'resume'} signal:`, e);
                    }
                }
            },
            pause: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                ctrl?.setPausedState?.(true, {
                    notifyRemote: true,
                    statusText: '已请求暂停，等待对端停止发送'
                });
            },
            resume: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                ctrl?.setPausedState?.(false, {
                    notifyRemote: true,
                    statusText: ''
                });
            },
            handleSenderCancelled: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (!ctrl) return;

                ctrl.cancelled = true;
                void cleanupIncomingTransfer(remoteId, fileId, {
                    abortWriter: true
                });
            },
            cancel: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (!ctrl) return;
                
                ctrl.cancelled = true;
                ctrl.handleSenderCancelled?.();
                
                const peer = peersRef.current[remoteId];
                const { controlDc } = getPeerTransferChannels(peer);
                if (controlDc && controlDc.readyState === 'open') {
                    try {
                        controlDc.send(JSON.stringify({
                            type: 'cancel-transfer-by-receiver',
                            fileId: fileId,
                            receiverId: myId
                        }));
                    } catch (e) {
                        console.error('Failed to send cancel signal:', e);
                    }
                }
                
                log(`已取消接收: ${fileMeta.name}`);
                recordFileEvent('file_receive_cancelled', {
                    fileId,
                    fileName: fileMeta.name,
                    fromUserId: remoteId
                });
            }
        };
        
        // 初始化进度
        setFileProgress(prev => ({
            ...prev,
            [`down-${fileId}`]: {
                type: 'download',
                name: fileMeta.name,
                totalSize: formatSize(fileMeta.size),
                received: formatSize(0),
                percent: 0,
                speed: '0 B/s',
                remaining: 'calculating...',
                fromName: getDisplayName(remoteId) // 添加发送者名称
            }
        }));
        
        const transfer = incomingFilesRef.current[remoteId]?.[fileId];
        const bufferedChunks = takePendingIncomingChunks(remoteId);
        for (const chunk of bufferedChunks) {
            if (!transfer || transfer.finalizing) {
                break;
            }
            await appendIncomingChunkToTransfer(fileId, transfer, chunk);
        }

        if (transfer?.doneReceived && transfer.received >= transfer.meta.size) {
            queueMicrotask(() => {
                void finalizeIncomingFile(remoteId, fileId);
            });
        }
        
        return true;
    }, [appendIncomingChunkToTransfer, cleanupIncomingTransfer, getDisplayName, getPeerTransferChannels, log, myId, patchDownloadProgress, peersRef, recordFileEvent, reportFileIssue, setFileProgress, takePendingIncomingChunks, takePendingIncomingDone]);

    const finalizeIncomingFile = useCallback(async (remoteId, fileId) => {
        const transfer = incomingFilesRef.current[remoteId]?.[fileId];
        if (!transfer || transfer.finalizing || !transfer.doneReceived || transfer.received < transfer.meta.size) {
            return false;
        }

        transfer.finalizing = true;

        log(`✅ File received: ${transfer.meta.name}`);

        const diskWriteCompleted = transfer.storageMode !== 'disk' || await settleFileWriter(transfer, {
            abort: false
        });

        let fileUrl = null;
        if (transfer.chunks && transfer.chunks.length > 0) {
            const blob = new Blob(transfer.chunks, { type: transfer.meta.fileType });
            fileUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.add(fileUrl);
        } else if (transfer.storageMode !== 'disk') {
            log(`⚠️ Warning: No chunks data for ${transfer.meta.name}`);
        }

        if (fileUrl) {
            addChat({
                from: remoteId,
                type: 'file',
                name: transfer.meta.name,
                data: fileUrl,
                mode: transfer.meta.mode || 'broadcast',
                savedToDisk: false
            });
        } else if (transfer.storageMode === 'disk' && diskWriteCompleted) {
            addChat({
                from: remoteId,
                type: 'file',
                name: transfer.savedFileName || transfer.meta.name,
                data: 'file-saved-to-disk',
                mode: transfer.meta.mode || 'broadcast',
                savedToDisk: true
            });
        } else if (transfer.storageMode === 'disk' && !diskWriteCompleted) {
            log(`文件保存失败: ${transfer.meta.name}`);
        }

        await cleanupIncomingTransfer(remoteId, fileId, {
            abortWriter: false
        });
        markIncomingFileOfferCompleted(remoteId, fileId);
        return true;
    }, [addChat, blobUrlsRef, cleanupIncomingTransfer, incomingFilesRef, log, markIncomingFileOfferCompleted, settleFileWriter]);

    const handleIncomingFileChunk = useCallback(async (remoteId, chunk) => {
        const entry = getIncomingTransferEntry(remoteId);
        if (!entry) {
            pushPendingIncomingChunk(remoteId, chunk);
            return true;
        }

        const { fileId, transfer } = entry;
        const chunkCompletedFile = await appendIncomingChunkToTransfer(fileId, transfer, chunk);
        if (chunkCompletedFile && transfer.doneReceived) {
            await finalizeIncomingFile(remoteId, fileId);
        }

        return true;
    }, [appendIncomingChunkToTransfer, finalizeIncomingFile, getIncomingTransferEntry, pushPendingIncomingChunk]);

    const handleIncomingFileMessage = useCallback(async (remoteId, message) => {
        if (!remoteId || !message?.type) {
            return false;
        }

        switch (message.type) {
            case 'cancel-transfer': {
                const control = transferControlRef.current[`down-${message.fileId}`];
                if (control) {
                    log('发送方已取消传输');
                    control.handleSenderCancelled?.();
                }
                clearPendingIncomingState(remoteId, message.fileId);
                markIncomingFileOfferCancelled(remoteId, message.fileId);
                return true;
            }
            case 'pause-transfer-by-sender': {
                const control = transferControlRef.current[`down-${message.fileId}`];
                if (control) {
                    log('发送端已暂停发送');
                    control.setPausedState?.(true, {
                        notifyRemote: false,
                        statusText: '发送端已暂停'
                    });
                }
                return true;
            }
            case 'resume-transfer-by-sender': {
                const control = transferControlRef.current[`down-${message.fileId}`];
                if (control) {
                    log('发送端已恢复发送');
                    control.setPausedState?.(false, {
                        notifyRemote: false,
                        statusText: ''
                    });
                }
                return true;
            }
            case 'pause-transfer-by-receiver': {
                const control = transferControlRef.current[`up-${message.fileId}`];
                if (control && message.receiverId) {
                    log(`接收端 ${message.receiverId} 已暂停接收`);
                    control.pauseTarget?.(message.receiverId, {
                        notifyRemote: false,
                        phase: 'paused',
                        statusText: `${getDisplayName(message.receiverId)} 已暂停接收`
                    });
                }
                return true;
            }
            case 'resume-transfer-by-receiver': {
                const control = transferControlRef.current[`up-${message.fileId}`];
                if (control && message.receiverId) {
                    log(`接收端 ${message.receiverId} 已恢复接收`);
                    control.resumeTarget?.(message.receiverId, {
                        notifyRemote: false,
                        phase: 'transferring',
                        statusText: ''
                    });
                }
                return true;
            }
            case 'cancel-transfer-by-receiver': {
                const control = transferControlRef.current[`up-${message.fileId}`];
                if (control && message.receiverId) {
                    log(`接收端 ${message.receiverId} 已取消接收`);
                    control.cancelTarget?.(message.receiverId, {
                        notifyRemote: false,
                        logCancel: false
                    });
                }
                return true;
            }
            case 'file-done': {
                const entry = getIncomingTransferEntry(remoteId, message.fileId);
                if (!entry) {
                    markPendingIncomingDone(remoteId, message.fileId);
                    return true;
                }

                entry.transfer.doneReceived = true;
                if (entry.transfer.received >= entry.transfer.meta.size) {
                    await finalizeIncomingFile(remoteId, message.fileId);
                }
                return true;
            }
            case 'file-offer':
                handleIncomingFileOffer(remoteId, message);
                return true;
            case 'file-accept':
            case 'file-reject':
            case 'file-offer-cancel':
                handleFileOfferResponse(remoteId, message);
                return true;
            case 'file-start':
                markIncomingFileOfferReceiving(remoteId, message.fileId);
                await initFileReceive(remoteId, message);
                return true;
            default:
                return false;
        }
    }, [
        clearPendingIncomingState,
        finalizeIncomingFile,
        getIncomingTransferEntry,
        getDisplayName,
        handleFileOfferResponse,
        handleIncomingFileOffer,
        initFileReceive,
        log,
        markPendingIncomingDone,
        markIncomingFileOfferCancelled,
        markIncomingFileOfferReceiving,
        transferControlRef
    ]);

    const getTransferPausedState = useCallback((controlKey, { type, targetId } = {}) => {
        const control = transferControlRef.current[controlKey];
        if (!control) {
            return false;
        }

        if (type === 'upload' && targetId) {
            return Boolean(control.subPaused?.[targetId]);
        }

        return Boolean(control.paused);
    }, []);

    const toggleTransferPause = useCallback((controlKey, { type, targetId } = {}) => {
        const control = transferControlRef.current[controlKey];
        if (!control) {
            return false;
        }

        if (type === 'upload' && targetId) {
            if (control.subPaused?.[targetId]) {
                control.resumeTarget?.(targetId);
            } else {
                control.pauseTarget?.(targetId);
            }
            return true;
        }

        if (control.paused) {
            control.resume?.();
        } else {
            control.pause?.();
        }
        return true;
    }, []);

    const cancelTransfer = useCallback((controlKey, { type, targetId } = {}) => {
        const control = transferControlRef.current[controlKey];
        if (!control) {
            return false;
        }

        if (type === 'upload' && targetId) {
            control.cancelTarget?.(targetId);
            return true;
        }

        control.cancel?.();
        return true;
    }, []);
    
    return {
        fileProgress,
        setFileProgress,
        transferControlRef,
        incomingFilesRef,
        isSendingFileRef,
        fileQueueRef,
        sendFile,
        initFileReceive,
        processFileQueue,
        handleIncomingFileOffer,
        handleFileOfferResponse,
        clearIncomingFileOffersForWindow,
        acceptIncomingFileOffer,
        rejectIncomingFileOffer,
        markIncomingFileOfferReceiving,
        markIncomingFileOfferCompleted,
        markIncomingFileOfferCancelled,
        handleIncomingFileChunk,
        handleIncomingFileMessage,
        getTransferPausedState,
        toggleTransferPause,
        cancelTransfer,
        defaultReceiveDirectory,
        receiveDirectoryBusy,
        configureDefaultReceiveDirectory,
        clearDefaultReceiveDirectory
    };
}
