/**
 * WebRTC ICE Servers 配置
 */
export const ICE_SERVERS = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export async function fetchSession() {
    const response = await fetch('/api/session', {
        credentials: 'include',
        cache: 'no-store'
    });

    if (!response.ok) {
        throw new Error(`Failed to initialize session: ${response.status}`);
    }

    return response.json();
}

export async function fetchIceConfig() {
    try {
        const response = await fetch('/api/ice', {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch ICE config: ${response.status}`);
        }

        const data = await response.json();
        return {
            provider: data.provider || 'default',
            iceServers: Array.isArray(data.iceServers) && data.iceServers.length > 0
                ? data.iceServers
                : ICE_SERVERS.iceServers
        };
    } catch (error) {
        console.warn('Falling back to default ICE servers:', error);
        return ICE_SERVERS;
    }
}

/**
 * WebSocket 配置
 */
export const WS_CONFIG = {
    // WebSocket URL 会根据当前页面协议自动选择
    getUrl: (room) => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws?room=${room}`;
    }
};

/**
 * 文件传输配置
 */
export const FILE_TRANSFER_CONFIG = {
    CHUNK_SIZE: 64 * 1024,                 // 64KB 分片，继续保持兼容性
    MAX_CHUNKS_PER_BURST: 32,              // 单轮最多发 2MB，显著提升局域网吞吐
    MAX_BUFFERED_AMOUNT: 4 * 1024 * 1024, // 默认最多预灌 4MB，专用文件通道会再翻倍
    BUFFER_LOW_THRESHOLD: 2 * 1024 * 1024,// 缓冲回落到 2MB 后继续补数据
    PROGRESS_UPDATE_INTERVAL: 100          // 100ms 更新一次进度
};

/**
 * 消息类型定义
 */
export const MESSAGE_TYPES = {
    // WebSocket 信令消息
    NEW_USER: 'new_user',
    NICKNAME: 'nickname',
    EXISTING_USERS: 'existing_users',
    USER_LEFT: 'user_left',
    OFFER: 'offer',
    ANSWER: 'answer',
    CANDIDATE: 'candidate',
    
    // 文件传输消息
    FILE_START: 'file-start',
    FILE_DONE: 'file-done',
    CANCEL_TRANSFER: 'cancel-transfer',
    CANCEL_TRANSFER_BY_RECEIVER: 'cancel-transfer-by-receiver',
    
    // 聊天消息
    TEXT: 'text',
    FILE: 'file',
    
    // 音视频通话消息
    CALL_REQUEST: 'call-request',
    CALL_ACCEPT: 'call-accept',
    CALL_REJECT: 'call-reject',
    CALL_END: 'call-end',
    CALL_BUSY: 'call-busy',
    TOGGLE_VIDEO: 'toggle-video',
    TOGGLE_AUDIO: 'toggle-audio',
    SCREEN_SHARE_START: 'screen-share-start',
    SCREEN_SHARE_STOP: 'screen-share-stop'
};

/**
 * 聊天模式
 */
export const CHAT_MODES = {
    BROADCAST: 'broadcast',  // 全局聊天
    PRIVATE: 'private'       // 私聊
};
