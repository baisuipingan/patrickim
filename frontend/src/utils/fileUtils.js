/**
 * 检查是否为图片文件
 * @param {string} fileName - 文件名
 * @param {string} fileType - 文件MIME类型
 * @returns {boolean} 是否为图片
 */
export const isImageFile = (fileName, fileType) => {
    return fileType?.startsWith('image/') || 
           /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(fileName);
};

/**
 * 检查浏览器是否支持现代文件API
 * @returns {boolean} 是否支持
 */
export const isModernFileAPISupported = () => {
    return 'showSaveFilePicker' in window && 'FileSystemHandle' in window;
};

/**
 * 将文件分块
 * @param {ArrayBuffer} arrayBuffer - 文件数据
 * @param {number} chunkSize - 分块大小
 * @returns {number} 总块数
 */
export const calculateTotalChunks = (arrayBuffer, chunkSize) => {
    return Math.ceil(arrayBuffer.byteLength / chunkSize);
};

/**
 * 获取文件的ArrayBuffer
 * @param {File} file - 文件对象
 * @returns {Promise<ArrayBuffer>} 文件数据
 */
export const readFileAsArrayBuffer = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
};

/**
 * 显示文件保存对话框
 * @param {string} suggestedName - 建议的文件名
 * @returns {Promise<{fileHandle: FileSystemFileHandle, writer: FileSystemWritableFileStream}>}
 */
export const showSaveFilePicker = async (suggestedName) => {
    if (!isModernFileAPISupported()) {
        throw new Error('Modern File API not supported');
    }
    
    const fileHandle = await window.showSaveFilePicker({
        suggestedName: suggestedName,
        types: [{
            description: 'All Files',
            accept: { '*/*': [] }
        }]
    });
    
    const writer = await fileHandle.createWritable();
    return { fileHandle, writer };
};
