import { METADATA_MAX_RATIO, METADATA_MIN, SIDEBAR_MAX_RATIO, SIDEBAR_MIN } from '../constants.js';
import { dom } from '../dom.js';

/**
 * Clamps numeric values between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Initializes pointer-drag resizing for sidebar and metadata pane.
 */
export function initResizableLayout() {
    const root = document.documentElement;
    const mainContainer = document.querySelector('.main-container');

    if (!dom.sidebarSplitter || !dom.metadataSplitter || !mainContainer || !dom.metadataView) {
        return;
    }

    dom.sidebarSplitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        dom.sidebarSplitter.classList.add('dragging');
        document.body.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        dom.sidebarSplitter.setPointerCapture(event.pointerId);

        const containerRect = mainContainer.getBoundingClientRect();
        const maxWidth = Math.floor(containerRect.width * SIDEBAR_MAX_RATIO);
        const next = clamp(event.clientX - containerRect.left, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, maxWidth));
        root.style.setProperty('--sidebar-width', `${next}px`);
    });

    dom.sidebarSplitter.addEventListener('pointermove', (event) => {
        if (!dom.sidebarSplitter.classList.contains('dragging')) {
            return;
        }

        const containerRect = mainContainer.getBoundingClientRect();
        const maxWidth = Math.floor(containerRect.width * SIDEBAR_MAX_RATIO);
        const next = clamp(event.clientX - containerRect.left, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, maxWidth));
        root.style.setProperty('--sidebar-width', `${next}px`);
    });

    const stopSidebarDrag = () => {
        dom.sidebarSplitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
    };

    dom.sidebarSplitter.addEventListener('pointerup', stopSidebarDrag);
    dom.sidebarSplitter.addEventListener('pointercancel', stopSidebarDrag);

    dom.metadataSplitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        dom.metadataSplitter.classList.add('dragging');
        document.body.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        dom.metadataSplitter.setPointerCapture(event.pointerId);

        const viewRect = dom.metadataView.getBoundingClientRect();
        const bottomDistance = viewRect.bottom - event.clientY;
        const maxHeight = Math.floor(viewRect.height * METADATA_MAX_RATIO);
        const next = clamp(bottomDistance, METADATA_MIN, Math.max(METADATA_MIN, maxHeight));
        root.style.setProperty('--metadata-height', `${next}px`);
    });

    dom.metadataSplitter.addEventListener('pointermove', (event) => {
        if (!dom.metadataSplitter.classList.contains('dragging')) {
            return;
        }

        const viewRect = dom.metadataView.getBoundingClientRect();
        const bottomDistance = viewRect.bottom - event.clientY;
        const maxHeight = Math.floor(viewRect.height * METADATA_MAX_RATIO);
        const next = clamp(bottomDistance, METADATA_MIN, Math.max(METADATA_MIN, maxHeight));
        root.style.setProperty('--metadata-height', `${next}px`);
    });

    const stopMetadataDrag = () => {
        dom.metadataSplitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
    };

    dom.metadataSplitter.addEventListener('pointerup', stopMetadataDrag);
    dom.metadataSplitter.addEventListener('pointercancel', stopMetadataDrag);
}
