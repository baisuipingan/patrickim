/**
 * WebRTC ICE Servers 配置
 */
export const ICE_SERVERS = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

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
    CHUNK_SIZE: 16384,           // 16KB per chunk
    BATCH_SIZE: 32,              // Send 32 chunks at once
    BUFFER_THRESHOLD: 16,        // Buffer threshold for flow control
    PROGRESS_UPDATE_INTERVAL: 100 // 100ms between progress updates
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
