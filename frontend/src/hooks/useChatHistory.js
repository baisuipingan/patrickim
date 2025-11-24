import { useCallback } from 'react';

/**
 * 聊天历史管理 Hook
 * 使用 localStorage 保存聊天记录，按用户和房间隔离
 * 
 * @param {string} userId - 当前用户ID
 * @param {string} roomId - 当前房间ID
 * @returns {Object} 聊天历史管理方法
 */
export const useChatHistory = (userId, roomId) => {
    const MAX_MESSAGES = 500; // 最多保存 500 条消息

    /**
     * 生成 localStorage key
     */
    const getStorageKey = useCallback((room) => {
        return `chat_history_${userId}_${room || roomId}`;
    }, [userId, roomId]);

    /**
     * 加载指定房间的聊天历史
     * @param {string} targetRoom - 目标房间ID（可选，默认当前房间）
     * @returns {Array} 聊天消息数组
     */
    const loadChatHistory = useCallback((targetRoom) => {
        try {
            const key = getStorageKey(targetRoom);
            const stored = localStorage.getItem(key);
            if (!stored) return [];
            
            const messages = JSON.parse(stored);
            
            // 验证数据格式
            if (!Array.isArray(messages)) {
                console.warn('Invalid chat history format, clearing...');
                localStorage.removeItem(key);
                return [];
            }
            
            return messages;
        } catch (err) {
            console.error('Failed to load chat history:', err);
            return [];
        }
    }, [getStorageKey]);

    /**
     * 保存聊天消息
     * @param {Array} messages - 消息数组
     * @param {string} targetRoom - 目标房间ID（可选，默认当前房间）
     */
    const saveChatHistory = useCallback((messages, targetRoom) => {
        try {
            const key = getStorageKey(targetRoom);
            
            // 限制消息数量，只保留最新的 MAX_MESSAGES 条
            const limitedMessages = messages.slice(-MAX_MESSAGES);
            
            // 过滤掉不需要保存的消息（如文件 Blob URLs 会过期）
            const messagesToSave = limitedMessages.map(msg => {
                // 如果是文件消息且有 Blob URL，标记但不保存 URL
                if (msg.type === 'file' && msg.data && msg.data.startsWith('blob:')) {
                    return {
                        ...msg,
                        data: null, // 清除 Blob URL
                        expired: true // 标记为已过期
                    };
                }
                return msg;
            });
            
            localStorage.setItem(key, JSON.stringify(messagesToSave));
        } catch (err) {
            // localStorage 可能超出配额
            if (err.name === 'QuotaExceededError') {
                console.warn('localStorage quota exceeded, clearing old messages...');
                try {
                    // 只保留最近一半的消息
                    const reducedMessages = messages.slice(-Math.floor(MAX_MESSAGES / 2));
                    localStorage.setItem(getStorageKey(targetRoom), JSON.stringify(reducedMessages));
                } catch (retryErr) {
                    console.error('Failed to save chat history even after reducing size:', retryErr);
                }
            } else {
                console.error('Failed to save chat history:', err);
            }
        }
    }, [getStorageKey]);

    /**
     * 清除指定房间的聊天历史
     * @param {string} targetRoom - 目标房间ID（可选，默认当前房间）
     */
    const clearChatHistory = useCallback((targetRoom) => {
        try {
            const key = getStorageKey(targetRoom);
            localStorage.removeItem(key);
        } catch (err) {
            console.error('Failed to clear chat history:', err);
        }
    }, [getStorageKey]);

    /**
     * 获取所有房间的聊天历史键列表
     * @returns {Array} 包含房间ID的数组
     */
    const getAllRoomKeys = useCallback(() => {
        try {
            const prefix = `chat_history_${userId}_`;
            const keys = [];
            
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(prefix)) {
                    const roomId = key.substring(prefix.length);
                    keys.push(roomId);
                }
            }
            
            return keys;
        } catch (err) {
            console.error('Failed to get room keys:', err);
            return [];
        }
    }, [userId]);

    return {
        loadChatHistory,
        saveChatHistory,
        clearChatHistory,
        getAllRoomKeys
    };
};
