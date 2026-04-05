import { VIDEO_EXTS } from '../constants.js';
import { state, evictCacheIfNeeded } from '../state.js';
import { getExtension } from '../utils/file-utils.js';
import {
    getEmbeddedBase64JsonEntries,
    getFileFilterInfo,
    getFileMetadata,
    getTextEntries,
    hasEmbeddedJson,
} from './tauri-api.js';

/**
 * Loads full metadata for selected file from backend.
 * @param {string} filePath
 */
export function loadFileMetadataData(filePath) {
    return getFileMetadata(filePath);
}

/**
 * Loads embedded JSON entries for a file.
 * @param {string} filePath
 */
export function loadEmbeddedJsonEntries(filePath) {
    return getEmbeddedBase64JsonEntries(filePath);
}

/**
 * Loads plaintext PNG entries from backend.
 * @param {string} filePath
 */
export function loadTextEntriesData(filePath) {
    return getTextEntries(filePath);
}

/**
 * Retrieves and caches reduced metadata needed by folder filters.
 * @param {string} filePath
 * @param {{includeExif?: boolean}} options
 */
export async function getMetadataFilterData(filePath, options = {}) {
    const includeExif = Boolean(options.includeExif);
    const cached = state.metadataFilterCache.get(filePath);
    if (cached && (!includeExif || cached.hasExif != null)) {
        return cached;
    }

    try {
        const info = await getFileFilterInfo(filePath, includeExif);
        const data = {
            searchBlob: String(info.search_text || '').toLowerCase(),
            hasExif: info.has_exif == null ? null : Boolean(info.has_exif),
            fileSize: Number(info.file_size || 0),
            modifiedTimestamp: info.modified_timestamp == null ? null : Number(info.modified_timestamp),
            duration: info.duration == null ? null : Number(info.duration),
            resolution: info.width != null && info.height != null
                ? Number(info.width) * Number(info.height)
                : null,
        };

        state.metadataFilterCache.set(filePath, data);
        evictCacheIfNeeded(state.metadataFilterCache);
        return data;
    } catch (_error) {
        const fallback = cached || {
            searchBlob: '',
            hasExif: null,
            fileSize: 0,
            modifiedTimestamp: null,
            duration: null,
            resolution: null,
        };
        state.metadataFilterCache.set(filePath, fallback);
        evictCacheIfNeeded(state.metadataFilterCache);
        return fallback;
    }
}

/**
 * Checks for embedded JSON presence and caches result.
 * @param {string} filePath
 */
export async function hasEmbeddedJsonEntries(filePath) {
    if (state.embeddedJsonPresenceCache.has(filePath)) {
        return state.embeddedJsonPresenceCache.get(filePath);
    }

    const ext = getExtension(filePath);
    if (ext !== 'png' && ext !== 'mp3' && ext !== 'flac' && !VIDEO_EXTS.has(ext)) {
        state.embeddedJsonPresenceCache.set(filePath, false);
        evictCacheIfNeeded(state.embeddedJsonPresenceCache);
        return false;
    }

    try {
        const hasAny = Boolean(await hasEmbeddedJson(filePath));
        state.embeddedJsonPresenceCache.set(filePath, hasAny);
        evictCacheIfNeeded(state.embeddedJsonPresenceCache);
        return hasAny;
    } catch (_error) {
        state.embeddedJsonPresenceCache.set(filePath, false);
        evictCacheIfNeeded(state.embeddedJsonPresenceCache);
        return false;
    }
}
