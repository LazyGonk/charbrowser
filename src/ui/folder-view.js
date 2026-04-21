import { AUDIO_EXTS, FILTER_DEFAULT_CONCURRENCY, FOLDER_FILTER_DEBOUNCE_MS, IMAGE_EXTS, LOADING_OVERLAY_DELAY_MS, MEDIA_EXTS, VIDEO_EXTS } from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { filterWithAsyncPredicate, sortFiles } from '../services/filter-service.js';
import { getMetadataFilterData, hasEmbeddedJsonEntries } from '../services/metadata-service.js';
import { listDirectoryFiles, deleteFileToTrash } from '../services/tauri-api.js';
import { resetThumbnailQueue, thumbnailObserver } from '../services/thumbnail-service.js';
import { loadSettings, saveSettings } from '../services/settings-service.js';
import { fileKindByPath, getExtension, getFileName } from '../utils/file-utils.js';
import { createLoadingOverlayController } from '../utils/loading-overlay.js';
import { getInputValue } from '../utils/string-utils.js';
import { createFileIcon } from './file-icons.js';
import { confirmCardEditorExit, requestCardEditorConfirmation } from './card-editor.js';

let createNewCardHandler = () => {};

const folderLoadingOverlay = createLoadingOverlayController({
    setVisible: (visible) => {
        if (!dom.loadingOverlay) {
            return;
        }

        dom.loadingOverlay.classList.toggle('visible', visible);
        dom.loadingOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    },
    setText: (text) => {
        if (dom.loadingOverlayText) {
            dom.loadingOverlayText.textContent = text;
        }
    },
    showDelayMs: LOADING_OVERLAY_DELAY_MS,
});

/**
 * Registers callback invoked when the special "Create New Card" list entry is clicked.
 * @param {() => void} handler
 */
export function setCreateNewCardHandler(handler) {
    createNewCardHandler = typeof handler === 'function' ? handler : createNewCardHandler;
}

/**
 * Shows or hides the ".new" card entry based on card editor mode.
 * Entry is always visible but styled differently in create mode.
 * @param {boolean} isCreateMode
 */
function setNewCardEntryMode(isCreateMode) {
    const entry = dom.fileList?.querySelector('.file-item-new');
    if (entry) {
        if (isCreateMode) {
            entry.classList.add('active');
        } else {
            entry.classList.remove('active');
        }
    }
}

/**
 * Adds the "Create New Card" entry at the top of the file list.
 * @param {Function} onNewCardClick - Callback when clicked
 */
function addNewCardEntry(onNewCardClick) {
    const entry = document.createElement('div');
    entry.className = 'file-item file-item-new';
    entry.innerHTML = '<span class="file-icon">+</span><span class="file-name">Create New Card</span>';
    entry.addEventListener('click', onNewCardClick);
    return entry;
}

/**
 * Loads directory files, resets caches, and applies active filters.
 * @param {string} dirPath
 * @param {() => Promise<void>} onLoadSelectedFile
 */
export async function loadDirectory(dirPath, onLoadSelectedFile) {
    folderLoadingOverlay.begin('Loading folder...');

    try {
        state.folderLoadToken += 1;
        state.currentDirectory = dirPath;
        state.preserveEmptySelection = false;
        resetThumbnailQueue();
        state.metadataFilterCache.clear();
        state.embeddedJsonPresenceCache.clear();

        const files = await listDirectoryFiles(dirPath);
        state.allFolderFiles = files;
        // Update only the path text, preserving child elements like clearSelectionBtn
        dom.folderPath.firstChild.textContent = dirPath;

        await applyFolderFilters(onLoadSelectedFile, { showLoadingOverlay: true });
    } catch (_error) {
        dom.folderPath.textContent = 'Error loading directory';
    } finally {
        folderLoadingOverlay.end();
    }
}

/**
 * Renders current file list into sidebar.
 * @param {string[]} files
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export function renderFileList(files, onFileSelected) {
    dom.fileList.innerHTML = '';
    const settings = loadSettings();
    const showThumbnails = settings.showThumbnails !== false;

    // Add "Create New Card" entry at top when folder is open
    const newCardEntry = addNewCardEntry(() => {
        createNewCardHandler();
    });
    dom.fileList.appendChild(newCardEntry);
    // Style based on current mode
    if (state.cardEditorMode === 'create') {
        newCardEntry.classList.add('active');
    }

    if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'file-list-empty';
        empty.textContent = 'No files match the current filters.';
        dom.fileList.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of files) {
        addFileToList(file, onFileSelected, fragment, showThumbnails);
    }
    dom.fileList.appendChild(fragment);
}

/**
 * Updates the style of the ".new" card entry based on card editor mode.
 * Entry is always visible but styled differently in create mode.
 * Call this when card editor mode changes.
 */
export function updateNewCardEntryVisibility() {
    const isCreateMode = state.cardEditorMode === 'create' && !state.selectedFile;
    setNewCardEntryMode(isCreateMode);
}

/**
 * Adds one file item row to list with thumbnail/icon and selection behavior.
 * @param {string} filePath
 * @param {(filePath: string) => Promise<void>} onFileSelected
 * @param {HTMLElement|DocumentFragment} parent
 * @param {boolean} showThumbnails
 */
export function addFileToList(filePath, onFileSelected, parent = dom.fileList, showThumbnails = true) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = filePath;

    const fileName = getFileName(filePath);
    const ext = getExtension(filePath);

    if (IMAGE_EXTS.has(ext) && showThumbnails) {
        const img = document.createElement('img');
        img.className = 'file-thumbnail';
        img.alt = fileName;
        item.appendChild(img);
        thumbnailObserver.observe(item);
    } else {
        item.appendChild(createFileIcon(ext));
    }

    const nameDiv = document.createElement('div');
    nameDiv.className = 'file-name';
    nameDiv.textContent = fileName;
    nameDiv.title = fileName;
    item.appendChild(nameDiv);

    item.addEventListener('click', async () => {
        // Don't re-select if already selected
        if (state.selectedFile === filePath) {
            return;
        }
        // loadFileMetadata handles unsaved check AND visual selection order
        await onFileSelected(filePath);
    });

    parent.appendChild(item);
}

/**
 * Marks selected file in list and keeps it in view.
 * @param {string | null} filePath
 */
export function selectFileInList(filePath) {
    document.querySelectorAll('.file-item').forEach((i) => i.classList.remove('selected'));
    if (!filePath) {
        return;
    }
    const item = dom.fileList.querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
    if (item) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
    }
}

/**
 * Applies all active sidebar filters and sorting to folder files.
 * @param {(filePath: string) => Promise<void>} onFileSelected
 * @param {{showLoadingOverlay?: boolean}} [options]
 */
export async function applyFolderFilters(onFileSelected, options = {}) {
    const token = ++state.folderFilterToken;
    const previousSelected = state.selectedFile;
    const showLoadingOverlay = Boolean(options?.showLoadingOverlay);

    let filtered = [...state.allFolderFiles];
    const nameTerm = getInputValue(dom.fileNameFilter).toLowerCase();
    const metadataTerm = getInputValue(dom.metadataWordFilter).toLowerCase();
    const typeFilter = dom.fileTypeFilter.value || 'all';
    const mediaOnly = dom.mediaOnlyToggle.checked;
    const embeddedOnly = Boolean(dom.hasEmbeddedJsonOnly?.checked);
    const exifOnly = Boolean(dom.hasExifOnly?.checked);
    const sortBy = dom.sortByFilter?.value || 'name';
    const sortDirection = dom.sortDirectionFilter?.value || 'asc';

    if (nameTerm) {
        filtered = filtered.filter((filePath) => {
            const fileName = getFileName(filePath);
            return fileName.toLowerCase().includes(nameTerm);
        });
    }

    if (typeFilter !== 'all') {
        filtered = filtered.filter((filePath) => fileKindByPath(filePath) === typeFilter);
    }

    if (mediaOnly) {
        filtered = filtered.filter((filePath) => MEDIA_EXTS.has(getExtension(filePath)));
    }

    const checkToken = () => token !== state.folderFilterToken;
    const needsMetadataWarmup = metadataTerm.length === 0 && (exifOnly || sortBy !== 'name');

    if (needsMetadataWarmup) {
        if (showLoadingOverlay) {
            folderLoadingOverlay.setMessage('Loading metadata...');
        }
        dom.folderFilterStatus.textContent = 'Loading metadata...';
        await filterWithAsyncPredicate(
            filtered,
            token,
            async (filePath) => {
                await getMetadataFilterData(filePath, { includeExif: exifOnly });
                return true;
            },
            FILTER_DEFAULT_CONCURRENCY
        );
        if (checkToken()) {
            return;
        }
    }

    if (metadataTerm) {
        if (showLoadingOverlay) {
            folderLoadingOverlay.setMessage('Scanning metadata...');
        }
        dom.folderFilterStatus.textContent = 'Scanning metadata...';
        filtered = await filterWithAsyncPredicate(filtered, token, async (filePath) => {
            const data = await getMetadataFilterData(filePath, { includeExif: exifOnly });
            return data.searchBlob.includes(metadataTerm);
        });
        if (checkToken()) {
            return;
        }
    }

    if (exifOnly) {
        filtered = filtered.filter((filePath) => state.metadataFilterCache.get(filePath)?.hasExif === true);
    }

    if (embeddedOnly) {
        if (showLoadingOverlay) {
            folderLoadingOverlay.setMessage('Scanning embedded JSON...');
        }
        dom.folderFilterStatus.textContent = 'Scanning embedded JSON...';
        filtered = await filterWithAsyncPredicate(filtered, token, async (filePath) => hasEmbeddedJsonEntries(filePath));
        if (checkToken()) {
            return;
        }
    }

    sortFiles(filtered, state.metadataFilterCache, sortBy, sortDirection);

    state.currentFiles = filtered;
    renderFileList(filtered, onFileSelected);

    if (state.allFolderFiles.length === 0) {
        dom.folderFilterStatus.textContent = '';
    } else {
        dom.folderFilterStatus.textContent = `Showing ${filtered.length} of ${state.allFolderFiles.length} files`;
    }

    if (filtered.length === 0) {
        state.selectedFile = null;
        selectFileInList(null);
        return;
    }

    if (state.preserveEmptySelection && !previousSelected) {
        state.selectedFile = null;
        selectFileInList(null);
        return;
    }

    const nextFile = filtered.includes(previousSelected) ? previousSelected : filtered[0];
    selectFileInList(nextFile);
    if (nextFile !== previousSelected) {
        await onFileSelected(nextFile, { autoSelected: true });
    }
}

/**
 * Debounces expensive folder filter application while typing.
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export function scheduleFolderFilterApply(onFileSelected) {
    if (state.folderFilterDebounceTimer !== null) {
        clearTimeout(state.folderFilterDebounceTimer);
    }

    state.folderFilterDebounceTimer = window.setTimeout(() => {
        applyFolderFilters(onFileSelected);
    }, FOLDER_FILTER_DEBOUNCE_MS);
}

/**
 * Wires all folder filter controls to filter application behavior.
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export function initFolderFilters(onFileSelected) {
    if (
        !dom.fileNameFilter
        || !dom.fileTypeFilter
        || !dom.mediaOnlyToggle
        || !dom.metadataWordFilter
        || !dom.hasEmbeddedJsonOnly
        || !dom.hasExifOnly
        || !dom.sortByFilter
        || !dom.sortDirectionFilter
    ) {
        return;
    }

    dom.fileNameFilter.addEventListener('input', () => scheduleFolderFilterApply(onFileSelected));
    dom.metadataWordFilter.addEventListener('input', () => scheduleFolderFilterApply(onFileSelected));
    dom.fileTypeFilter.addEventListener('change', () => applyFolderFilters(onFileSelected));
    dom.mediaOnlyToggle.addEventListener('change', () => applyFolderFilters(onFileSelected));
    dom.hasEmbeddedJsonOnly.addEventListener('change', () => applyFolderFilters(onFileSelected));
    dom.hasExifOnly.addEventListener('change', () => applyFolderFilters(onFileSelected));
    dom.sortByFilter.addEventListener('change', () => applyFolderFilters(onFileSelected));
    dom.sortDirectionFilter.addEventListener('change', () => applyFolderFilters(onFileSelected));
}

/**
 * Deletes the currently selected file to the system trash after optional confirmation.
 * Moves selection to next file if available, else previous, else shows empty state.
 * On error, shows alert and leaves file in list.
 * @param {(filePath: string) => Promise<void>} onFileSelected
 * @returns {Promise<void>}
 */
export async function deleteSelectedFile(onFileSelected) {
    const filePath = state.selectedFile;
    if (!filePath) {
        return;
    }

    const settings = loadSettings();
    const requiresConfirmation = settings.deleteRequiresConfirmation !== false;

    // Show confirmation dialog if enabled
    if (requiresConfirmation) {
        const fileName = getFileName(filePath);
        const confirmed = await requestCardEditorConfirmation({
            message: `Delete "${fileName}" to trash?`,
            confirmLabel: '🗑️ Delete',
            cancelLabel: '❌ Cancel',
            skipOptionLabel: 'Do not ask again for file deletion',
            onConfirm: async ({ skipChecked }) => {
                if (skipChecked) {
                    await saveSettings({ deleteRequiresConfirmation: false });
                }
            },
        });

        if (!confirmed) {
            return;
        }
    }

    // Attempt to move file to trash
    try {
        await deleteFileToTrash(filePath);
    } catch (error) {
        alert(`Failed to delete file: ${error.message || error}`);
        return;
    }

    // Remove from state
    state.currentFiles = state.currentFiles.filter(f => f !== filePath);
    state.allFolderFiles = state.allFolderFiles.filter(f => f !== filePath);
    state.metadataFilterCache.delete(filePath);
    state.embeddedJsonPresenceCache.delete(filePath);

    // Find next file to select
    let nextFile = null;
    if (state.currentFiles.length > 0) {
        const currentIndex = state.currentFiles.indexOf(filePath);
        // Prefer next file in list, fallback to previous
        if (currentIndex >= 0 && currentIndex < state.currentFiles.length) {
            nextFile = state.currentFiles[currentIndex];
        } else if (currentIndex > 0) {
            nextFile = state.currentFiles[currentIndex - 1];
        } else if (state.currentFiles.length > 0) {
            nextFile = state.currentFiles[0];
        }
    }

    // Re-render file list and select next file
    renderFileList(state.currentFiles, onFileSelected);
    if (nextFile) {
        selectFileInList(nextFile);
        state.selectedFile = nextFile;
        await onFileSelected(nextFile);
    } else {
        state.selectedFile = null;
    }
}
