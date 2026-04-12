import { THUMBNAIL_CONCURRENCY, THUMBNAIL_SIZE } from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { getExtension } from '../utils/file-utils.js';
import { getThumbnail } from './tauri-api.js';
import { createFileIcon } from '../ui/file-icons.js';
import { loadSettings } from './settings-service.js';

/**
 * Clears thumbnail queue state when folder contents are reloaded.
 */
export function resetThumbnailQueue() {
    state.thumbnailQueue = [];
    state.thumbnailActiveCount = 0;
}

/**
 * Creates an observer that enqueues thumbnail jobs for visible list items.
 * @returns {IntersectionObserver}
 */
export function createThumbnailObserver() {
    return new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }

                const item = entry.target;
                const path = item.dataset.path;
                thumbnailObserver.unobserve(item);
                if (path) {
                    enqueueThumbnailLoad(item, path, state.folderLoadToken);
                }
            }
        },
        {
            root: dom.fileList,
            rootMargin: '200px'
        }
    );
}

/** @type {IntersectionObserver} */
export const thumbnailObserver = createThumbnailObserver();

/**
 * Queues a thumbnail job and kicks queue processing.
 * @param {HTMLElement} item File list item element.
 * @param {string} filePath Source file path.
 * @param {number} token Folder load token to drop stale jobs.
 */
export function enqueueThumbnailLoad(item, filePath, token) {
    state.thumbnailQueue.push({ item, filePath, token });
    drainThumbnailQueue();
}

/**
 * Processes queued thumbnails with bounded parallelism.
 */
export function drainThumbnailQueue() {
    if (loadSettings().showThumbnails === false) {
        state.thumbnailQueue = [];
        return;
    }

    while (state.thumbnailActiveCount < THUMBNAIL_CONCURRENCY && state.thumbnailQueue.length > 0) {
        const job = state.thumbnailQueue.shift();
        if (!job) {
            return;
        }

        if (job.token !== state.folderLoadToken || !job.item.isConnected) {
            continue;
        }

        state.thumbnailActiveCount += 1;
        loadImageThumbnail(job.item, job.filePath)
            .finally(() => {
                state.thumbnailActiveCount -= 1;
                drainThumbnailQueue();
            });
    }
}

/**
 * Loads and sets a thumbnail image for a file item.
 * @param {HTMLElement} item
 * @param {string} filePath
 */
export async function loadImageThumbnail(item, filePath) {
    try {
        if (loadSettings().showThumbnails === false) {
            const img = item.querySelector('.file-thumbnail');
            if (img) {
                img.remove();
            }
            if (!item.querySelector('.file-icon')) {
                item.prepend(createFileIcon(getExtension(filePath)));
            }
            return;
        }

        const img = item.querySelector('.file-thumbnail');
        if (!img) {
            return;
        }

        const thumbnailData = await getThumbnail(filePath, THUMBNAIL_SIZE);
        img.src = thumbnailData;
    } catch (_error) {
        const ext = getExtension(filePath);
        const img = item.querySelector('.file-thumbnail');
        if (img) {
            img.remove();
        }
        item.prepend(createFileIcon(ext));
    }
}
