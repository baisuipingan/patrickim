import React, { useEffect } from 'react';
import { Paperclip, Send, X, FileText, Image } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';

/**
 * MessageInput 组件
 * 消息输入区域，包含文件上传按钮、文本输入框和发送按钮
 * 
 * @param {Object} props
 * @param {string} props.message - 消息内容
 * @param {Function} props.onMessageChange - 消息变化回调
 * @param {Function} props.onSendMessage - 发送消息回调
 * @param {Function} props.onFileSelect - 文件选择回调
 * @param {Function} props.onPaste - 粘贴回调
 * @param {boolean} props.isComposing - 是否正在输入法组合
 * @param {Function} props.onCompositionStart - 输入法开始回调
 * @param {Function} props.onCompositionEnd - 输入法结束回调
 * @param {Array} props.pendingFiles - 待发送的文件列表
 * @param {Function} props.onRemoveFile - 移除文件回调
 */
export default function MessageInput({ 
    message, 
    onMessageChange, 
    onSendMessage, 
    onFileSelect, 
    onPaste, 
    isComposing, 
    onCompositionStart, 
    onCompositionEnd,
    pendingFiles = [],
    onRemoveFile
}) {
    const handleKeyDown = (e) => {
        // 按 Enter 且（有消息或有文件）时发送
        if (e.key === 'Enter' && !isComposing && (message.trim() || pendingFiles.length > 0)) {
            e.preventDefault();
            onSendMessage();
        }
    };

    const handleFileChange = (e) => {
        if (e.target.files[0]) {
            onFileSelect(e.target.files[0]);
            // 重置文件输入框，允许重复选择同一文件
            e.target.value = '';
        }
    };
    
    // 清理创建的 Blob URLs
    useEffect(() => {
        return () => {
            pendingFiles.forEach(file => {
                if (file.type.startsWith('image/')) {
                    const url = URL.createObjectURL(file);
                    URL.revokeObjectURL(url);
                }
            });
        };
    }, [pendingFiles]);

    return (
        <div className="border-t bg-white">
            {/* 文件预览区域 */}
            {pendingFiles.length > 0 && (
                <div className="px-4 py-3 flex gap-2 flex-wrap border-b bg-gray-50">
                    {pendingFiles.map((file, index) => {
                        const isImage = file.type.startsWith('image/');
                        const previewUrl = isImage ? URL.createObjectURL(file) : null;
                        
                        return (
                            <div 
                                key={index} 
                                className="relative inline-flex items-center gap-2 px-3 py-2 bg-white border rounded-lg max-w-[200px] group shadow-sm"
                            >
                                {isImage && previewUrl ? (
                                    <div className="relative">
                                        <img 
                                            src={previewUrl} 
                                            alt={file.name}
                                            className="w-10 h-10 object-cover rounded"
                                        />
                                        <Image className="w-3 h-3 absolute bottom-0 right-0 text-white bg-black/50 rounded-sm p-0.5" />
                                    </div>
                                ) : (
                                    <FileText className="w-8 h-8 text-gray-500" />
                                )}
                                <div className="flex-1 min-w-0 text-xs">
                                    <div className="font-medium truncate text-gray-900">
                                        {file.name}
                                    </div>
                                    <div className="text-gray-500">
                                        {(file.size / 1024).toFixed(1)} KB
                                    </div>
                                </div>
                                <Button
                                    onClick={() => onRemoveFile(index)}
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="移除"
                                >
                                    <X className="w-3 h-3" />
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}
            
            {/* 输入区域 */}
            <div className="px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2">
                <input 
                    type="file" 
                    id="fileInput" 
                    className="hidden" 
                    onChange={handleFileChange}
                />
                <Button
                    onClick={() => document.getElementById('fileInput').click()}
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-9 w-9"
                    title="发送文件"
                >
                    <Paperclip className="w-5 h-5" />
                </Button>
                
                <input
                    type="text" 
                    value={message} 
                    onChange={e => onMessageChange(e.target.value)} 
                    onKeyDown={handleKeyDown}
                    onCompositionStart={onCompositionStart}
                    onCompositionEnd={onCompositionEnd}
                    onPaste={onPaste}
                    placeholder="输入消息..."
                    className="flex-1 bg-transparent border-0 outline-none text-[15px] placeholder:text-gray-400 px-2"
                />
                
                <Button 
                    onClick={onSendMessage} 
                    size="icon"
                    className="shrink-0 h-9 w-9"
                >
                    <Send className="w-4 h-4" />
                </Button>
            </div>
        </div>
    );
}
