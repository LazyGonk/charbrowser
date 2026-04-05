import { dom } from '../dom.js';
import { getActiveWebview } from '../services/tauri-api.js';

/**
 * Initializes browser and Tauri drag/drop listeners for quick file metadata loading.
 * @param {(filePath: string) => Promise<void>} onFileDropped
 */
export function initDragDrop(onFileDropped) {
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter += 1;
        dom.dropZone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter -= 1;
        if (dragCounter === 0) {
            dom.dropZone.classList.remove('drag-over');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dom.dropZone.classList.remove('drag-over');
    });

    getActiveWebview().onDragDropEvent(async (event) => {
        if (event.payload.type === 'over' || event.payload.type === 'enter') {
            dom.dropZone.classList.add('drag-over');
            return;
        }

        if (event.payload.type === 'leave') {
            dom.dropZone.classList.remove('drag-over');
            return;
        }

        if (event.payload.type === 'drop') {
            dom.dropZone.classList.remove('drag-over');
            const files = event.payload.paths;
            if (files && files.length > 0) {
                await onFileDropped(files[0]);
            }
        }
    }).catch((_error) => {
        // Keep app functional if webview drag/drop registration fails.
    });
}
