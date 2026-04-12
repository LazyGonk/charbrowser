import { dom } from '../dom.js';
import { state } from '../state.js';
import { loadTextEntriesData } from '../services/metadata-service.js';

/**
 * Loads plaintext metadata entries (PNG text chunks) and updates viewer state.
 * @param {string} filePath
 * @param {string} ext
 */
export async function loadTextEntries(filePath, ext) {
    if (dom.textEntriesSection) {
        dom.textEntriesSection.style.display = 'none';
    }
    if (dom.textEntriesSelect) {
        dom.textEntriesSelect.innerHTML = '';
    }
    if (dom.textEntriesContent) {
        dom.textEntriesContent.textContent = '';
    }
    if (dom.textEntriesStatus) {
        dom.textEntriesStatus.textContent = '';
    }

    state.textEntries = [];

    if (ext !== 'png') {
        return;
    }

    try {
        const entries = await loadTextEntriesData(filePath);
        if (state.selectedFile !== filePath) {
            return;
        }

        if (!entries || entries.length === 0) {
            if (dom.textEntriesStatus) {
                dom.textEntriesStatus.textContent = 'No plaintext entries found.';
            }
            return;
        }

        state.textEntries = entries;

        // Hide plaintext section if embedded JSON exists - avoid redundant display
        if (state.embeddedJsonEntries && state.embeddedJsonEntries.length > 0) {
            if (dom.textEntriesStatus) {
                dom.textEntriesStatus.textContent = '';
            }
            return;
        }

        if (dom.textEntriesSection) {
            dom.textEntriesSection.style.display = 'flex';
        }

        renderTextEntries();
    } catch (error) {
        if (dom.textEntriesStatus) {
            dom.textEntriesStatus.textContent = `Error reading text entries: ${String(error)}`;
        }
    }
}

/**
 * Renders plaintext entry selector and selected content.
 */
export function renderTextEntries() {
    if (!dom.textEntriesSelect || !dom.textEntriesContent || !state.textEntries) {
        return;
    }

    dom.textEntriesSelect.innerHTML = '';

    for (const entry of state.textEntries) {
        const option = document.createElement('option');
        option.value = String(entry.id);
        option.textContent = `${entry.label} [${entry.chunk_type}]`;
        dom.textEntriesSelect.appendChild(option);
    }

    dom.textEntriesSelect.onchange = () => {
        const entryId = Number(dom.textEntriesSelect.value);
        const entry = state.textEntries.find((e) => e.id === entryId);
        if (entry && dom.textEntriesContent) {
            dom.textEntriesContent.textContent = entry.text;
        }
    };

    if (state.textEntries.length > 0) {
        dom.textEntriesSelect.value = String(state.textEntries[0].id);
        dom.textEntriesSelect.onchange();
    }
}
