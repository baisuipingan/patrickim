import { useState, useRef } from 'react';

/**
 * 房间管理 Hook
 * 只负责房间状态管理，不涉及连接逻辑
 * @returns {Object} 房间管理的状态和方法
 */
export const useRoom = () => {
    const [currentRoom, setCurrentRoom] = useState(() => localStorage.getItem('lastRoom') || '');
    const [showRoomInput, setShowRoomInput] = useState(false);
    const [roomInput, setRoomInput] = useState('');
    const [rooms, setRooms] = useState([]);
    const [localNetworkRooms, setLocalNetworkRooms] = useState(new Set());
    const myICECandidatesRef = useRef([]);

    // 获取房间列表
    const fetchRooms = async () => {
        try {
            const response = await fetch('/api/rooms');
            const data = await response.json();
            setRooms(data || []);
            
            // 异步检测局域网房间
            if (data && data.length > 0) {
                detectLocalNetworkRooms(data);
            }
        } catch (err) {
            console.error('Failed to fetch rooms:', err);
        }
    };

    // 检测局域网房间
    const detectLocalNetworkRooms = async (roomList) => {
        // 检测本地网络特征
        const hasLocalCandidate = myICECandidatesRef.current.some(c => 
            c.type === 'host' || 
            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(c.address)
        );
        
        if (hasLocalCandidate) {
            // 标记当前房间为局域网房间
            setLocalNetworkRooms(new Set([currentRoom]));
        }
    };

    return {
        // 状态
        currentRoom,
        showRoomInput,
        roomInput,
        rooms,
        localNetworkRooms,
        myICECandidatesRef,
        
        // 状态设置方法
        setCurrentRoom,
        setShowRoomInput,
        setRoomInput,
        
        // 功能方法
        fetchRooms,
        detectLocalNetworkRooms
    };
};
