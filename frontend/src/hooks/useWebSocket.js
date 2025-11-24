import { useRef, useCallback } from 'react';

/**
 * WebSocket 连接管理 Hook
 * @param {Function} onMessage - 接收消息的回调
 * @param {Function} log - 日志记录函数
 * @returns {Object} WebSocket 连接管理方法
 */
export const useWebSocket = (onMessage, log) => {
    const wsRef = useRef(null);

    // 连接 WebSocket
    const connect = useCallback((url) => {
        // 关闭旧连接
        if (wsRef.current) {
            wsRef.current.close();
        }

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            log("Connected to Signaling Server");
        };

        ws.onmessage = async (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                if (onMessage) {
                    await onMessage(msg);
                }
            } catch (err) {
                console.error('Failed to parse WebSocket message:', err);
            }
        };
        
        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        
        ws.onclose = () => {
            log("Disconnected from server");
        };

        return ws;
    }, [onMessage, log]);

    // 发送消息
    const send = useCallback((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
        }
    }, []);

    // 关闭连接
    const close = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
    }, []);

    return {
        wsRef,
        connect,
        send,
        close
    };
};
