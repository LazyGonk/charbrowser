import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/**
 * Opens the native folder picker and returns selected directory path.
 * @returns {Promise<string|null>} Selected folder path or null.
 */
export async function pickDirectory() {
    const directory = await open({
        directory: true,
        multiple: false,
    });

    if (typeof directory === 'string') {
        return directory;
    }
    if (Array.isArray(directory) && directory.length > 0) {
        return directory[0];
    }
    return null;
}

/** @param {string} dirPath */
export function listDirectoryFiles(dirPath) {
    return invoke('list_directory_files', { dirPath });
}

/** @param {string} filePath */
export function getFileMetadata(filePath) {
    return invoke('get_file_metadata', { filePath });
}

/**
 * Retrieves compact metadata used for folder filtering/sorting.
 * @param {string} filePath
 * @param {boolean} includeExif
 */
export function getFileFilterInfo(filePath, includeExif) {
    return invoke('get_file_filter_info', { filePath, includeExif });
}

/** @param {string} filePath */
export function hasEmbeddedJson(filePath) {
    return invoke('has_embedded_json', { filePath });
}

/** @param {string} filePath */
export function getEmbeddedBase64JsonEntries(filePath) {
    return invoke('get_embedded_base64_json_entries', { filePath });
}

/** @param {{filePath: string, entryId: number, jsonText: string}} payload */
export function updateEmbeddedBase64Json(payload) {
    return invoke('update_embedded_base64_json', payload);
}

/** @param {string} filePath */
export function getTextEntries(filePath) {
    return invoke('get_text_entries', { filePath });
}

/**
 * Requests image thumbnail data URL from backend.
 * @param {string} filePath
 * @param {number} maxSize
 */
export function getThumbnail(filePath, maxSize) {
    return invoke('get_thumbnail', { filePath, maxSize });
}

/**
 * Requests in-memory video data URL for preview.
 * @param {string} filePath
 * @param {number} maxBytes
 */
export function getVideoDataUrl(filePath, maxBytes) {
    return invoke('get_video_data_url', { filePath, maxBytes });
}

/**
 * Requests in-memory audio data URL for preview.
 * @param {string} filePath
 * @param {number} maxBytes
 */
export function getAudioDataUrl(filePath, maxBytes) {
    return invoke('get_audio_data_url', { filePath, maxBytes });
}

/**
 * Requests embedded audio cover image if available.
 * @param {string} filePath
 * @param {number} maxSize
 */
export function getAudioCover(filePath, maxSize) {
    return invoke('get_audio_cover', { filePath, maxSize });
}

/** @param {string} url */
export function openUrlInSystemBrowser(url) {
    return invoke('open_url_in_system_browser', { url });
}

/**
 * Returns the current webview instance for native drag/drop events.
 * @returns {import('@tauri-apps/api/webview').Webview}
 */
export function getActiveWebview() {
    return getCurrentWebview();
}
