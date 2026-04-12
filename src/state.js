import { CACHE_MAX_SIZE } from './constants.js';

/**
 * Shared mutable app state used across UI and service modules.
 */
export const state = {
    currentDirectory: null,
    currentFiles: [],
    allFolderFiles: [],
    selectedFile: null,
    embeddedJsonEntries: [],
    filteredEmbeddedJsonEntries: [],
    pendingEmbeddedJsonSave: null,
    pendingMetadataSave: null,
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
    cardEditorMode: 'view',
    preserveEmptySelection: false,
};

/**
 * Trims oldest cache entries when map exceeds configured size.
 * @template K, V
 * @param {Map<K, V>} cache
 */
export function evictCacheIfNeeded(cache) {
    if (cache.size > CACHE_MAX_SIZE) {
        const keys = Array.from(cache.keys());
        const toRemove = keys.slice(0, Math.floor(CACHE_MAX_SIZE / 2));
        toRemove.forEach(key => cache.delete(key));
    }
}
