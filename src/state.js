export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);
export const THUMBNAIL_CONCURRENCY = 2;
export const CACHE_MAX_SIZE = 500;

export const state = {
    currentFiles: [],
    allFolderFiles: [],
    selectedFile: null,
    embeddedJsonEntries: [],
    filteredEmbeddedJsonEntries: [],
    pendingEmbeddedJsonSave: null,
    embeddedJsonFieldDescriptors: [],
    embeddedJsonFieldSyncTimer: null,
    folderFilterDebounceTimer: null,
    folderFilterToken: 0,
    folderLoadToken: 0,
    metadataLoadToken: 0,
    thumbnailActiveCount: 0,
    thumbnailQueue: [],
    metadataFilterCache: new Map(),
    embeddedJsonPresenceCache: new Map(),
    licenseInventory: [],
    licensesLoaded: false,
    licensesGeneratedAt: 'unknown',
};

export function evictCacheIfNeeded(cache) {
    if (cache.size > CACHE_MAX_SIZE) {
        const keys = Array.from(cache.keys());
        const toRemove = keys.slice(0, Math.floor(CACHE_MAX_SIZE / 2));
        toRemove.forEach(key => cache.delete(key));
    }
}

export function getExtension(filePath) {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot >= 0 ? filePath.slice(lastDot + 1).toLowerCase() : '';
}

export function fileKindByPath(filePath) {
    const ext = getExtension(filePath);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return 'other';
}
