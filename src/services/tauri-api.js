import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile as tauriReadTextFile, stat as tauriStat, writeTextFile } from '@tauri-apps/plugin-fs';
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

/**
 * Opens a native save dialog for a PNG card file.
 * @param {string} defaultName
 * @returns {Promise<string|null>} Saved path or null when canceled.
 */
export async function pickSavePngPath(defaultName) {
    const filePath = await save({
        defaultPath: defaultName,
        filters: [{
            name: 'PNG image',
            extensions: ['png'],
        }],
    });

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        return filePath;
    }
    return null;
}

/**
 * Opens a native save dialog for a JSON file.
 * @param {string} defaultName
 * @returns {Promise<string|null>} Saved path or null when canceled.
 */
export async function pickSaveJsonPath(defaultName) {
    const filePath = await save({
        defaultPath: defaultName,
        filters: [{
            name: 'JSON file',
            extensions: ['json'],
        }],
    });

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        return filePath;
    }
    return null;
}

/**
 * Writes UTF-8 text content to disk.
 * @param {string} filePath
 * @param {string} content
 */
export function saveTextFile(filePath, content) {
    return writeTextFile(filePath, content);
}

/**
 * Opens native file picker and returns one selected image file path.
 * @param {{pngOnly?: boolean}} [options]
 * @returns {Promise<string|null>} Picked file path or null when canceled.
 */
export async function pickImageFilePath(options = {}) {
    const pngOnly = Boolean(options.pngOnly);
    const filters = pngOnly
        ? [{ name: 'PNG image', extensions: ['png'] }]
        : [{ name: 'Image files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'] }];

    const selected = await open({
        directory: false,
        multiple: false,
        filters,
    });

    if (typeof selected === 'string' && selected.trim().length > 0) {
        return selected;
    }
    if (Array.isArray(selected) && selected.length > 0 && typeof selected[0] === 'string') {
        return selected[0];
    }
    return null;
}

/**
 * Opens native file picker and returns one selected JSON file path.
 * @returns {Promise<string|null>} Picked file path or null when canceled.
 */
export async function pickOpenJsonPath() {
    const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: 'JSON file', extensions: ['json'] }],
    });

    if (typeof selected === 'string' && selected.trim().length > 0) {
        return selected;
    }
    if (Array.isArray(selected) && selected.length > 0 && typeof selected[0] === 'string') {
        return selected[0];
    }
    return null;
}

/**
 * Reads UTF-8 text content from disk.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function readTextFile(filePath) {
    return tauriReadTextFile(filePath);
}

/**
 * Lists media files in a directory through the backend file-system command.
 * Architectural context: keeps path validation and format filtering in Rust.
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
export function listDirectoryFiles(dirPath) {
    return invoke('list_directory_files', { dirPath });
}

/**
 * Retrieves full metadata payload for one selected file.
 * Architectural context: delegates format-specific parsing to backend extractors.
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
export function getFileMetadata(filePath) {
    return invoke('get_file_metadata', { filePath });
}

/**
 * Updates editable metadata fields for one file.
 * @param {{filePath: string, updates: Record<string, string>}} payload
 * @returns {Promise<number>}
 */
export function updateFileMetadataFields(payload) {
    return invoke('update_file_metadata_fields', payload);
}

/**
 * Retrieves compact metadata used for folder filtering/sorting.
 * @param {string} filePath
 * @param {boolean} includeExif
 * @returns {Promise<Record<string, unknown>>}
 */
export function getFileFilterInfo(filePath, includeExif) {
    return invoke('get_file_filter_info', { filePath, includeExif });
}

/**
 * Checks whether a file contains embedded JSON payloads.
 * Architectural context: centralizes container-specific probing in Rust.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export function hasEmbeddedJson(filePath) {
    return invoke('has_embedded_json', { filePath });
}

/**
 * Lists all embedded JSON entries discovered in a file.
 * @param {string} filePath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export function getEmbeddedBase64JsonEntries(filePath) {
    return invoke('get_embedded_base64_json_entries', { filePath });
}

/**
 * Updates one embedded JSON payload in-place.
 * @param {{filePath: string, entryId: number, jsonText: string}} payload
 * @returns {Promise<void>}
 */
export function updateEmbeddedBase64Json(payload) {
    return invoke('update_embedded_base64_json', payload);
}

/**
 * Inserts or replaces the character-card JSON payload in a PNG image.
 * @param {{filePath: string, jsonText: string}} payload
 * @returns {Promise<void>}
 */
export function upsertPngCharacterCard(payload) {
    return invoke('upsert_png_character_card', payload);
}

/**
 * Creates a new PNG character card by combining image data and JSON payload.
 * @param {{filePath: string, imageDataUrl: string, jsonText: string}} payload
 * @returns {Promise<void>}
 */
export function createPngCharacterCard(payload) {
    return invoke('create_png_character_card', payload);
}

/**
 * Returns plaintext metadata/text entries from supported containers.
 * @param {string} filePath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export function getTextEntries(filePath) {
    return invoke('get_text_entries', { filePath });
}

/**
 * Requests image thumbnail data URL from backend.
 * @param {string} filePath
 * @param {number} maxSize
 * @returns {Promise<string>}
 */
export function getThumbnail(filePath, maxSize) {
    return invoke('get_thumbnail', { filePath, maxSize });
}

/**
 * Requests in-memory video data URL for preview.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export function getVideoDataUrl(filePath, maxBytes) {
    return invoke('get_video_data_url', { filePath, maxBytes });
}

/**
 * Requests in-memory audio data URL for preview.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export function getAudioDataUrl(filePath, maxBytes) {
    return invoke('get_audio_data_url', { filePath, maxBytes });
}

/**
 * Requests embedded audio cover image if available.
 * @param {string} filePath
 * @param {number} maxSize
 * @returns {Promise<string>}
 */
export function getAudioCover(filePath, maxSize) {
    return invoke('get_audio_cover', { filePath, maxSize });
}

/**
 * Requests image file as data URL for card creation.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function getImageDataUrl(filePath) {
    return invoke('get_image_data_url', { filePath });
}

/**
 * Moves a file to the system trash/recycle bin.
 * Returns error message if operation fails (permission denied, file not found, etc).
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export function deleteFileToTrash(filePath) {
    return invoke('delete_file_to_trash', { filePath });
}

/**
 * Opens an external URL via the host operating system browser.
 * @param {string} url
 * @returns {Promise<void>}
 */
export function openUrlInSystemBrowser(url) {
    return invoke('open_url_in_system_browser', { url });
}

/**
 * Stores one generated LLM response for iterative prompt context.
 * @param {{sessionId: string, targetField: string, responseText: string}} payload
 * @returns {Promise<void>}
 */
export function appendLlmIterationResponse(payload) {
    return invoke('append_llm_iteration_response', payload);
}

/**
 * Returns previous generated responses for one session/field pair.
 * @param {{sessionId: string, targetField: string, limit?: number}} payload
 * @returns {Promise<string[]>}
 */
export function getLlmIterationResponses(payload) {
    return invoke('get_llm_iteration_responses', payload);
}

/**
 * Clears all stored iterative generation responses for one session.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function clearLlmIterationHistory(sessionId) {
    return invoke('clear_llm_iteration_history', { sessionId });
}

/**
 * Returns the current webview instance for native drag/drop events.
 * @returns {import('@tauri-apps/api/webview').Webview}
 */
export function getActiveWebview() {
    return getCurrentWebview();
}

/**
 * Loads persisted application settings from unified backend app-data store.
 * @returns {Promise<Record<string, unknown>>}
 */
export function getAppSettings() {
    return invoke('get_app_settings');
}

/**
 * Saves application settings into unified backend app-data store.
 * @param {Record<string, unknown>} settings
 * @returns {Promise<void>}
 */
export function saveAppSettings(settings) {
    return invoke('save_app_settings', { settings });
}

/**
 * Returns absolute path to backend-managed unified app-data file.
 * @returns {Promise<string>}
 */
export function getAppDataPath() {
    return invoke('get_app_data_path');
}

/**
 * Returns filesystem metadata for an absolute path from the native shell.
 * Used by drag/drop routing to distinguish folders from files safely.
 * @param {string} filePath
 * @returns {Promise<import('@tauri-apps/plugin-fs').FileInfo>}
 */
export function getPathInfo(filePath) {
    return tauriStat(filePath);
}
