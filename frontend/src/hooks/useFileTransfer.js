import { useState, useRef, useCallback } from 'react';
import CryptoJS from 'crypto-js';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters';
import { isImageFile, isModernFileAPISupported } from '../utils/fileUtils';

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
 * @returns {Object} 文件传输相关的状态和方法
 */
export function useFileTransfer({ log, addChat, peersRef, myId, getDisplayName, blobUrlsRef, activeUser }) {
    const [fileProgress, setFileProgress] = useState({});
    
    const transferControlRef = useRef({});
    const incomingFilesRef = useRef({});
    const fileQueueRef = useRef([]);
    const isSendingFileRef = useRef(false);
    
    /**
     * 发送文件
     */
    const sendFile = useCallback(async (file) => {
        if (file.size > 2 * 1024 * 1024 * 1024) {
            alert(`文件 "${file.name}" 过大（最大支持 2GB）\n当前文件大小：${formatSize(file.size)}`);
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
    }, [activeUser]);
    
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
        const chunkSize = 32 * 1024; // 32KB
        const totalChunks = Math.ceil(file.size / chunkSize);
        
        // 检查文件是否有效
        if (!file || file.size === undefined) {
            throw new Error('Invalid file object');
        }
        
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
        
        // 更新状态为"计算哈希中"
        setFileProgress(prev => ({
            ...prev,
            [`up-${fileId}-preparing`]: {
                type: 'upload',
                name: file.name,
                totalSize: formatSize(file.size),
                sent: '准备中...',
                percent: 0,
                speed: '',
                remaining: '正在计算文件哈希...'
            }
        }));
        
        // 计算 MD5
        const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);
        const md5Hash = CryptoJS.MD5(wordArray).toString(CryptoJS.enc.Base64);
        
        // 清理准备中的进度条
        setFileProgress(prev => {
            const next = { ...prev };
            delete next[`up-${fileId}-preparing`];
            return next;
        });
        
        const isPrivate = targetUser !== null;
        
        // 获取目标的 DataChannel 和 ID
        let targets;
        if (isPrivate) {
            // 私聊：只发送给指定用户
            const peer = peersRef.current[targetUser];
            if (peer && peer.dc) {
                targets = [{
                    id: targetUser,
                    dc: peer.dc,
                    name: getDisplayName(targetUser)
                }];
            } else {
                targets = [];
            }
        } else {
            // 广播：发送给所有在线用户
            targets = Object.entries(peersRef.current).map(([id, peer]) => ({
                id,
                dc: peer.dc,
                name: getDisplayName(id)
            }));
        }
        
        if (targets.length === 0) {
            log('No connected peers to send file');
            return;
        }
        
        // 创建文件传输控制对象
        const control = {
            paused: false,
            cancelled: false,
            subPaused: {},
            subCancelled: {},
            subChannels: {},
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
                    if (channel && channel.readyState === 'open') {
                        try {
                            channel.send(JSON.stringify({
                                type: 'pause-transfer-by-sender',
                                fileId: fileId
                            }));
                        } catch (e) {
                            console.error('Failed to send pause signal:', e);
                        }
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
                    if (channel && channel.readyState === 'open') {
                        try {
                            channel.send(JSON.stringify({
                                type: 'resume-transfer-by-sender',
                                fileId: fileId
                            }));
                        } catch (e) {
                            console.error('Failed to send resume signal:', e);
                        }
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
                    if (channel) {
                        channel.onbufferedamountlow = null;
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
            control.subChannels[target.id] = target.dc;
            
            return sendFileToChannel(
                target.dc,
                arrayBuffer,
                fileId,
                target.id,
                file.name,
                totalChunks,
                chunkSize,
                target.name,
                file.type,
                md5Hash,
                isPrivate
            );
        });
        
        await Promise.all(promises);
        
        // 检查是否在传输过程中被取消
        const ctrl = transferControlRef.current[`up-${fileId}`];
        if (!ctrl || ctrl.cancelled) {
            // 已被取消，不添加到聊天记录
            log(`File cancelled: ${file.name}`);
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
    }, [log, peersRef, getDisplayName, addChat, blobUrlsRef, setFileProgress]);
    
    /**
     * 向单个 Channel 发送文件
     */
    const sendFileToChannel = useCallback((dc, arrayBuffer, fileId, targetId, fileName, totalChunks, chunkSize, targetName, fileType, md5Hash, isPrivate) => {
        return new Promise((resolve, reject) => {
            let offset = 0;
            const startTime = Date.now();
            let lastTime = startTime;
            let lastSent = 0;
            
            const ctrl = transferControlRef.current[`up-${fileId}`];
            
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
            
            if (dc.readyState === 'open') {
                dc.send(JSON.stringify(meta));
            } else {
                reject(new Error('DataChannel not open'));
                return;
            }
            
            // 初始化进度
            setFileProgress(prev => ({
                ...prev,
                [`up-${fileId}-${targetId}`]: {
                    type: 'upload',
                    name: fileName,
                    totalSize: formatSize(arrayBuffer.byteLength),
                    sent: formatSize(0),
                    percent: 0,
                    speed: '0 B/s',
                    remaining: 'calculating...',
                    targetName: targetName
                }
            }));
            
            let chunkCount = 0;
            const totalChunksCount = Math.ceil(arrayBuffer.byteLength / chunkSize);
            
            const sendBatch = () => {
                // 检查控制对象是否还存在
                if (!ctrl) {
                    dc.onbufferedamountlow = null;
                    resolve();
                    return;
                }
                
                // 先检查是否取消（优先级最高）
                if (ctrl.subCancelled[targetId]) {
                    dc.onbufferedamountlow = null;
                    resolve();
                    return;
                }
                
                // 再检查是否暂停
                if (ctrl.subPaused[targetId]) {
                    return; // 暂停中，等待恢复
                }
                
                // 动态调整阈值
                if (totalChunksCount - chunkCount > 16) {
                    dc.bufferedAmountLowThreshold = 16 * chunkSize; // 512KB
                } else {
                    dc.bufferedAmountLowThreshold = 0;
                }
                
                // 批量发送 32 个 chunk
                for (let i = 0; i < 32 && chunkCount < totalChunksCount; i++) {
                    const start = chunkCount * chunkSize;
                    const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
                    const chunk = arrayBuffer.slice(start, end);
                    
                    try {
                        dc.send(chunk);
                        chunkCount++;
                        offset += chunk.byteLength;
                        
                        // 计算进度
                        const now = Date.now();
                        const percent = Math.round((chunkCount / totalChunksCount) * 100);
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? offset / elapsed : 0;
                        const remaining = speed > 0 ? (arrayBuffer.byteLength - offset) / speed : 0;
                        
                        // 每 100ms 更新一次进度
                        if (now - lastTime > 100 || chunkCount >= totalChunksCount) {
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
                    dc.onbufferedamountlow = null;
                    
                    // 发送完成消息和 hash
                    dc.send(JSON.stringify({
                        type: 'file-done',
                        fileId,
                        hash: md5Hash
                    }));
                    
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
                        delete ctrl.subSendBatch[targetId];
                    }
                    
                    log(`Sent ${fileName} to ${targetName}`);
                    resolve();
                    return;
                }
                // 如果未完成，事件监听器会在缓冲区低于阈值时自动触发 sendBatch
            };
            
            // 存储 sendBatch 函数供暂停/恢复使用
            ctrl.subSendBatch[targetId] = sendBatch;
            
            // 设置事件监听器（只设置一次）
            dc.onbufferedamountlow = sendBatch;
            
            // 立即开始发送
            sendBatch();
        });
    }, [log]);
    
    /**
     * 初始化文件接收
     */
    const initFileReceive = useCallback(async (remoteId, fileMeta) => {
        if (!incomingFilesRef.current[remoteId]) {
            incomingFilesRef.current[remoteId] = {};
        }
        
        const isImage = isImageFile(fileMeta.name, fileMeta.fileType);
        
        // 统一使用 chunks 数组方式（禁用现代 API）
        incomingFilesRef.current[remoteId][fileMeta.fileId] = {
            meta: fileMeta,
            received: 0,
            chunks: [],  // 总是使用数组存储
            hasher: CryptoJS.algo.MD5.create(),
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            fileHandle: null,
            writer: null
        };
        
        const fileId = fileMeta.fileId;
        transferControlRef.current[`down-${fileId}`] = {
            cancelled: false,
            paused: false,
            pause: () => {
                const ctrl = transferControlRef.current[`down-${fileId}`];
                if (ctrl) {
                    ctrl.paused = true;
                    const peer = peersRef.current[remoteId];
                    if (peer?.dc && peer.dc.readyState === 'open') {
                        try {
                            peer.dc.send(JSON.stringify({
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
                    if (peer?.dc && peer.dc.readyState === 'open') {
                        try {
                            peer.dc.send(JSON.stringify({
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
                if (peer?.dc && peer.dc.readyState === 'open') {
                    try {
                        peer.dc.send(JSON.stringify({
                            type: 'cancel-transfer-by-receiver',
                            fileId: fileId,
                            receiverId: myId
                        }));
                    } catch (e) {
                        console.error('Failed to send cancel signal:', e);
                    }
                }
                
                log(`已取消接收: ${fileMeta.name}`);
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
    }, [log, peersRef, myId, setFileProgress]);
    
    return {
        fileProgress,
        setFileProgress,
        transferControlRef,
        incomingFilesRef,
        isSendingFileRef,
        fileQueueRef,
        sendFile,
        initFileReceive,
        processFileQueue
    };
}
