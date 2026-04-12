import { dom } from '../dom.js';
import { state } from '../state.js';
import { getActiveWebview, getPathInfo } from '../services/tauri-api.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NATIVE_DROP_DUPLICATE_WINDOW_MS } from '../constants.js';

let lastNativeDropSignature = '';
let lastNativeDropAt = 0;

/**
 * Returns true when the same native drop event likely fired twice via multiple listeners.
 * @param {string[]} paths
 * @returns {boolean}
 */
function isDuplicateNativeDrop(paths) {
    const now = Date.now();
    const signature = (paths || []).join('|');
    const isDuplicate = signature.length > 0
        && signature === lastNativeDropSignature
        && (now - lastNativeDropAt) < NATIVE_DROP_DUPLICATE_WINDOW_MS;

    lastNativeDropSignature = signature;
    lastNativeDropAt = now;
    return isDuplicate;
}

/**
 * Returns true when browser file metadata likely represents an image.
 * Uses both MIME and extension because some drag sources omit MIME.
 * @param {File|null|undefined} file
 * @returns {boolean}
 */
function isLikelyImageFile(file) {
    if (!file) {
        return false;
    }

    if (typeof file.type === 'string' && file.type.startsWith('image/')) {
        return true;
    }

    const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    return /\.(png|jpe?g|gif|webp|bmp|tif|tiff)$/i.test(name);
}

/**
 * Returns true when browser file metadata likely represents a JSON file.
 * @param {File|null|undefined} file
 * @returns {boolean}
 */
function isLikelyJsonFile(file) {
    if (!file) {
        return false;
    }

    if (typeof file.type === 'string' && file.type.toLowerCase() === 'application/json') {
        return true;
    }

    const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    return name.endsWith('.json');
}

/**
 * Returns true when one native path likely points to an image file.
 * @param {string|null|undefined} filePath
 * @returns {boolean}
 */
function isLikelyImagePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }

    return /\.(png|jpe?g|gif|webp|bmp|tif|tiff)$/i.test(filePath.toLowerCase());
}

/**
 * Returns true when one native path likely points to a JSON file.
 * @param {string|null|undefined} filePath
 * @returns {boolean}
 */
function isLikelyJsonPath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }

    return /\.json$/i.test(filePath.toLowerCase());
}

/**
 * Routes one dropped path into folder open, create-mode import, or regular file open.
 * @param {string} filePath
 * @param {(filePath: string) => Promise<void>} onFileDropped
 * @param {(dirPath: string) => Promise<void>|undefined} onDirectoryDropped
 * @param {(file: File|null, sourcePath?: string) => Promise<void>|undefined} onCardEditorDrop
 * @returns {Promise<void>}
 */
export async function routeDroppedPath(filePath, onFileDropped, onDirectoryDropped, onCardEditorDrop) {
    if (!filePath || typeof filePath !== 'string') {
        return;
    }

    try {
        const pathInfo = await getPathInfo(filePath);
        if (pathInfo?.isDirectory) {
            if (typeof onDirectoryDropped === 'function') {
                await onDirectoryDropped(filePath);
            }
            return;
        }
    } catch {
        // Fall back to previous file-based routing if path inspection fails.
    }

    if (
        state.cardEditorMode === 'create'
        && onCardEditorDrop
        && (isLikelyImagePath(filePath) || isLikelyJsonPath(filePath))
    ) {
        await onCardEditorDrop(null, filePath);
        return;
    }

    await onFileDropped(filePath);
}

/**
 * Routes native file drop payload into create-mode import, folder open, or regular file open behavior.
 * @param {string[]} paths
 * @param {(filePath: string) => Promise<void>} onFileDropped
 * @param {(dirPath: string) => Promise<void>|undefined} onDirectoryDropped
 * @param {(file: File|null, sourcePath?: string) => Promise<void>|undefined} onCardEditorDrop
 * @returns {Promise<void>}
 */
async function handleNativeDropPaths(paths, onFileDropped, onDirectoryDropped, onCardEditorDrop) {
    if (!paths || paths.length === 0) {
        return;
    }

    if (isDuplicateNativeDrop(paths)) {
        return;
    }

    await routeDroppedPath(paths[0], onFileDropped, onDirectoryDropped, onCardEditorDrop);
}

/**
 * Registers native drag/drop listeners in both webview and window scopes.
 * This guards against platform/runtime differences between dev and packaged builds.
 * @param {(filePath: string) => Promise<void>} onFileDropped
 * @param {(dirPath: string) => Promise<void>|undefined} onDirectoryDropped
 * @param {(file: File|null, sourcePath?: string) => Promise<void>|undefined} onCardEditorDrop
 * @returns {void}
 */
function registerNativeDropHandlers(onFileDropped, onDirectoryDropped, onCardEditorDrop) {
    const onNativeEvent = async (payload) => {
        if (!payload || !payload.type) {
            return;
        }

        if (payload.type === 'over' || payload.type === 'enter') {
            dom.dropZone.classList.add('drag-over');
            return;
        }

        if (payload.type === 'leave') {
            dom.dropZone.classList.remove('drag-over');
            return;
        }

        if (payload.type === 'drop') {
            dom.dropZone.classList.remove('drag-over');
            await handleNativeDropPaths(payload.paths || [], onFileDropped, onDirectoryDropped, onCardEditorDrop);
        }
    };

    getActiveWebview()
        .onDragDropEvent(async (event) => {
            await onNativeEvent(event?.payload);
        })
        .catch(() => {
            // Keep app functional if webview drag/drop registration fails.
        });

    getCurrentWindow()
        .onDragDropEvent(async (event) => {
            await onNativeEvent(event?.payload);
        })
        .catch(() => {
            // Keep app functional if window drag/drop registration fails.
        });
}

/**
 * Initializes browser and Tauri drag/drop listeners for quick file metadata loading.
 * @param {(filePath: string) => Promise<void>} onFileDropped
 * @param {Object} [options] - Configuration options
 * @param {(dirPath: string) => Promise<void>} [options.onDirectoryDropped]
 * @param {(file: File|null, sourcePath?: string) => Promise<void>} [options.onCardEditorImageDrop]
 * Callback for image or JSON drops while create mode is active.
 */
export function initDragDrop(onFileDropped, options = {}) {
    let dragCounter = 0;
    const onCardEditorDrop = options?.onCardEditorImageDrop;
     const onDirectoryDropped = options?.onDirectoryDropped;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter += 1;
        dom.dropZone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter -= 1;
        if (dragCounter === 0) {
            dom.dropZone.classList.remove('drag-over');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dom.dropZone.classList.remove('drag-over');

        const file = e.dataTransfer?.files?.[0];
        if (!file) {
            return;
        }

        const sourcePath = typeof file.path === 'string' && file.path.trim().length > 0
            ? file.path
            : null;

        if (
            state.cardEditorMode === 'create'
            && onCardEditorDrop
            && (isLikelyImageFile(file) || isLikelyJsonFile(file))
        ) {
            e.stopPropagation();
            await onCardEditorDrop(file, sourcePath || undefined);
            return;
        }

        if (sourcePath) {
            await routeDroppedPath(sourcePath, onFileDropped, onDirectoryDropped, onCardEditorDrop);
        }
    });

    registerNativeDropHandlers(onFileDropped, onDirectoryDropped, onCardEditorDrop);
}
