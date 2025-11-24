import React from 'react';
import { Upload, Download, Pause, Play, X } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { cn } from '../lib/utils';

/**
 * FileProgress 组件
 * 显示文件传输进度条，支持暂停/恢复/取消
 * 
 * @param {Object} props
 * @param {string} props.id - 进度条唯一标识
 * @param {Object} props.progress - 进度信息 { name, percent, sent, received, totalSize, speed, remaining, type, targetName, fromName }
 * @param {Object} props.control - 控制对象，包含 pause/resume/cancel 方法
 * @param {boolean} props.isPaused - 是否暂停
 * @param {Function} props.onPauseResume - 暂停/恢复回调
 * @param {Function} props.onCancel - 取消回调
 */
export default function FileProgress({ 
    id, 
    progress, 
    control, 
    isPaused, 
    onPauseResume, 
    onCancel 
}) {
    const p = progress;
    
    return (
        <div key={id} className="border rounded-lg p-3 mb-2 bg-white shadow-sm">
            <div className="flex items-center justify-between mb-2">
                <div className="flex-1 flex items-center gap-2.5">
                    <div className={cn(
                        "w-9 h-9 rounded-lg flex items-center justify-center",
                        p.type === 'upload' 
                            ? "bg-gray-900 text-white" 
                            : "bg-green-600 text-white"
                    )}>
                        {p.type === 'upload' ? (
                            <Upload className="w-4 h-4" />
                        ) : (
                            <Download className="w-4 h-4" />
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-medium text-sm truncate">
                                {p.name}
                            </span>
                            {p.type === 'upload' && p.targetName && (
                                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                                    → {p.targetName}
                                </Badge>
                            )}
                            {p.type === 'download' && p.fromName && (
                                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                                    ← {p.fromName}
                                </Badge>
                            )}
                        </div>
                        <div className="text-[11px] text-gray-500">
                            {p.type === 'upload' ? p.sent : p.received} / {p.totalSize} • {isPaused ? '暂停' : p.speed}
                            {!isPaused && p.remaining && ` • ${p.remaining}`}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    {control && (
                        <>
                            <Button
                                onClick={onPauseResume}
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                            >
                                {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                            </Button>
                            <Button
                                onClick={onCancel}
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                                <X className="w-3.5 h-3.5" />
                            </Button>
                        </>
                    )}
                    <span className="text-xs font-semibold text-gray-900 ml-1">
                        {isPaused ? '⏸' : `${p.percent}%`}
                    </span>
                </div>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div 
                    className={cn(
                        "h-full transition-all duration-300",
                        isPaused 
                            ? "bg-amber-500" 
                            : "bg-gray-900"
                    )}
                    style={{ width: `${p.percent}%` }}
                />
            </div>
        </div>
    );
}
