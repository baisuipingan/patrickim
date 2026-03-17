import { useState, useRef } from 'react';

/**
 * 房间管理 Hook
 * 只负责房间状态管理，不涉及连接逻辑
 * @param {Object} options
 * @param {Object} options.diagnostics - 诊断上报对象
 * @returns {Object} 房间管理的状态和方法
 */
export const useRoom = ({ diagnostics } = {}) => {
    const [currentRoom, setCurrentRoom] = useState(() => localStorage.getItem('lastRoom') || '');
    const [showRoomInput, setShowRoomInput] = useState(false);
    const [roomInput, setRoomInput] = useState('');
    const [rooms, setRooms] = useState([]);
    const myICECandidatesRef = useRef([]);

    // 获取房间列表（只返回公开房间）
    const fetchRooms = async () => {
        try {
            const response = await fetch('/api/rooms');
            if (!response.ok) {
                throw new Error(`Failed to fetch rooms: ${response.status}`);
            }
            const data = await response.json();
            setRooms(data || []);
            diagnostics?.recordEvent('rooms_loaded', {
                roomCount: Array.isArray(data) ? data.length : 0
            });
        } catch (err) {
            console.error('Failed to fetch rooms:', err);
            diagnostics?.reportIssue('rooms_fetch_failed', {
                message: err?.message || 'unknown'
            }, {
                delayMs: 1500,
                context: {
                    feature: 'room-list'
                }
            });
        }
    };

    return {
        // 状态
        currentRoom,
        showRoomInput,
        roomInput,
        rooms,
        myICECandidatesRef,
        
        // 状态设置方法
        setCurrentRoom,
        setShowRoomInput,
        setRoomInput,
        
        // 功能方法
        fetchRooms
    };
};
