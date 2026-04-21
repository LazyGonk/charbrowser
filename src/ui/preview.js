import {
    AUDIO_COVER_MAX_SIZE,
    AUDIO_EXTS,
    IMAGE_EXTS,
    JSON_EXTS,
    JSON_PREVIEW_MAX_LENGTH,
    PREVIEW_IMAGE_MAX_SIZE,
    PREVIEW_MEDIA_MAX_BYTES,
    VIDEO_READY_TIMEOUT_MS,
    VIDEO_EXTS,
} from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { getAudioCover, getAudioDataUrl, getImageDataUrl, getThumbnail, getVideoDataUrl, readTextFile } from '../services/tauri-api.js';
import { getFileName, formatDuration } from '../utils/file-utils.js';
import { formatJsonPreviewText } from '../utils/json-utils.js';
import { escapeHtml } from '../utils/string-utils.js';
import { setFileInfoVisibility } from './metadata-panel.js';

let previewOverlayInitialized = false;
let isFileInfoExpanded = false;
let currentFileMetadata = null;

/**
 * Initializes preview overlay controls once.
 */
function ensurePreviewOverlay() {
    if (previewOverlayInitialized) {
        return;
    }

    dom.previewFileInfoToggleBtn?.addEventListener('click', () => {
        if (!dom.previewFileInfoDetails) {
            return;
        }
        isFileInfoExpanded = !isFileInfoExpanded;
        dom.previewFileInfoDetails.style.display = isFileInfoExpanded ? 'block' : 'none';
        dom.previewFileInfoToggleBtn.title = isFileInfoExpanded ? 'Hide file info' : 'Show file info';
        dom.previewFileInfoToggleBtn.textContent = isFileInfoExpanded ? '×' : 'i';
    });

    previewOverlayInitialized = true;
}

/**
 * Shows file information overlay with filename and optional details.
 * @param {string} fileLabel - Display filename
 * @param {{size?: string, type?: string, path?: string, width?: number, height?: number}} [details] - Optional file details
 */
export function setPreviewFileInfo(fileLabel, details) {
    ensurePreviewOverlay();
    if (!dom.previewFileInfoOverlay || !dom.previewFileInfoName) {
        return;
    }

    currentFileMetadata = details || null;
    dom.previewFileInfoName.textContent = fileLabel || '';
    
    // Populate file details in expandable overlay
    if (dom.previewFileInfoDetails) {
        let detailsHtml = '';
        if (details) {
            if (details.path) detailsHtml += `<div>File Path: ${escapeHtml(details.path)}</div>`;
            if (details.size) detailsHtml += `<div>File Size: ${details.size}</div>`;
            if (details.type) detailsHtml += `<div>File Type: ${details.type}</div>`;
            if (details.width && details.height) detailsHtml += `<div>Dimensions: ${details.width} × ${details.height}</div>`;
        }
        dom.previewFileInfoDetails.innerHTML = detailsHtml;
        dom.previewFileInfoDetails.style.display = 'none';
    }
    
    isFileInfoExpanded = false;
    dom.previewFileInfoOverlay.style.display = fileLabel ? 'inline-flex' : 'none';
}

/**
 * Updates overlay details for the currently displayed preview file.
 * @param {{size?: string, type?: string, path?: string, width?: number, height?: number, duration?: number}} details
 */
export function setPreviewFileInfoDetails(details) {
    currentFileMetadata = details || null;
    if (!dom.previewFileInfoDetails) {
        return;
    }

    let detailsHtml = '';
    if (details) {
        if (details.path) detailsHtml += `<div>File Path: ${escapeHtml(details.path)}</div>`;
        if (details.size) detailsHtml += `<div>File Size: ${details.size}</div>`;
        if (details.type) detailsHtml += `<div>File Type: ${details.type}</div>`;
        if (details.width && details.height) detailsHtml += `<div>Dimensions: ${details.width} × ${details.height}</div>`;
        if (details.duration != null) detailsHtml += `<div>Duration: ${formatDuration(details.duration)}</div>`;
    }

    dom.previewFileInfoDetails.innerHTML = detailsHtml;
    dom.previewFileInfoDetails.style.display = isFileInfoExpanded ? 'block' : 'none';
}

/**
 * Clears preview file information overlay and resets all state.
 */
export function clearPreviewFileInfo() {
    ensurePreviewOverlay();
    if (dom.previewFileInfoOverlay) {
        dom.previewFileInfoOverlay.style.display = 'none';
    }
    if (dom.previewFileInfoName) {
        dom.previewFileInfoName.textContent = '';
    }
    if (dom.previewFileInfoDetails) {
        dom.previewFileInfoDetails.innerHTML = '';
        dom.previewFileInfoDetails.style.display = 'none';
    }

    currentFileMetadata = null;
    isFileInfoExpanded = false;
    if (dom.previewFileInfoToggleBtn) {
        dom.previewFileInfoToggleBtn.title = 'Show file info';
        dom.previewFileInfoToggleBtn.textContent = 'i';
    }
    setFileInfoVisibility(false);
}

/**
 * Resets preview stage media elements and shows a default no-preview message.
 * @param {string} message
 */
export function resetPreviewStage(message = 'No preview available') {
    ensurePreviewOverlay();
    dom.previewStage?.parentElement?.scrollTo({ left: 0, top: 0 });
    dom.preview.style.display = 'none';
    dom.preview.removeAttribute('src');
    dom.videoPreview.style.display = 'none';
    dom.videoPreview.pause();
    dom.videoPreview.removeAttribute('src');
    dom.videoPreview.load();
    dom.audioPreview.style.display = 'none';
    dom.audioPreview.pause();
    dom.audioPreview.removeAttribute('src');
    dom.previewStage?.classList.remove('audio-cover-layout');
    dom.previewStage?.classList.remove('audio-no-cover-layout');
    dom.noPreview.classList.remove('json-preview-message');
    dom.noPreview.textContent = message;
    dom.noPreview.style.display = 'block';
    clearPreviewFileInfo();
}

/**
 * Shows an image data URL in the preview stage and hides fallback message/media.
 * @param {string} imageDataUrl
 */
export function showPreviewImageDataUrl(imageDataUrl) {
    ensurePreviewOverlay();
    dom.previewStage?.parentElement?.scrollTo({ left: 0, top: 0 });
    dom.videoPreview.style.display = 'none';
    dom.videoPreview.pause();
    dom.videoPreview.removeAttribute('src');
    dom.videoPreview.load();

    dom.audioPreview.style.display = 'none';
    dom.audioPreview.pause();
    dom.audioPreview.removeAttribute('src');

    dom.previewStage?.classList.remove('audio-cover-layout');
    dom.previewStage?.classList.remove('audio-no-cover-layout');

    dom.noPreview.style.display = 'none';
    dom.preview.src = imageDataUrl;
    dom.preview.style.display = 'block';
}

/**
 * Shows JSON text in preview stage with optional pretty formatting.
 * @param {string} jsonText
 */
function showJsonPreview(jsonText) {
    const { formattedText } = formatJsonPreviewText(jsonText, JSON_PREVIEW_MAX_LENGTH);
    const escaped = escapeHtml(formattedText);

    dom.noPreview.classList.add('json-preview-message');
    dom.noPreview.innerHTML = `<pre class="json-preview-content">${escaped}</pre>`;
    dom.noPreview.style.display = 'block';
}

/**
 * Waits for video metadata readiness with timeout fallback.
 * @param {HTMLVideoElement} videoElement
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function waitForVideoReady(videoElement, timeoutMs = VIDEO_READY_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;

        const finalize = (ok) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(ok);
        };

        const onLoadedMetadata = () => finalize(true);
        const onError = () => finalize(false);
        const cleanup = () => {
            videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
            videoElement.removeEventListener('error', onError);
            clearTimeout(timer);
        };

        const timer = setTimeout(() => {
            finalize(videoElement.readyState >= HTMLMediaElement.HAVE_METADATA);
        }, timeoutMs);

        videoElement.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        videoElement.addEventListener('error', onError, { once: true });
    });
}

/**
 * Updates preview stage based on selected file extension.
 * @param {string} filePath
 * @param {string} ext
 * @param {number} requestToken
 */
export async function updatePreview(filePath, ext, requestToken) {
    if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
        return;
    }

    resetPreviewStage('No preview available');
    dom.noPreview.style.display = 'none';
    const fileLabel = getFileName(filePath) || filePath;
    setPreviewFileInfo(fileLabel, currentFileMetadata || undefined);

    if (IMAGE_EXTS.has(ext)) {
        try {
            // For PNGs, prefer the original data URL over backend thumbnail re-encoding.
            // This avoids codec/metadata edge cases where a re-encoded preview can appear offset.
            const largePreview = ext === 'png'
                ? await getImageDataUrl(filePath)
                : await getThumbnail(filePath, PREVIEW_IMAGE_MAX_SIZE);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            dom.preview.src = largePreview;
            dom.preview.style.display = 'block';
            return;
        } catch (_error) {
            // Continue to fallback message below.
        }
    }

    if (VIDEO_EXTS.has(ext)) {
        try {
            const videoSrc = await getVideoDataUrl(filePath, PREVIEW_MEDIA_MAX_BYTES);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            dom.videoPreview.src = videoSrc;
            dom.videoPreview.style.display = 'block';
            dom.videoPreview.load();

            const isReady = await waitForVideoReady(dom.videoPreview);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            if (!isReady) {
                dom.videoPreview.pause();
                dom.videoPreview.style.display = 'none';
                dom.noPreview.textContent = 'Video preview unavailable for this file (unsupported codec/container).';
                dom.noPreview.style.display = 'block';
            }
        } catch (error) {
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            dom.videoPreview.pause();
            dom.videoPreview.style.display = 'none';
            dom.noPreview.textContent = `Video preview unavailable: ${String(error)}`;
            dom.noPreview.style.display = 'block';
        }
        return;
    }

    if (AUDIO_EXTS.has(ext)) {
        let audioLoaded = false;
        let hasCover = false;

        try {
            const audioSrc = await getAudioDataUrl(filePath, PREVIEW_MEDIA_MAX_BYTES);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            dom.audioPreview.src = audioSrc;
            audioLoaded = true;
        } catch (_error) {
            dom.audioPreview.style.display = 'none';
            dom.audioPreview.removeAttribute('src');
        }

        try {
            const cover = await getAudioCover(filePath, AUDIO_COVER_MAX_SIZE);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            dom.preview.src = cover;
            dom.preview.style.display = 'block';
            hasCover = true;
        } catch (_error) {
            dom.preview.style.display = 'none';
            dom.preview.removeAttribute('src');
        }

        if (audioLoaded) {
            if (hasCover) {
                dom.previewStage?.classList.add('audio-cover-layout');
            } else {
                dom.previewStage?.classList.add('audio-no-cover-layout');
            }
            dom.audioPreview.style.display = 'block';
            dom.audioPreview.load();
        } else if (!hasCover) {
            dom.noPreview.textContent = 'No audio preview available';
            dom.noPreview.style.display = 'block';
        }
        return;
    }

    if (JSON_EXTS.has(ext)) {
        try {
            const jsonText = await readTextFile(filePath);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            showJsonPreview(jsonText);
        } catch (error) {
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            dom.noPreview.classList.remove('json-preview-message');
            dom.noPreview.textContent = `JSON preview unavailable: ${String(error)}`;
            dom.noPreview.style.display = 'block';
        }
        return;
    }

    dom.noPreview.classList.remove('json-preview-message');
    dom.noPreview.style.display = 'block';
}
