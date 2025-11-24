/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的文件大小
 */
export const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
};

/**
 * 格式化时间（秒转为可读格式）
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间
 */
export const formatTime = (seconds) => {
    if (seconds < 60) return Math.floor(seconds) + 's';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}m ${sec}s`;
};

/**
 * 格式化速度
 * @param {number} bytesPerSecond - 每秒字节数
 * @returns {string} 格式化后的速度
 */
export const formatSpeed = (bytesPerSecond) => {
    if (bytesPerSecond < 1024) return bytesPerSecond.toFixed(0) + ' B/s';
    if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(2) + ' KB/s';
    return (bytesPerSecond / (1024 * 1024)).toFixed(2) + ' MB/s';
};

/**
 * 生成唯一ID
 * @returns {string} 唯一ID
 */
export const generateId = () => {
    return Math.random().toString(36).substring(2, 11);
};
