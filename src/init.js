import { dom } from './dom.js';
import { loadFileMetadataData } from './services/metadata-service.js';
import { pickDirectory } from './services/tauri-api.js';
import { getExtension } from './utils/file-utils.js';
import { collectCopyableMetadataPairs } from './utils/metadata-utils.js';
import { state } from './state.js';
import { loadDirectory, initFolderFilters, selectFileInList } from './ui/folder-view.js';
import { getPreferredEmbeddedJsonText, initEmbeddedJsonUI, loadEmbeddedBase64Json } from './ui/embedded-json.js';
import { initDragDrop } from './ui/drag-drop.js';
import { initKeyboardNavigation } from './ui/keyboard-nav.js';
import { initLicensesModal } from './ui/licenses-modal.js';
import { displayMetadata } from './ui/metadata-panel.js';
import { updatePreview } from './ui/preview.js';
import { initResizableLayout } from './ui/resizable-layout.js';
import { loadTextEntries } from './ui/text-entries.js';

/**
 * Loads metadata and all dependent UI panels for one selected file.
 * @param {string} filePath
 */
export async function loadFileMetadata(filePath) {
    const requestToken = ++state.metadataLoadToken;
    try {
        state.selectedFile = filePath;
        const metadata = await loadFileMetadataData(filePath);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }

        const ext = getExtension(filePath);

        dom.dropZone.style.display = 'none';
        dom.metadataView.style.display = 'flex';

        await updatePreview(filePath, ext, requestToken);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }

        displayMetadata(metadata);
        await loadEmbeddedBase64Json(filePath, ext);
        await loadTextEntries(filePath, ext);
    } catch (_error) {
        // Ignore transient selection/load errors.
    }
}

/**
 * Reloads currently selected file metadata (used after JSON save).
 */
export async function reloadSelectedFile() {
    if (!state.selectedFile) {
        return;
    }
    await loadFileMetadata(state.selectedFile);
}

/**
 * Copies best-available metadata text to clipboard for active file.
 */
export async function copyAllMetadata() {
    if (!state.selectedFile) {
        return;
    }

    const selectedExt = getExtension(state.selectedFile);
    let output = '';

    output = getPreferredEmbeddedJsonText();

    const metadataPairsText = collectCopyableMetadataPairs(dom.metadataContent);
    if (!output && selectedExt === 'flac') {
        output = metadataPairsText;
    }

    if (!output && selectedExt === 'png' && state.textEntries && state.textEntries.length > 0) {
        for (const entry of state.textEntries) {
            if (entry && typeof entry.text === 'string' && entry.text.trim().length > 0) {
                output = entry.text.trim();
                break;
            }
        }
    }

    if (!output) {
        output = metadataPairsText;
    }

    if (!output && state.textEntries && state.textEntries.length > 0) {
        for (const entry of state.textEntries) {
            if (entry.text) {
                output = entry.text;
                break;
            }
        }
    }

    if (!output) {
        const parts = [];

        if (dom.characterDescription && dom.characterDescription.textContent && !dom.characterDescription.textContent.includes('Not available')) {
            parts.push(`Description: ${dom.characterDescription.textContent}`);
        }
        if (dom.characterFirstMes && dom.characterFirstMes.textContent && !dom.characterFirstMes.textContent.includes('Not available')) {
            parts.push(`First Message: ${dom.characterFirstMes.textContent}`);
        }
        if (parts.length > 0) {
            output = parts.join('\n\n');
        }
    }

    if (!output) {
        if (dom.copyMetadataBtn) {
            dom.copyMetadataBtn.title = 'No metadata to copy';
        }
        return;
    }

    try {
        await navigator.clipboard.writeText(output);
        if (dom.copyMetadataBtn) {
            dom.copyMetadataBtn.textContent = 'Copied!';
            setTimeout(() => {
                if (dom.copyMetadataBtn) {
                    dom.copyMetadataBtn.textContent = 'Copy All Metadata';
                }
            }, 2000);
        }
    } catch (_err) {
        // Ignore clipboard failures in unsupported environments.
    }
}

/**
 * Initializes all frontend modules and top-level UI entry events.
 */
export function initApp() {
    dom.openFolderBtn?.addEventListener('click', async () => {
        try {
            const directory = await pickDirectory();
            if (directory) {
                await loadDirectory(directory, loadFileMetadata);
            }
        } catch (error) {
            dom.folderPath.textContent = `Open folder failed: ${String(error)}`;
        }
    });

    dom.copyMetadataBtn?.addEventListener('click', copyAllMetadata);

    initFolderFilters(loadFileMetadata);
    initLicensesModal();
    initResizableLayout();
    initKeyboardNavigation(selectFileInList, loadFileMetadata);
    initDragDrop(loadFileMetadata);
    initEmbeddedJsonUI({
        onReloadSelectedFile: reloadSelectedFile,
    });
}
