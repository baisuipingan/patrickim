import React, { useState } from 'react';
import { Download, FileText, Check, Copy } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/**
 * ChatMessage 组件
 * 显示单条聊天消息，支持文本和文件
 * 
 * @param {Object} props
 * @param {Object} props.message - 消息对象 { from, type, text, data, name, savedToDisk }
 * @param {string} props.displayName - 显示的用户名
 * @param {boolean} props.isMine - 是否是自己的消息
 * @param {Function} props.onImageClick - 图片点击回调
 */
export default function ChatMessage({ message, displayName, isMine, onImageClick }) {
    const c = message;
    
    const renderContent = () => {
        if (c.type === 'text') {
            return <span className="break-words">{c.text}</span>;
        }
        
        // 文件消息
        // 检查是否使用现代 API 保存（两种方式判断）
        if (c.savedToDisk || c.data === 'file-saved-to-disk') {
            // 文件已保存到磁盘（现代 API）
            return (
                <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <Check className="w-5 h-5 text-green-600 mt-0.5" />
                    <div className="flex-1">
                        <div className="font-medium text-green-900">{c.name}</div>
                        <div className="text-sm text-green-700 mt-1">
                            文件已保存到您选择的位置
                        </div>
                    </div>
                </div>
            );
        }
        
        // 判断是否是图片（根据文件扩展名）
        const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(c.name);
        
        if (c.data && isImage) {
            // 图片文件
            return (
                <img 
                    src={c.data} 
                    alt={c.name} 
                    className="max-w-full max-h-60 sm:max-h-80 w-auto object-contain rounded-lg cursor-zoom-in hover:opacity-90 transition-opacity"
                    onClick={() => onImageClick && onImageClick(c.data)}
                />
            );
        }
        
        if (c.data) {
            // 其他文件（可下载）
            return (
                <a 
                    href={c.data} 
                    download={c.name} 
                    className="flex items-center gap-2 p-3 bg-white/10 hover:bg-white/20 rounded-lg transition-colors group min-w-0"
                >
                    <FileText className="w-5 h-5 flex-shrink-0" />
                    <span className="flex-1 font-medium truncate">{c.name}</span>
                    <Download className="w-4 h-4 opacity-70 group-hover:opacity-100 flex-shrink-0" />
                </a>
            );
        }
        
        // 仅显示文件名（无数据）
        return (
            <div className="flex items-center gap-2 p-3 bg-white/10 rounded-lg">
                <FileText className="w-5 h-5" />
                <span className="font-medium">{c.name}</span>
            </div>
        );
    };
    
    const [copied, setCopied] = useState(false);
    
    const handleCopy = async () => {
        try {
            if (c.type === 'text') {
                // 复制文本
                await navigator.clipboard.writeText(c.text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            } else if (c.type === 'file' && c.data) {
                // 判断是否是图片
                const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(c.name);
                
                if (isImage) {
                    // 复制图片
                    const response = await fetch(c.data);
                    const blob = await response.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blob.type]: blob })
                    ]);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                } else {
                    // 复制文件名
                    await navigator.clipboard.writeText(c.name);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                }
            }
        } catch (err) {
            console.error('Failed to copy:', err);
            // 如果复制失败，尝试复制文本内容作为后备
            try {
                const textContent = c.type === 'text' ? c.text : c.name;
                await navigator.clipboard.writeText(textContent);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            } catch (e) {
                console.error('Fallback copy also failed:', e);
            }
        }
    };
    
    return (
        <div className={cn(
            "flex message-slide-in group",
            isMine ? "self-end max-w-[85%] sm:max-w-[75%]" : "self-start max-w-[85%] sm:max-w-[75%] gap-2"
        )}>
            {!isMine && (
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center text-gray-700 font-semibold text-xs">
                    {displayName.substring(0, 2).toUpperCase()}
                </div>
            )}
            
            <div className={cn(
                "flex flex-col gap-1",
                isMine ? "items-end" : "items-start"
            )}>
                {!isMine && (
                    <span className="text-xs font-medium text-gray-600 px-3">
                        {displayName}
                    </span>
                )}
                
                <div className="relative">
                    <div className={cn(
                        "px-4 py-2.5 text-[15px] leading-relaxed inline-block break-words",
                        isMine 
                            ? "bg-blue-600 text-white rounded-2xl rounded-br-md" 
                            : "bg-white text-gray-900 rounded-2xl rounded-bl-md border shadow-sm"
                    )}>
                        {renderContent()}
                    </div>
                    <Button
                        onClick={handleCopy}
                        variant="ghost"
                        size="icon"
                        className={cn(
                            "absolute -top-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity",
                            isMine ? "-left-7" : "-right-7"
                        )}
                        title="复制"
                    >
                        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                </div>
                
                <span className="text-[11px] text-gray-500 px-3">
                    {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
            </div>
        </div>
    );
}
