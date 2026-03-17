import { useState, useRef, useCallback } from 'react';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters';
import { isImageFile, isModernFileAPISupported } from '../utils/fileUtils';
import { FILE_TRANSFER_CONFIG } from '../constants/config';

const {
    CHUNK_SIZE,
    MAX_CHUNKS_PER_BURST,
    MAX_BUFFERED_AMOUNT,
    BUFFER_LOW_THRESHOLD,
    PROGRESS_UPDATE_INTERVAL
} = FILE_TRANSFER_CONFIG;

const OFFER_RESPONSE_TIMEOUT_MS = 60_000;

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
    
    const transferControlRef = useRef({});
    const incomingFilesRef = useRef({});
    const incomingFileOffersRef = useRef({});
    const fileQueueRef = useRef([]);
    const isSendingFileRef = useRef(false);

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

    const getPeerTransferChannels = useCallback((peer) => {
        const controlDc = peer?.chatDc || peer?.dc || peer?.fileDc || null;
        const dataDc = (peer?.fileDc && peer.fileDc.readyState === 'open')
            ? peer.fileDc
            : (peer?.dc || peer?.chatDc || peer?.fileDc || null);

        return {
            controlDc,
            dataDc
        };
    }, []);

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
        
        // 检查文件是否有效
        if (!file || file.size === undefined) {
            throw new Error('Invalid file object');
        }

        recordFileEvent('file_send_started', {
            fileId,
            fileName: file.name,
            size: file.size,
            targetUser,
            mode: targetUser !== null ? 'private' : 'broadcast'
        });
        
        // 立即显示"准备中"状态的进度条
        setFileProgress(prev => ({
            ...prev,
            [`up-${fileId}-preparing`]: {
                type: 'upload',
                name: file.name,
                totalSize: formatSize(file.size),
                sent: '准备中...',
                percent: 0,
                speed: '',
                remaining: '正在读取文件...'
            }
        }));
        
        // 读取文件内容
        let arrayBuffer;
        try {
            arrayBuffer = await file.arrayBuffer();
        } catch (error) {
            // 清理准备中的进度条
            setFileProgress(prev => {
                const next = { ...prev };
                delete next[`up-${fileId}-preparing`];
                return next;
            });
            throw new Error(`Failed to read file: ${error.message}`);
        }
        
        // 清理准备中的进度条
        setFileProgress(prev => {
            const next = { ...prev };
            delete next[`up-${fileId}-preparing`];
            return next;
        });
        
        const isPrivate = targetUser !== null;
        
        // 获取目标的通道。控制消息优先走 chat 通道，文件二进制优先走 file 通道。
        let targets;
        if (isPrivate) {
            // 私聊：只发送给指定用户
            const peer = peersRef.current[targetUser];
            const { controlDc, dataDc } = getPeerTransferChannels(peer);
            if (peer && controlDc && dataDc) {
                targets = [{
                    id: targetUser,
                    controlDc,
                    dataDc,
                    name: getDisplayName(targetUser)
                }];
            } else {
                targets = [];
            }
        } else {
            // 广播：发送给所有在线用户
            targets = Object.entries(peersRef.current)
                .map(([id, peer]) => {
                    const { controlDc, dataDc } = getPeerTransferChannels(peer);
                    if (!controlDc || !dataDc) {
                        return null;
                    }
                    return {
                        id,
                        controlDc,
                        dataDc,
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
            pause: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.paused = true;
                Object.keys(ctrl.subPaused).forEach(id => {
                    ctrl.subPaused[id] = true;
                });
                
                // 通知所有接收端暂停
                Object.entries(ctrl.subChannels).forEach(([id, channel]) => {
                    if (ctrl.subOfferStatus[id] !== 'accepted') {
                        return;
                    }
                    try {
                        sendJsonMessage(channel, {
                            type: 'pause-transfer-by-sender',
                            fileId: fileId
                        });
                    } catch (e) {
                        console.error('Failed to send pause signal:', e);
                    }
                });
            },
            resume: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.paused = false;
                Object.keys(ctrl.subPaused).forEach(id => {
                    ctrl.subPaused[id] = false;
                });
                
                // 通知所有接收端恢复
                Object.entries(ctrl.subChannels).forEach(([id, channel]) => {
                    if (ctrl.subOfferStatus[id] !== 'accepted') {
                        return;
                    }
                    try {
                        sendJsonMessage(channel, {
                            type: 'resume-transfer-by-sender',
                            fileId: fileId
                        });
                    } catch (e) {
                        console.error('Failed to send resume signal:', e);
                    }
                });
                
                // 主动触发所有 sendBatch 以恢复发送
                Object.values(ctrl.subSendBatch).forEach(fn => {
                    if (fn) fn();
                });
            },
            cancel: () => {
                const ctrl = transferControlRef.current[`up-${fileId}`];
                if (!ctrl) return;
                
                ctrl.cancelled = true;
                Object.keys(ctrl.subCancelled).forEach(id => {
                    ctrl.subCancelled[id] = true;
                });
                
                // 先主动触发所有 sendBatch，让它们检查取消状态并 resolve Promise
                Object.values(ctrl.subSendBatch).forEach(fn => {
                    if (fn) {
                        try {
                            fn();
                        } catch (e) {
                            console.error('Error calling sendBatch on cancel:', e);
                        }
                    }
                });
                
                // 然后移除事件监听器和通知接收端
                Object.entries(ctrl.subChannels).forEach(([id, channel]) => {
                    const dataChannel = ctrl.subDataChannels[id];
                    if (dataChannel) {
                        dataChannel.onbufferedamountlow = null;
                    }
                    try {
                        sendJsonMessage(channel, ctrl.subOfferStatus[id] === 'accepted'
                            ? {
                                type: 'cancel-transfer',
                                fileId: fileId
                            }
                            : {
                                type: 'file-offer-cancel',
                                fileId: fileId
                            });
                    } catch (e) {
                        console.error('Failed to send cancel signal:', e);
                    }
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
        
        // 为每个目标发送文件
        const promises = targets.map(target => {
            control.subPaused[target.id] = false;
            control.subCancelled[target.id] = false;
            control.subChannels[target.id] = target.controlDc;
            control.subDataChannels[target.id] = target.dataDc;
            control.subOfferStatus[target.id] = 'pending';
            setUploadAwaitingProgress(fileId, file, target.id, target.name);

            const offerSent = sendJsonMessage(target.controlDc, {
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

                return sendFileToChannel(
                    target.dataDc,
                    target.controlDc,
                    arrayBuffer,
                    fileId,
                    target.id,
                    file.name,
                    totalChunks,
                    chunkSize,
                    target.name,
                    file.type,
                    isPrivate
                ).then(() => ({
                    status: 'sent',
                    targetId: target.id
                }));
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
        const blob = new Blob([arrayBuffer], { type: file.type });
        const url = URL.createObjectURL(blob);
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
    }, [addChat, blobUrlsRef, getDisplayName, getPeerTransferChannels, log, peersRef, recordFileEvent, removeTransferProgress, reportFileIssue, resolveOfferDecision, sendJsonMessage, setUploadAwaitingProgress, waitForOfferDecision]);
    
    /**
     * 向单个 Channel 发送文件
     */
    const sendFileToChannel = useCallback((dataDc, controlDc, arrayBuffer, fileId, targetId, fileName, totalChunks, chunkSize, targetName, fileType, isPrivate) => {
        return new Promise((resolve, reject) => {
            let offset = 0;
            const startTime = Date.now();
            let lastTime = startTime;
            let sendTimer = null;
            
            const ctrl = transferControlRef.current[`up-${fileId}`];
            if (!ctrl) {
                resolve();
                return;
            }

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
            
            // 发送文件元数据
            const meta = {
                type: 'file-start',
                fileId,
                name: fileName,
                size: arrayBuffer.byteLength,
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

            const metaSent = sendJsonMessage(dataDc, meta);
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
                    totalSize: formatSize(arrayBuffer.byteLength),
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
            const totalChunksCount = Math.ceil(arrayBuffer.byteLength / chunkSize);
            
            const sendBatch = () => {
                // 检查控制对象是否还存在
                if (!ctrl) {
                    cleanupChannelLoop();
                    resolve();
                    return;
                }
                
                // 先检查是否取消（优先级最高）
                if (ctrl.subCancelled[targetId]) {
                    cleanupChannelLoop();
                    resolve();
                    return;
                }
                
                // 再检查是否暂停
                if (ctrl.subPaused[targetId]) {
                    return; // 暂停中，等待恢复
                }
                
                dataDc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

                // 每个 burst 只发送有限分片，避免主线程长时间不让出执行权，
                // 也避免一次性灌太多缓冲导致暂停按钮“看起来没反应”。
                let sentInBurst = 0;
                while (
                    chunkCount < totalChunksCount &&
                    dataDc.bufferedAmount < MAX_BUFFERED_AMOUNT &&
                    sentInBurst < MAX_CHUNKS_PER_BURST
                ) {
                    const start = chunkCount * chunkSize;
                    const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
                    const chunk = arrayBuffer.slice(start, end);
                    
                    try {
                        dataDc.send(chunk);
                        chunkCount++;
                        offset += chunk.byteLength;
                        sentInBurst++;
                        
                        // 计算进度
                        const now = Date.now();
                        const percent = Math.round((chunkCount / totalChunksCount) * 100);
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? offset / elapsed : 0;
                        const remaining = speed > 0 ? (arrayBuffer.byteLength - offset) / speed : 0;
                        
                        if (now - lastTime > PROGRESS_UPDATE_INTERVAL || chunkCount >= totalChunksCount) {
                            lastTime = now;
                            setFileProgress(prev => {
                                if (!prev[`up-${fileId}-${targetId}`]) return prev; // 已被取消
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
                        }
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
                
                // 检查是否完成
                if (chunkCount >= totalChunksCount) {
                    // 该目标传输完成
                    cleanupChannelLoop();
                    
                    // 发送完成消息
                    const sent = sendJsonMessage(dataDc, {
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
                    if (ctrl) {
                        delete ctrl.subPaused[targetId];
                        delete ctrl.subCancelled[targetId];
                        delete ctrl.subChannels[targetId];
                        delete ctrl.subDataChannels[targetId];
                        delete ctrl.subSendBatch[targetId];
                    }
                    
                    log(`Sent ${fileName} to ${targetName}`);
                    recordFileEvent('file_target_send_completed', {
                        fileId,
                        fileName,
                        targetId,
                        targetName
                    });
                    resolve();
                    return;
                }

                if (ctrl.subPaused[targetId] || ctrl.subCancelled[targetId]) {
                    return;
                }

                if (dataDc.bufferedAmount < BUFFER_LOW_THRESHOLD) {
                    scheduleNextBurst(0);
                }
                // 如果缓冲区仍然偏高，则等待 bufferedamountlow 再触发下一轮
            };
            
            // 存储 sendBatch 函数供暂停/恢复使用
            ctrl.subSendBatch[targetId] = sendBatch;
            
            // 设置事件监听器（只设置一次）
            dataDc.onbufferedamountlow = sendBatch;
            
            // 立即开始发送
            sendBatch();
        });
    }, [log, recordFileEvent, reportFileIssue, sendJsonMessage, setFileProgress]);
    
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

            offer.status = 'cancelled';
            updateFileOfferMessage(remoteId, fileId, {
                offerStatus: 'cancelled'
            });
            delete incomingFileOffersRef.current[offerKey];
        }
    }, [recordFileEvent, resolveOfferDecision, updateFileOfferMessage]);

    const acceptIncomingFileOffer = useCallback((fileId, fromUserId) => {
        const offerKey = `${fromUserId}:${fileId}`;
        const offer = incomingFileOffersRef.current[offerKey];
        if (!offer) {
            return false;
        }

        const peer = peersRef.current[fromUserId];
        const { controlDc } = getPeerTransferChannels(peer);
        const sent = sendJsonMessage(controlDc, {
            type: 'file-accept',
            fileId,
            receiverId: myId
        });

        if (!sent) {
            reportFileIssue('file_accept_send_failed', {
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

        offer.status = 'accepted';
        updateFileOfferMessage(fromUserId, fileId, {
            offerStatus: 'accepted'
        });
        recordFileEvent('file_offer_accepted_locally', {
            fileId,
            fromUserId
        });
        return true;
    }, [getPeerTransferChannels, myId, peersRef, recordFileEvent, reportFileIssue, sendJsonMessage, updateFileOfferMessage]);

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
            incomingFileOffersRef.current[offerKey].status = 'receiving';
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'receiving'
        });
    }, [updateFileOfferMessage]);

    const markIncomingFileOfferCompleted = useCallback((remoteId, fileId) => {
        if (!remoteId || !fileId) {
            return;
        }

        const offerKey = `${remoteId}:${fileId}`;
        if (incomingFileOffersRef.current[offerKey]) {
            incomingFileOffersRef.current[offerKey].status = 'completed';
            delete incomingFileOffersRef.current[offerKey];
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'completed'
        });
    }, [updateFileOfferMessage]);

    const markIncomingFileOfferCancelled = useCallback((remoteId, fileId) => {
        if (!remoteId || !fileId) {
            return;
        }

        const offerKey = `${remoteId}:${fileId}`;
        if (incomingFileOffersRef.current[offerKey]) {
            incomingFileOffersRef.current[offerKey].status = 'cancelled';
            delete incomingFileOffersRef.current[offerKey];
        }
        updateFileOfferMessage(remoteId, fileId, {
            offerStatus: 'cancelled'
        });
    }, [updateFileOfferMessage]);

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
        
        // 统一使用 chunks 数组方式
        incomingFilesRef.current[remoteId][fileMeta.fileId] = {
            meta: fileMeta,
            received: 0,
            chunks: [],  // 总是使用数组存储
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            fileHandle: null,
            writer: null
        };

        recordFileEvent('file_receive_started', {
            fileId: fileMeta.fileId,
            fileName: fileMeta.name,
            size: fileMeta.size,
            fromUserId: remoteId,
            mode: fileMeta.mode || 'broadcast'
        });
        
        const fileId = fileMeta.fileId;
        transferControlRef.current[`down-${fileId}`] = {
            cancelled: false,
            paused: false,
            pause: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (ctrl) {
                    ctrl.paused = true;
                    const peer = peersRef.current[remoteId];
                    const { controlDc } = getPeerTransferChannels(peer);
                    if (controlDc && controlDc.readyState === 'open') {
                        try {
                            controlDc.send(JSON.stringify({
                                type: 'pause-transfer-by-receiver',
                                fileId: fileId,
                                receiverId: myId
                            }));
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
                    const peer = peersRef.current[remoteId];
                    const { controlDc } = getPeerTransferChannels(peer);
                    if (controlDc && controlDc.readyState === 'open') {
                        try {
                            controlDc.send(JSON.stringify({
                                type: 'resume-transfer-by-receiver',
                                fileId: fileId,
                                receiverId: myId
                            }));
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
        
        // 现代文件 API（已禁用，改为统一使用 Blob URL 下载方式）
        if (false && isModernAPISupported && !isImage) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: fileMeta.name,
                    types: [{
                        description: 'File',
                        accept: { '*/*': [] }
                    }]
                });
                const writer = await fileHandle.createWritable();
                incomingFilesRef.current[remoteId][fileId].fileHandle = fileHandle;
                incomingFilesRef.current[remoteId][fileId].writer = writer;
            } catch (err) {
                // 用户取消或拒绝保存
                if (err.name === 'AbortError' || err.name === 'NotFoundError' || err.name === 'NotAllowedError') {
                    log(`已取消接收: ${fileMeta.name}`);
                    // 清理进度条
                    setFileProgress(prev => {
                        const next = { ...prev };
                        delete next[`down-${fileId}`];
                        return next;
                    });
                    // 通知发送端取消
                    transferControlRef.current[`down-${fileId}`]?.cancel();
                    return false;
                }
                // 其他错误
                console.error('FileSystem API error:', err.name, err.message, err);
                log(`文件保存失败: ${err.message || '未知错误'}`);
                reportFileIssue('file_save_picker_failed', {
                    fileId,
                    fileName: fileMeta.name,
                    fromUserId: remoteId,
                    message: err.message || '未知错误',
                    name: err.name || 'Error'
                }, {
                    delayMs: 1500,
                    context: {
                        feature: 'file-receive'
                    }
                });
                // 清理进度条
                setFileProgress(prev => {
                    const next = { ...prev };
                    delete next[`down-${fileId}`];
                    return next;
                });
                return false;
            }
        }
        
        return true;
    }, [getDisplayName, getPeerTransferChannels, log, myId, peersRef, recordFileEvent, reportFileIssue, setFileProgress]);
    
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
        acceptIncomingFileOffer,
        rejectIncomingFileOffer,
        markIncomingFileOfferReceiving,
        markIncomingFileOfferCompleted,
        markIncomingFileOfferCancelled
    };
}
