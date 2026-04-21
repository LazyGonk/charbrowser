import { dom } from './dom.js';
import { COPY_STATUS_RESET_MS, SURPRISE_OVERLAY_AUTO_HIDE_MS } from './constants.js';
import { loadEmbeddedJsonEntries, loadFileMetadataData } from './services/metadata-service.js';
import { getImageDataUrl, pickDirectory, pickOpenJsonPath, readTextFile } from './services/tauri-api.js';
import { formatFileSize, getExtension, getFileName } from './utils/file-utils.js';
import { collectCopyableMetadataPairs } from './utils/metadata-utils.js';
import { SURPRISE_SEQUENCE, getNextSurpriseIndex } from './utils/surprise-utils.js';
import { state } from './state.js';
import { applyFolderFilters, initFolderFilters, loadDirectory, selectFileInList, setCreateNewCardHandler, deleteSelectedFile, updateNewCardEntryVisibility } from './ui/folder-view.js';
import { getPreferredEmbeddedJsonText, initEmbeddedJsonUI, loadEmbeddedBase64Json, updateCharacterTextPanel } from './ui/embedded-json.js';
import { initDragDrop } from './ui/drag-drop.js';
import { initKeyboardNavigation, isTextEditingContext } from './ui/keyboard-nav.js';
import { initLicensesModal } from './ui/licenses-modal.js';
import { displayMetadata } from './ui/metadata-panel.js';
import { setPreviewFileInfoDetails, updatePreview } from './ui/preview.js';
import { initResizableLayout } from './ui/resizable-layout.js';
import { initSettingsModal } from './ui/settings-modal.js';
import { initAssistantUI, isAssistantPanelOpen } from './ui/assistant.js';
import { initializeSettings, loadSettings } from './services/settings-service.js';
import { loadTextEntries } from './ui/text-entries.js';
import {
    confirmCardEditorExit,
    discardUnsavedCardChanges,
    initCardEditor,
    findCardPayload,
    handleCreateModeJsonPathDrop,
    importJsonText,
    isCardLike,
    populateFromCard,
    setCreateImageFromDataUrl,
    setCreateImageFromFile,
    setStatus,
    requestCardEditorConfirmation,
    startCreateCardMode,
    stopCreateCardMode,
    syncCardEditorFromSelection,
    unwrapCardData,
} from './ui/card-editor.js';

let previousSchemaVersion = '2.0';
let surpriseSequenceIndex = 0;
let surpriseOverlayHideTimer = null;

function clearSurpriseTimer() {
    if (surpriseOverlayHideTimer !== null) {
        clearTimeout(surpriseOverlayHideTimer);
        surpriseOverlayHideTimer = null;
    }
}

function hideSurpriseOverlay() {
    clearSurpriseTimer();
    if (dom.surpriseOverlay) {
        dom.surpriseOverlay.classList.remove('is-visible');
        dom.surpriseOverlay.setAttribute('aria-hidden', 'true');
    }
}

function showSurpriseOverlay() {
    if (!dom.surpriseOverlay) {
        return;
    }

    dom.surpriseOverlay.classList.add('is-visible');
    dom.surpriseOverlay.setAttribute('aria-hidden', 'false');
    clearSurpriseTimer();
    surpriseOverlayHideTimer = window.setTimeout(() => {
        hideSurpriseOverlay();
    }, SURPRISE_OVERLAY_AUTO_HIDE_MS);
}

function trackSurpriseSequence(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
    }

    if (isTextEditingContext()) {
        return;
    }

    surpriseSequenceIndex = getNextSurpriseIndex(surpriseSequenceIndex, event.key);
    if (surpriseSequenceIndex >= SURPRISE_SEQUENCE.length) {
        showSurpriseOverlay();
        surpriseSequenceIndex = 0;
    }
}

/**
 * Returns true when the current card editor state can be abandoned safely.
 * When blocked, the previous file selection remains highlighted.
 * @param {string | null} previousSelected
 * @returns {Promise<boolean>}
 */
async function canLeaveCurrentCardContext(previousSelected) {
    if (await confirmCardEditorExit()) {
        discardUnsavedCardChanges();
        return true;
    }

    if (previousSelected) {
        selectFileInList(previousSelected);
    } else {
        document.querySelectorAll('.file-item').forEach((item) => item.classList.remove('selected'));
    }

    return false;
}

/**
 * App close is intentionally unrestricted; closing the window should always work.
 */
function registerCardEditorCloseGuards() {
    // No-op by design.
}

/**
 * Opens one resolved directory path after handling editor exit state.
 * @param {string | null} directory
 * @returns {Promise<boolean>}
 */
async function openDirectoryPath(directory) {
    try {
        if (!directory) {
            return false;
        }

        if (!(await confirmCardEditorExit())) {
            return false;
        }

        discardUnsavedCardChanges();
        if (state.cardEditorMode === 'create') {
            const stopped = await stopCreateCardMode({ skipUnsavedCheck: true });
            if (!stopped) {
                return false;
            }
        }

        await loadDirectory(directory, loadFileMetadata);
        return true;
    } catch (error) {
        dom.folderPath.textContent = `Open folder failed: ${String(error)}`;
        return false;
    }
}

/**
 * Opens the folder picker and switches directories after resolving card-editor exit state.
 * @returns {Promise<boolean>}
 */
async function openDirectoryFromPicker() {
    try {
        const directory = await pickDirectory();
        if (!directory) {
            return false;
        }

        return await openDirectoryPath(directory);
    } catch (error) {
        dom.folderPath.textContent = `Open folder failed: ${String(error)}`;
        return false;
    }
}

/**
 * Opens one JSON file through native picker and routes it through regular file load flow.
 * @returns {Promise<boolean>}
 */
async function openJsonFromPicker() {
    try {
        const filePath = await pickOpenJsonPath();
        if (!filePath) {
            return false;
        }

        await loadFileMetadata(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Opens folder picker first, then falls back to JSON file picker when canceled.
 */
async function openFolderOrJsonFromPicker() {
    const openedFolder = await openDirectoryFromPicker();
    if (openedFolder) {
        return;
    }
    await openJsonFromPicker();
}

/**
 * Returns true when one JSON file should be imported as a character card into create mode.
 * @param {string} filePath
 * @param {number} requestToken
 * @returns {Promise<boolean>}
 */
async function maybeOpenJsonAsCardEditor(filePath, requestToken) {
    if (getExtension(filePath) !== 'json') {
        return false;
    }

    try {
        const jsonText = await readTextFile(filePath);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return true;
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            return false;
        }

        const unwrapped = unwrapCardData(parsed);
        if (!isCardLike(unwrapped)) {
            return false;
        }

        const started = await startCreateCardMode();
        if (!started) {
            return true;
        }

        await importJsonText(jsonText);
        discardUnsavedCardChanges();
        state.selectedFile = filePath;
        selectFileInList(filePath);
        updateNewCardEntryVisibility();
        return true;
    } catch {
        return false;
    }
}

/**
 * Loads metadata and all dependent UI panels for one selected file.
 * @param {string} filePath
 */
export async function loadFileMetadata(filePath, { autoSelected = false } = {}) {
    const previousSelected = state.selectedFile;

    if (!(await canLeaveCurrentCardContext(previousSelected))) {
        return;
    }

    if (state.cardEditorMode === 'create') {
        const stopped = await stopCreateCardMode({ skipUnsavedCheck: true });
        if (!stopped) {
            return;
        }
    }

    const requestToken = ++state.metadataLoadToken;
    try {
        state.preserveEmptySelection = false;
        state.selectedFile = filePath;
        const ext = getExtension(filePath);

        if (!autoSelected && await maybeOpenJsonAsCardEditor(filePath, requestToken)) {
            return;
        }

        const metadata = await loadFileMetadataData(filePath);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }

        dom.dropZone.style.display = 'none';
        dom.metadataView.style.display = 'flex';

        // Show clear selection button
        if (dom.clearSelectionBtn) {
            dom.clearSelectionBtn.style.display = 'inline-block';
        }

        await updatePreview(filePath, ext, requestToken);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }

        displayMetadata(metadata);
        setPreviewFileInfoDetails({
            path: metadata.file_path || filePath,
            size: formatFileSize(metadata.file_size),
            type: metadata.file_type || ext,
            width: metadata.width,
            height: metadata.height,
            duration: metadata.duration,
        });

        // Handle lyrics for audio files
        const formatSpecific = metadata?.format_specific;
        const lyrics = formatSpecific?.lyrics;
        if (lyrics && typeof lyrics === 'string' && lyrics.trim().length > 0) {
            updateCharacterTextPanel(lyrics.trim(), null, 'Lyrics');
        } else {
            await loadEmbeddedBase64Json(filePath, ext);
            syncCardEditorFromSelection({
                filePath,
                ext,
                entries: state.embeddedJsonEntries,
            });
                await loadTextEntries(filePath, ext);
        }

        // Update file list highlight after successful load
        selectFileInList(filePath);
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
 * Clears the current file selection and returns to drop zone state.
 */
export async function clearSelection() {
    if (!(await confirmCardEditorExit())) {
        return;
    }

    discardUnsavedCardChanges();

    if (state.cardEditorMode === 'create') {
        const stopped = await stopCreateCardMode({ skipUnsavedCheck: true });
        if (!stopped) {
            return;
        }
    }

    state.selectedFile = null;
    state.currentDirectory = null;
    state.currentFiles = [];
    state.allFolderFiles = [];
    state.metadataFilterCache.clear();
    state.embeddedJsonPresenceCache.clear();
    state.metadataLoadToken++;
    state.preserveEmptySelection = false;

    // Reset UI to drop zone state
    dom.dropZone.style.display = 'flex';
    dom.metadataView.style.display = 'none';
    if (dom.dropZoneTitle) {
        dom.dropZoneTitle.textContent = 'Drop a file or folder here';
    }
    if (dom.dropZoneHint) {
        dom.dropZoneHint.textContent = 'or click here to open a folder or JSON file';
    }

    // Clear preview
    if (dom.preview) {
        dom.preview.src = '';
        dom.preview.style.display = 'none';
    }
    if (dom.videoPreview) {
        dom.videoPreview.pause();
        dom.videoPreview.src = '';
        dom.videoPreview.style.display = 'none';
    }
    if (dom.audioPreview) {
        dom.audioPreview.pause();
        dom.audioPreview.src = '';
        dom.audioPreview.style.display = 'none';
    }
    if (dom.noPreview) {
        dom.noPreview.textContent = 'No preview available';
        dom.noPreview.style.display = 'block';
    }

    if (dom.fileList) {
        dom.fileList.innerHTML = '';
    }
    if (dom.folderPath) {
        dom.folderPath.textContent = 'No folder opened';
    }
    if (dom.folderFilterStatus) {
        dom.folderFilterStatus.textContent = '';
    }

    // Hide clear button
    if (dom.clearSelectionBtn) {
        dom.clearSelectionBtn.style.display = 'none';
    }
}

/**
 * Imports one image file path into create mode via backend conversion.
 * This path is used for formats that browser Image() cannot decode directly.
 * @param {string} filePath Absolute source file path.
 * @returns {Promise<boolean>} True when image import succeeds.
 */
export async function importImagePathIntoCreateMode(filePath) {
    if (!filePath) {
        return false;
    }

    try {
        const ext = getExtension(filePath);
        const supported = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'];
        if (!supported.includes(ext)) {
            setStatus('Dropped file is not a supported image.');
            return false;
        }

        const imageDataUrl = await getImageDataUrl(filePath);
        const displayName = getFileName(filePath) || 'imported-image';
        return await setCreateImageFromDataUrl(imageDataUrl, displayName);
    } catch {
        setStatus('Image import failed for selected file.');
        return false;
    }
}

/**
 * Imports a PNG card file into create mode by loading image preview and optional card JSON.
 * @param {string} filePath Absolute source file path.
 */
export async function importPngCardIntoCreateMode(filePath) {
    if (!filePath || getExtension(filePath) !== 'png') {
        return;
    }

    try {
        const imageLoaded = await importImagePathIntoCreateMode(filePath);
        if (!imageLoaded) {
            return;
        }

        const entries = await loadEmbeddedJsonEntries(filePath);
        const cardPayload = findCardPayload(entries || []);
        if (!cardPayload) {
            setStatus('PNG image imported. No embedded card JSON found.');
            return;
        }

        const importConfirmed = await requestCardEditorConfirmation({
            message: 'Imported PNG contains character card data. Import card fields?',
            confirmLabel: '✅ Import fields',
            cancelLabel: '🖼️ Image only',
        });
        if (!importConfirmed) {
            setStatus('PNG image imported. Card field import skipped.');
            return;
        }

        populateFromCard(cardPayload);
        setStatus('Imported PNG image and card fields.');
    } catch {
        setStatus('Import failed for selected PNG.');
    }
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
            }, COPY_STATUS_RESET_MS);
        }
    } catch (_err) {
        // Ignore clipboard failures in unsupported environments.
    }
}

/**
 * Applies the current theme (dark or light mode) to the body element.
 * Called on app init and when settings change.
 * @param {boolean} isDarkMode - true for dark mode, false for light mode
 */
function applyTheme(isDarkMode) {
    if (isDarkMode) {
        document.body.classList.remove('light-mode');
    } else {
        document.body.classList.add('light-mode');
    }
}

/**
 * Disables browser spellcheck for current and future editable elements.
 * This keeps the desktop webview from adding red underlines to card fields.
 */
function disableWebviewSpellcheck() {
    document.body.spellcheck = false;

    const applySpellcheckOff = (root) => {
        if (!(root instanceof Element || root instanceof Document)) {
            return;
        }

        if (root instanceof HTMLElement && (root.matches('input, textarea, [contenteditable="true"]') || root.hasAttribute('contenteditable'))) {
            root.spellcheck = false;
        }

        root.querySelectorAll('input, textarea, [contenteditable], [contenteditable="true"]').forEach((element) => {
            if (element instanceof HTMLElement) {
                element.spellcheck = false;
            }
        });
    };

    applySpellcheckOff(document);

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach((node) => {
                applySpellcheckOff(node);
            });
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

/**
 * Initializes application settings, module wiring, and global input handlers.
 * @returns {Promise<void>}
 */
export async function initApp() {
    await initializeSettings();
    disableWebviewSpellcheck();

    // Apply initial theme based on settings
    const settings = loadSettings();
    applyTheme(settings.darkMode);

    registerCardEditorCloseGuards();

    dom.openFolderBtn?.addEventListener('click', async () => {
        await openDirectoryFromPicker();
    });

    // Clicking the drop zone opens folder picker first and then JSON picker as fallback.
    dom.dropZone?.addEventListener('click', async () => {
        await openFolderOrJsonFromPicker();
    });

    dom.copyMetadataBtn?.addEventListener('click', copyAllMetadata);

    window.addEventListener('charbrowser:settings-saved', () => {
        if (state.currentDirectory) {
            void applyFolderFilters(loadFileMetadata);
        }
    });

    dom.clearSelectionBtn?.addEventListener('click', async () => {
        await clearSelection();
    });

    dom.surpriseOverlay?.addEventListener('click', () => {
        hideSurpriseOverlay();
    });

    if (dom.cardSchemaVersion) {
        previousSchemaVersion = dom.cardSchemaVersion.value || '2.0';
    }

    dom.cardSchemaVersion?.addEventListener('change', async () => {
        if (state.cardEditorMode !== 'create') {
            previousSchemaVersion = dom.cardSchemaVersion?.value || previousSchemaVersion;
            return;
        }

        const confirmed = await requestCardEditorConfirmation({
            message: 'Switching schema may change how some fields are interpreted. Continue?',
            confirmLabel: '✅ Switch',
            cancelLabel: '↩️ Keep current',
        });
        if (!confirmed) {
            if (dom.cardSchemaVersion) {
                dom.cardSchemaVersion.value = previousSchemaVersion;
            }
            return;
        }

        previousSchemaVersion = dom.cardSchemaVersion?.value || previousSchemaVersion;
    });

    initFolderFilters(loadFileMetadata);
    initLicensesModal();
    initSettingsModal();
    initAssistantUI();
    initResizableLayout();
    initKeyboardNavigation(selectFileInList, loadFileMetadata, () => deleteSelectedFile(loadFileMetadata));

    initDragDrop(loadFileMetadata, {
        onDirectoryDropped: openDirectoryPath,
        onCardEditorImageDrop: async (file, sourcePath) => {
            if (sourcePath && getExtension(sourcePath) === 'json') {
                await handleCreateModeJsonPathDrop(sourcePath);
                return;
            }

            if (file && getExtension(file.name || '') === 'json') {
                try {
                    const jsonText = await file.text();
                    await importJsonText(jsonText);
                } catch {
                    setStatus('JSON import failed for dropped file.');
                }
                return;
            }

            if (sourcePath && getExtension(sourcePath) === 'png') {
                await importPngCardIntoCreateMode(sourcePath);
                return;
            }

            if (sourcePath) {
                await importImagePathIntoCreateMode(sourcePath);
                return;
            }

            const imageLoaded = await setCreateImageFromFile(file);
            if (!imageLoaded) {
                return;
            }
        },
    });
    initEmbeddedJsonUI({
        onReloadSelectedFile: reloadSelectedFile,
    });
    initCardEditor({
        onReloadSelectedFile: reloadSelectedFile,
        onReloadDirectory: async () => {
            if (!state.currentDirectory) {
                return;
            }
            await loadDirectory(state.currentDirectory, loadFileMetadata);
        },
        onLoadFileMetadata: loadFileMetadata,
    });
    setCreateNewCardHandler(async () => {
        if (state.cardEditorMode !== 'create') {
            await startCreateCardMode();
        }
    });

    window.addEventListener('charbrowser:metadata-edited', async () => {
        await reloadSelectedFile();
    });

    document.addEventListener('keydown', async (event) => {
        const key = (event.key || '').toLowerCase();

        if (key === 'escape' && dom.surpriseOverlay?.classList.contains('is-visible')) {
            event.preventDefault();
            hideSurpriseOverlay();
            return;
        }

        trackSurpriseSequence(event);

        if (event.ctrlKey && key === 's') {
            if (state.cardEditorMode !== 'create' && !state.selectedFile) {
                return;
            }
            event.preventDefault();
            dom.cardSaveBtn?.click();
        }

        if ((event.ctrlKey || event.metaKey) && key === 'v') {
            if (state.cardEditorMode !== 'create' || isTextEditingContext()) {
                return;
            }

            event.preventDefault();
            try {
                const text = await navigator.clipboard.readText();
                await importJsonText(text);
            } catch {
                setStatus('Paste failed: clipboard text is unavailable.');
            }
        }

        if (key === 'escape' && state.cardEditorMode === 'create') {
            if (isAssistantPanelOpen()) {
                return;
            }
            event.preventDefault();
            dom.cardCancelCreateBtn?.click();
        }
    });
}
