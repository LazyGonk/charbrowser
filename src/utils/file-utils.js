import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '../constants.js';

/**
 * Returns normalized lowercase extension from a file path.
 * Used by filters, preview routing, and metadata logic.
 * @param {string} filePath Absolute or relative file path.
 * @returns {string} Extension without leading dot, or empty string.
 */
export function getExtension(filePath) {
    const fileName = getFileName(filePath);
    const idx = fileName.lastIndexOf('.');
    if (idx === -1) {
        return '';
    }
    return fileName.slice(idx + 1).toLowerCase();
}

/**
 * Extracts a file name from an absolute or relative path.
 * @param {string} filePath
 * @returns {string}
 */
export function getFileName(filePath) {
    return String(filePath).split(/[\\/]/).pop() || '';
}

/**
 * Categorizes a file path into image/video/audio/other buckets.
 * This powers the folder type filter and icon/preview decisions.
 * @param {string} filePath File path to classify.
 * @returns {'image'|'video'|'audio'|'other'} Logical file kind.
 */
export function fileKindByPath(filePath) {
    const ext = getExtension(filePath);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return 'other';
}

/**
 * Formats byte values to a readable string for metadata panel display.
 * @param {number} bytes File size in bytes.
 * @returns {string} Human-readable size string.
 */
export function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = Number(bytes || 0);
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Formats media duration in seconds as mm:ss or hh:mm:ss.
 * @param {number} seconds Duration in seconds.
 * @returns {string} Formatted time string.
 */
export function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}
