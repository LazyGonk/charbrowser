import { AUDIO_EXTS, IMAGE_EXTS, MEDIA_EXTS, VIDEO_EXTS } from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { filterWithAsyncPredicate, sortFiles } from '../services/filter-service.js';
import { getMetadataFilterData, hasEmbeddedJsonEntries } from '../services/metadata-service.js';
import { listDirectoryFiles } from '../services/tauri-api.js';
import { resetThumbnailQueue, thumbnailObserver } from '../services/thumbnail-service.js';
import { fileKindByPath, getExtension } from '../utils/file-utils.js';
import { createFileIcon } from './file-icons.js';

/**
 * Loads directory files, resets caches, and applies active filters.
 * @param {string} dirPath
 * @param {() => Promise<void>} onLoadSelectedFile
 */
export async function loadDirectory(dirPath, onLoadSelectedFile) {
    try {
        state.folderLoadToken += 1;
        resetThumbnailQueue();
        state.metadataFilterCache.clear();
        state.embeddedJsonPresenceCache.clear();

        const files = await listDirectoryFiles(dirPath);
        state.allFolderFiles = files;
        dom.folderPath.textContent = dirPath;

        await applyFolderFilters(onLoadSelectedFile);
    } catch (_error) {
        dom.folderPath.textContent = 'Error loading directory';
    }
}

/**
 * Renders current file list into sidebar.
 * @param {string[]} files
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export function renderFileList(files, onFileSelected) {
    dom.fileList.innerHTML = '';

    if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'file-list-empty';
        empty.textContent = 'No files match the current filters.';
        dom.fileList.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of files) {
        addFileToList(file, onFileSelected, fragment);
    }
    dom.fileList.appendChild(fragment);
}

/**
 * Adds one file item row to list with thumbnail/icon and selection behavior.
 * @param {string} filePath
 * @param {(filePath: string) => Promise<void>} onFileSelected
 * @param {HTMLElement|DocumentFragment} parent
 */
export function addFileToList(filePath, onFileSelected, parent = dom.fileList) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = filePath;

    const fileName = filePath.split(/[\\/]/).pop();
    const ext = getExtension(filePath);

    if (IMAGE_EXTS.has(ext)) {
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
        selectFileInList(filePath);
        await onFileSelected(filePath);
    });

    parent.appendChild(item);
}

/**
 * Marks selected file in list and keeps it in view.
 * @param {string} filePath
 */
export function selectFileInList(filePath) {
    document.querySelectorAll('.file-item').forEach((i) => i.classList.remove('selected'));
    const item = dom.fileList.querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
    if (item) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
    }
}

/**
 * Applies all active sidebar filters and sorting to folder files.
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export async function applyFolderFilters(onFileSelected) {
    const token = ++state.folderFilterToken;
    const previousSelected = state.selectedFile;

    let filtered = [...state.allFolderFiles];
    const nameTerm = (dom.fileNameFilter.value || '').trim().toLowerCase();
    const metadataTerm = (dom.metadataWordFilter.value || '').trim().toLowerCase();
    const typeFilter = dom.fileTypeFilter.value || 'all';
    const mediaOnly = dom.mediaOnlyToggle.checked;
    const embeddedOnly = Boolean(dom.hasEmbeddedJsonOnly?.checked);
    const exifOnly = Boolean(dom.hasExifOnly?.checked);
    const sortBy = dom.sortByFilter?.value || 'name';
    const sortDirection = dom.sortDirectionFilter?.value || 'asc';

    if (nameTerm) {
        filtered = filtered.filter((filePath) => {
            const fileName = filePath.split(/[\\/]/).pop() || '';
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
    const needsMetadata = metadataTerm.length > 0 || exifOnly || sortBy !== 'name';

    if (needsMetadata) {
        dom.folderFilterStatus.textContent = 'Loading metadata...';
        await filterWithAsyncPredicate(
            filtered,
            token,
            async (filePath) => {
                await getMetadataFilterData(filePath, { includeExif: exifOnly });
                return true;
            },
            5
        );
        if (checkToken()) {
            return;
        }
    }

    if (metadataTerm) {
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
        return;
    }

    const nextFile = filtered.includes(previousSelected) ? previousSelected : filtered[0];
    selectFileInList(nextFile);
    if (nextFile !== previousSelected) {
        await onFileSelected(nextFile);
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
    }, 220);
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
