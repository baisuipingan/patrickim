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
    return Boolean(
        window.isSecureContext &&
        'showSaveFilePicker' in window &&
        'FileSystemHandle' in window
    );
};

/**
 * 检查浏览器是否支持目录选择器与持久化目录句柄
 * @returns {boolean} 是否支持
 */
export const isDirectoryPickerSupported = () => {
    return Boolean(
        window.isSecureContext &&
        'showDirectoryPicker' in window &&
        'FileSystemHandle' in window &&
        'indexedDB' in window
    );
};

const FILE_SYSTEM_DB_NAME = 'patrick-im-file-system';
const FILE_SYSTEM_STORE_NAME = 'handles';
const DEFAULT_RECEIVE_DIRECTORY_KEY = 'default-receive-directory';

const openFileSystemDb = () => new Promise((resolve, reject) => {
    const request = window.indexedDB.open(FILE_SYSTEM_DB_NAME, 1);

    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILE_SYSTEM_STORE_NAME)) {
            db.createObjectStore(FILE_SYSTEM_STORE_NAME);
        }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open file system database'));
});

const withHandleStore = async (mode, handler) => {
    const db = await openFileSystemDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(FILE_SYSTEM_STORE_NAME, mode);
        const store = transaction.objectStore(FILE_SYSTEM_STORE_NAME);

        let settled = false;
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            callback(value);
        };

        transaction.oncomplete = () => finish(resolve);
        transaction.onerror = () => finish(reject, transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => finish(reject, transaction.error || new Error('IndexedDB transaction aborted'));

        Promise.resolve(handler(store, resolve, reject)).catch((error) => {
            finish(reject, error);
        });
    }).finally(() => {
        db.close();
    });
};

const splitFileName = (fileName = 'download') => {
    const normalized = fileName.trim() || 'download';
    const lastDot = normalized.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === normalized.length - 1) {
        return {
            baseName: normalized,
            extension: ''
        };
    }

    return {
        baseName: normalized.slice(0, lastDot),
        extension: normalized.slice(lastDot)
    };
};

export const queryFileSystemPermission = async (handle, { writable = false } = {}) => {
    if (!handle?.queryPermission) {
        return 'prompt';
    }

    return handle.queryPermission({
        mode: writable ? 'readwrite' : 'read'
    });
};

export const requestFileSystemPermission = async (handle, { writable = false } = {}) => {
    if (!handle?.requestPermission) {
        return 'prompt';
    }

    return handle.requestPermission({
        mode: writable ? 'readwrite' : 'read'
    });
};

export const getDefaultReceiveDirectory = async () => {
    if (!isDirectoryPickerSupported()) {
        return null;
    }

    return withHandleStore('readonly', (store, resolve, reject) => {
        const request = store.get(DEFAULT_RECEIVE_DIRECTORY_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Failed to load default receive directory'));
    });
};

export const clearDefaultReceiveDirectory = async () => {
    if (!isDirectoryPickerSupported()) {
        return;
    }

    return withHandleStore('readwrite', (store, resolve, reject) => {
        const request = store.delete(DEFAULT_RECEIVE_DIRECTORY_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('Failed to clear default receive directory'));
    });
};

export const pickDefaultReceiveDirectory = async () => {
    if (!isDirectoryPickerSupported()) {
        throw new Error('Directory picker not supported');
    }

    const directoryHandle = await window.showDirectoryPicker({
        id: 'patrick-im-receive-directory',
        mode: 'readwrite',
        startIn: 'downloads'
    });

    await withHandleStore('readwrite', (store, resolve, reject) => {
        const request = store.put(directoryHandle, DEFAULT_RECEIVE_DIRECTORY_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('Failed to persist default receive directory'));
    });

    return directoryHandle;
};

export const createWritableInDirectory = async (directoryHandle, suggestedName) => {
    if (!directoryHandle) {
        throw new Error('Directory handle is required');
    }

    const { baseName, extension } = splitFileName(suggestedName);

    for (let index = 0; index < 500; index += 1) {
        const candidateName = index === 0
            ? `${baseName}${extension}`
            : `${baseName} (${index})${extension}`;

        try {
            await directoryHandle.getFileHandle(candidateName);
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                const fileHandle = await directoryHandle.getFileHandle(candidateName, {
                    create: true
                });
                const writer = await fileHandle.createWritable();
                return {
                    fileHandle,
                    writer,
                    finalName: candidateName
                };
            }

            throw error;
        }
    }

    throw new Error('Too many duplicate file names in default receive directory');
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
        id: 'patrick-im-receive-file',
        startIn: 'downloads',
        suggestedName: suggestedName,
        types: [{
            description: 'All Files',
            accept: { '*/*': [] }
        }]
    });
    
    const writer = await fileHandle.createWritable();
    return { fileHandle, writer };
};
