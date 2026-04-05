import { CACHE_MAX_SIZE } from './constants.js';

export const state = {
    currentFiles: [],
    allFolderFiles: [],
    selectedFile: null,
    embeddedJsonEntries: [],
    filteredEmbeddedJsonEntries: [],
    pendingEmbeddedJsonSave: null,
    textEntries: [],
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
