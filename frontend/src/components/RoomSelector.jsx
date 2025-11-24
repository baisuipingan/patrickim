import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Home, Users } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * 房间选择组件
 */
export const RoomSelector = ({
    roomInput,
    rooms,
    localNetworkRooms,
    onRoomInputChange,
    onJoinRoom
}) => {
    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
            <div className="bg-white rounded-lg p-8 max-w-md w-full shadow-lg border">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold mb-2">
                        加入房间
                    </h1>
                    <p className="text-gray-600 text-sm">
                        输入房间号或选择已有房间
                    </p>
                </div>
                
                {/* 房间号输入框 */}
                <div className="space-y-3 mb-6">
                    <Input
                        type="text" 
                        value={roomInput}
                        onChange={(e) => onRoomInputChange(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && onJoinRoom(roomInput)}
                        placeholder="输入房间号..."
                        className="h-10"
                    />
                </div>
                
                {/* 加入按钮 */}
                <Button 
                    onClick={() => onJoinRoom(roomInput)}
                    className="w-full mb-6 h-10"
                    size="default"
                >
                    加入房间
                </Button>
                
                {/* 已有房间列表 */}
                {rooms.length > 0 && (
                    <>
                        <div className="relative my-6">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-gray-200"></div>
                            </div>
                            <div className="relative flex justify-center text-sm">
                                <span className="px-3 bg-white text-gray-500">
                                    或选择房间
                                </span>
                            </div>
                        </div>
                        
                        <div className="max-h-80 overflow-y-auto space-y-2">
                            {rooms.map(room => {
                                const isLocal = localNetworkRooms.has(room.id);
                                return (
                                    <div 
                                        key={room.id}
                                        onClick={() => onJoinRoom(room.id)}
                                        className="p-4 rounded-lg cursor-pointer transition-colors hover:bg-gray-50 border flex items-center justify-between"
                                    >
                                        <div className="flex items-center gap-3 flex-1 min-w-0">
                                            <div className={cn(
                                                "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
                                                isLocal 
                                                    ? "bg-green-600 text-white" 
                                                    : "bg-gray-900 text-white"
                                            )}>
                                                {isLocal ? (
                                                    <Home className="w-5 h-5" />
                                                ) : (
                                                    <Users className="w-5 h-5" />
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <span className="font-semibold text-sm truncate">
                                                        {room.id}
                                                    </span>
                                                    {isLocal && (
                                                        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                                                            LAN
                                                        </Badge>
                                                    )}
                                                </div>
                                                <div className="text-[11px] text-gray-500">
                                                    {new Date(room.createdAt).toLocaleTimeString()}
                                                </div>
                                            </div>
                                        </div>
                                        <Badge variant="secondary" className="text-xs flex items-center gap-1">
                                            {room.clientCount}
                                        </Badge>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
