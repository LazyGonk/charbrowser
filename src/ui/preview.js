import {
    AUDIO_COVER_MAX_SIZE,
    AUDIO_EXTS,
    IMAGE_EXTS,
    PREVIEW_IMAGE_MAX_SIZE,
    PREVIEW_MEDIA_MAX_BYTES,
    VIDEO_EXTS,
} from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { getAudioCover, getAudioDataUrl, getThumbnail, getVideoDataUrl } from '../services/tauri-api.js';

/**
 * Waits for video metadata readiness with timeout fallback.
 * @param {HTMLVideoElement} videoElement
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function waitForVideoReady(videoElement, timeoutMs = 5000) {
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
    dom.noPreview.textContent = 'No preview available';
    dom.noPreview.style.display = 'none';

    if (IMAGE_EXTS.has(ext)) {
        try {
            const largePreview = await getThumbnail(filePath, PREVIEW_IMAGE_MAX_SIZE);
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

            const isReady = await waitForVideoReady(dom.videoPreview, 5000);
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

    dom.noPreview.style.display = 'block';
}
