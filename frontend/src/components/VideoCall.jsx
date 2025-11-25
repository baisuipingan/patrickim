import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CALL_STATUS } from '../hooks/useVideoCall';
import {
    Phone,
    PhoneOff,
    Video,
    VideoOff,
    Mic,
    MicOff,
    Monitor,
    MonitorOff,
    Minimize2,
    Maximize2,
    X
} from 'lucide-react';

/**
 * 来电弹窗组件
 */
export function IncomingCallModal({
    isOpen,
    callerName,
    isVideoCall,
    onAccept,
    onReject
}) {
    if (!isOpen) return null;
    
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl animate-in fade-in zoom-in duration-300 max-w-sm w-full mx-4">
                {/* 来电头像动画 */}
                <div className="flex flex-col items-center mb-6">
                    <div className="relative">
                        <div className="w-24 h-24 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg">
                            {callerName?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        {/* 脉冲动画 */}
                        <div className="absolute inset-0 rounded-full border-4 border-green-400 animate-ping opacity-30" />
                    </div>
                    <h3 className="mt-4 text-xl font-semibold text-foreground">
                        {callerName}
                    </h3>
                    <p className="text-muted-foreground mt-1">
                        {isVideoCall ? '视频通话' : '语音通话'}来电...
                    </p>
                </div>
                
                {/* 操作按钮 */}
                <div className="flex justify-center gap-8">
                    <Button
                        onClick={onReject}
                        variant="destructive"
                        size="lg"
                        className="rounded-full w-16 h-16 p-0 shadow-lg hover:shadow-xl transition-all"
                    >
                        <PhoneOff className="w-7 h-7" />
                    </Button>
                    <Button
                        onClick={onAccept}
                        size="lg"
                        className="rounded-full w-16 h-16 p-0 bg-green-500 hover:bg-green-600 shadow-lg hover:shadow-xl transition-all"
                    >
                        <Phone className="w-7 h-7" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * 呼叫中弹窗组件
 */
export function CallingModal({
    isOpen,
    calleeName,
    onCancel
}) {
    if (!isOpen) return null;
    
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl max-w-sm w-full mx-4">
                <div className="flex flex-col items-center mb-6">
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg">
                        {calleeName?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <h3 className="mt-4 text-xl font-semibold text-foreground">
                        {calleeName}
                    </h3>
                    <p className="text-muted-foreground mt-1 flex items-center gap-2">
                        <span className="flex gap-1">
                            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </span>
                        正在呼叫
                    </p>
                </div>
                
                <div className="flex justify-center">
                    <Button
                        onClick={onCancel}
                        variant="destructive"
                        size="lg"
                        className="rounded-full w-16 h-16 p-0"
                    >
                        <PhoneOff className="w-7 h-7" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * 视频通话窗口组件
 */
export function VideoCallWindow({
    isOpen,
    localStream,
    remoteStream,
    remoteName,
    isVideoEnabled,
    isAudioEnabled,
    isScreenSharing,
    remoteVideoEnabled,
    onEndCall,
    onToggleVideo,
    onToggleAudio,
    onStartScreenShare,
    onStopScreenShare
}) {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const containerRef = useRef(null);
    
    const [isMinimized, setIsMinimized] = useState(false);
    const [position, setPosition] = useState({ x: 20, y: 20 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef({ x: 0, y: 0 });
    
    // 设置本地视频流
    useEffect(() => {
        if (localVideoRef.current && localStream) {
            localVideoRef.current.srcObject = localStream;
        }
    }, [localStream]);
    
    // 设置远端视频流
    useEffect(() => {
        if (remoteVideoRef.current && remoteStream) {
            remoteVideoRef.current.srcObject = remoteStream;
        }
    }, [remoteStream]);
    
    // 拖拽处理
    const handleMouseDown = (e) => {
        if (e.target.closest('button')) return;
        setIsDragging(true);
        dragStartRef.current = {
            x: e.clientX - position.x,
            y: e.clientY - position.y
        };
    };
    
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            setPosition({
                x: e.clientX - dragStartRef.current.x,
                y: e.clientY - dragStartRef.current.y
            });
        };
        
        const handleMouseUp = () => {
            setIsDragging(false);
        };
        
        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);
    
    if (!isOpen) return null;
    
    // 最小化模式
    if (isMinimized) {
        return (
            <div
                ref={containerRef}
                className="fixed z-50 bg-card border border-border rounded-xl shadow-2xl overflow-hidden cursor-move"
                style={{ right: 20, bottom: 20, width: 200 }}
                onMouseDown={handleMouseDown}
            >
                <div className="relative">
                    {/* 远端视频缩略图 */}
                    <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        className="w-full h-28 object-cover bg-black"
                    />
                    {!remoteVideoEnabled && (
                        <div className="absolute inset-0 bg-gray-800 flex items-center justify-center">
                            <VideoOff className="w-8 h-8 text-gray-400" />
                        </div>
                    )}
                    
                    {/* 操作栏 */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                        <div className="flex items-center justify-between">
                            <span className="text-white text-sm truncate">{remoteName}</span>
                            <div className="flex gap-1">
                                <Button
                                    onClick={() => setIsMinimized(false)}
                                    variant="ghost"
                                    size="icon"
                                    className="w-7 h-7 text-white hover:bg-white/20"
                                >
                                    <Maximize2 className="w-4 h-4" />
                                </Button>
                                <Button
                                    onClick={onEndCall}
                                    variant="ghost"
                                    size="icon"
                                    className="w-7 h-7 text-red-400 hover:bg-red-500/20"
                                >
                                    <PhoneOff className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }
    
    // 完整模式
    return (
        <div
            ref={containerRef}
            className={cn(
                "fixed z-50 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden",
                isDragging ? "cursor-grabbing" : "cursor-grab"
            )}
            style={{
                left: position.x,
                top: position.y,
                width: 480,
                maxWidth: 'calc(100vw - 40px)'
            }}
            onMouseDown={handleMouseDown}
        >
            {/* 标题栏 */}
            <div className="bg-muted/50 px-4 py-2 flex items-center justify-between border-b">
                <span className="font-medium text-sm">与 {remoteName} 通话中</span>
                <div className="flex gap-1">
                    <Button
                        onClick={() => setIsMinimized(true)}
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7"
                    >
                        <Minimize2 className="w-4 h-4" />
                    </Button>
                    <Button
                        onClick={onEndCall}
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7 text-red-500 hover:text-red-600"
                    >
                        <X className="w-4 h-4" />
                    </Button>
                </div>
            </div>
            
            {/* 视频区域 */}
            <div className="relative bg-black aspect-video">
                {/* 远端视频（主画面） */}
                <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                />
                {!remoteVideoEnabled && (
                    <div className="absolute inset-0 bg-gray-800 flex flex-col items-center justify-center">
                        <div className="w-20 h-20 rounded-full bg-gray-700 flex items-center justify-center mb-2">
                            <span className="text-3xl text-gray-300">
                                {remoteName?.charAt(0)?.toUpperCase()}
                            </span>
                        </div>
                        <span className="text-gray-400 text-sm">对方已关闭摄像头</span>
                    </div>
                )}
                
                {/* 本地视频（小画面） */}
                <div className="absolute bottom-3 right-3 w-32 h-24 rounded-lg overflow-hidden border-2 border-white/30 shadow-lg">
                    <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover mirror"
                    />
                    {!isVideoEnabled && (
                        <div className="absolute inset-0 bg-gray-800 flex items-center justify-center">
                            <VideoOff className="w-6 h-6 text-gray-400" />
                        </div>
                    )}
                </div>
            </div>
            
            {/* 控制栏 */}
            <div className="bg-muted/50 px-4 py-3 flex items-center justify-center gap-3">
                {/* 麦克风 */}
                <Button
                    onClick={onToggleAudio}
                    variant={isAudioEnabled ? "secondary" : "destructive"}
                    size="icon"
                    className="rounded-full w-12 h-12"
                    title={isAudioEnabled ? "关闭麦克风" : "开启麦克风"}
                >
                    {isAudioEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                </Button>
                
                {/* 摄像头 */}
                <Button
                    onClick={onToggleVideo}
                    variant={isVideoEnabled ? "secondary" : "destructive"}
                    size="icon"
                    className="rounded-full w-12 h-12"
                    title={isVideoEnabled ? "关闭摄像头" : "开启摄像头"}
                >
                    {isVideoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                </Button>
                
                {/* 屏幕共享 */}
                <Button
                    onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
                    variant={isScreenSharing ? "default" : "secondary"}
                    size="icon"
                    className="rounded-full w-12 h-12"
                    title={isScreenSharing ? "停止共享" : "共享屏幕"}
                >
                    {isScreenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
                </Button>
                
                {/* 挂断 */}
                <Button
                    onClick={onEndCall}
                    variant="destructive"
                    size="icon"
                    className="rounded-full w-12 h-12"
                    title="结束通话"
                >
                    <PhoneOff className="w-5 h-5" />
                </Button>
            </div>
        </div>
    );
}

/**
 * 通话按钮组件（用于私聊界面）
 */
export function CallButton({ onClick, disabled, isVideoCall = true }) {
    return (
        <Button
            onClick={onClick}
            disabled={disabled}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            title={isVideoCall ? "发起视频通话" : "发起语音通话"}
        >
            {isVideoCall ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
        </Button>
    );
}
