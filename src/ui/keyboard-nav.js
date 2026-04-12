import { dom } from '../dom.js';
import { state } from '../state.js';
import { confirmCardEditorExit } from './card-editor.js';

/**
 * Checks if focused element is an editable context where arrow keys should not navigate files.
 * @returns {boolean}
 */
export function isTextEditingContext() {
    const active = document.activeElement;
    if (!active) {
        return false;
    }

    if (active === dom.embeddedJsonTextFilter) {
        return true;
    }

    if (active.isContentEditable) {
        return true;
    }

    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Selects next/previous file by offset and loads metadata.
 * @param {number} offset
 * @param {(filePath: string) => void} selectFileInList
 * @param {(filePath: string) => Promise<void>} onFileSelected
 */
export async function selectFileByOffset(offset, selectFileInList, onFileSelected) {
    if (!Array.isArray(state.currentFiles) || state.currentFiles.length === 0) {
        return;
    }

    let index = state.currentFiles.indexOf(state.selectedFile);
    if (index === -1) {
        index = offset > 0 ? -1 : 0;
    }

    const nextIndex = Math.min(state.currentFiles.length - 1, Math.max(0, index + offset));
    const nextFile = state.currentFiles[nextIndex];
    if (!nextFile || nextFile === state.selectedFile) {
        return;
    }

    // Delegate to onFileSelected (loadFileMetadata) which handles unsaved check and loading
    // Then update highlight after successful load
    await onFileSelected(nextFile);
    selectFileInList(nextFile);
    dom.fileList.focus();
}

/**
 * Initializes global arrow-key file navigation.
 * @param {(filePath: string) => void} selectFileInList
 * @param {(filePath: string) => Promise<void>} onFileSelected
 * @param {() => Promise<void>} onDeleteSelected - Callback for delete key / backspace
 */
export function initKeyboardNavigation(selectFileInList, onFileSelected, onDeleteSelected) {
    document.addEventListener('keydown', (event) => {
        if (dom.jsonDiffModal?.style.display === 'flex') {
            return;
        }

        if (isTextEditingContext()) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectFileByOffset(1, selectFileInList, onFileSelected);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectFileByOffset(-1, selectFileInList, onFileSelected);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            if (typeof onDeleteSelected === 'function') {
                onDeleteSelected();
            }
        }
    });
}
