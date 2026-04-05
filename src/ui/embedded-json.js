import { VIDEO_EXTS } from '../constants.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import { updateEmbeddedBase64Json } from '../services/tauri-api.js';
import { loadEmbeddedJsonEntries } from '../services/metadata-service.js';
import {
    buildJsonDiffSummary,
    formatJsonValue,
    normalizeJsonText,
} from '../utils/json-utils.js';
import { extractNarrativeFieldsFromEntries } from '../utils/metadata-utils.js';

let currentEditableJson = null;
let reloadSelectedFile = async () => {};

/**
 * Registers embedded JSON UI event handlers.
 * @param {{onReloadSelectedFile: () => Promise<void>}} options
 */
export function initEmbeddedJsonUI(options) {
    reloadSelectedFile = options?.onReloadSelectedFile || reloadSelectedFile;

    dom.embeddedJsonSelect?.addEventListener('change', () => {
        renderEmbeddedJsonEntry(dom.embeddedJsonSelect.value);
        dom.embeddedJsonStatus.textContent = '';
    });

    dom.embeddedJsonFormatFilter?.addEventListener('change', () => {
        applyEmbeddedJsonFilters();
    });

    dom.embeddedJsonTextFilter?.addEventListener('input', () => {
        applyEmbeddedJsonFilters();
    });

    dom.saveEmbeddedJsonBtn?.addEventListener('click', async () => {
        if (!state.selectedFile || state.embeddedJsonEntries.length === 0) {
            return;
        }

        const entryId = Number(dom.embeddedJsonSelect.value);
        const jsonObj = getJsonFromTree();
        dom.embeddedJsonStatus.textContent = '';

        if (!jsonObj) {
            dom.embeddedJsonStatus.textContent = 'Cannot save: invalid JSON in tree view.';
            return;
        }

        const jsonText = JSON.stringify(jsonObj, null, 2);

        try {
            const entry = state.embeddedJsonEntries.find((item) => item.id === entryId);
            if (!entry) {
                dom.embeddedJsonStatus.textContent = 'Selected entry not found.';
                return;
            }

            const prettyOriginal = normalizeJsonText(entry.decoded_json);
            const prettyEdited = jsonText;
            const summary = buildJsonDiffSummary(prettyOriginal, prettyEdited);

            state.pendingEmbeddedJsonSave = {
                filePath: state.selectedFile,
                entryId,
                jsonText: prettyEdited,
            };

            dom.jsonDiffOriginal.textContent = prettyOriginal;
            dom.jsonDiffEdited.textContent = prettyEdited;
            dom.jsonDiffSummary.textContent = summary;
            dom.jsonDiffModal.style.display = 'flex';
        } catch (error) {
            dom.embeddedJsonStatus.textContent = `Diff preparation failed: ${String(error)}`;
        }
    });

    dom.confirmJsonSaveBtn?.addEventListener('click', async () => {
        if (!state.pendingEmbeddedJsonSave) {
            dom.jsonDiffModal.style.display = 'none';
            return;
        }

        const payload = state.pendingEmbeddedJsonSave;
        state.pendingEmbeddedJsonSave = null;
        dom.jsonDiffModal.style.display = 'none';

        try {
            await updateEmbeddedBase64Json(payload);
            dom.embeddedJsonStatus.textContent = 'Saved successfully.';
            await reloadSelectedFile();
        } catch (error) {
            dom.embeddedJsonStatus.textContent = `Save failed: ${String(error)}`;
        }
    });

    dom.cancelJsonSaveBtn?.addEventListener('click', () => {
        state.pendingEmbeddedJsonSave = null;
        dom.jsonDiffModal.style.display = 'none';
        dom.embeddedJsonStatus.textContent = 'Save canceled.';
    });
}

/**
 * Loads and displays embedded JSON entries for selected file.
 * @param {string} filePath
 * @param {string} ext
 */
export async function loadEmbeddedBase64Json(filePath, ext) {
    state.embeddedJsonEntries = [];
    state.filteredEmbeddedJsonEntries = [];
    dom.embeddedJsonSection.style.display = 'none';
    dom.embeddedJsonSelect.innerHTML = '';
    dom.embeddedJsonPayloadLabel.textContent = 'Payload';
    dom.embeddedJsonPayloadPreview.textContent = '';
    dom.embeddedJsonTree.innerHTML = '';
    currentEditableJson = null;
    dom.embeddedJsonStatus.textContent = '';
    dom.embeddedJsonFormatFilter.value = 'all';
    dom.embeddedJsonTextFilter.value = '';
    updateCharacterTextPanel(null, null);

    if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg' && ext !== 'gif' && ext !== 'bmp' && ext !== 'webp' && ext !== 'mp3' && ext !== 'flac' && !VIDEO_EXTS.has(ext)) {
        return;
    }

    try {
        const entries = await loadEmbeddedJsonEntries(filePath);
        if (state.selectedFile !== filePath) {
            return;
        }

        if (!entries || entries.length === 0) {
            dom.embeddedJsonSection.style.display = 'none';
            return;
        }

        state.embeddedJsonEntries = entries;
        const narrative = extractNarrativeFieldsFromEntries(entries);
        updateCharacterTextPanel(narrative.description, narrative.firstMes);
        dom.embeddedJsonSection.style.display = 'flex';
        applyEmbeddedJsonFilters();
    } catch (_error) {
        dom.embeddedJsonSection.style.display = 'none';
    }
}

/**
 * Applies format/text filters to embedded JSON entry list.
 */
export function applyEmbeddedJsonFilters() {
    const formatFilter = dom.embeddedJsonFormatFilter.value || 'all';
    const textFilter = (dom.embeddedJsonTextFilter.value || '').trim().toLowerCase();

    state.filteredEmbeddedJsonEntries = state.embeddedJsonEntries.filter((entry) => {
        if (formatFilter !== 'all' && (entry.payload_format || 'base64') !== formatFilter) {
            return false;
        }

        if (!textFilter) {
            return true;
        }

        const haystack = `${entry.chunk_type} ${entry.label}`.toLowerCase();
        return haystack.includes(textFilter);
    });

    const previouslySelected = Number(dom.embeddedJsonSelect.value);
    dom.embeddedJsonSelect.innerHTML = '';

    for (const entry of state.filteredEmbeddedJsonEntries) {
        const option = document.createElement('option');
        option.value = String(entry.id);
        option.textContent = `${entry.chunk_type} - ${entry.label} [${entry.payload_format || 'base64'}]`;
        dom.embeddedJsonSelect.appendChild(option);
    }

    if (state.filteredEmbeddedJsonEntries.length === 0) {
        dom.embeddedJsonPayloadLabel.textContent = 'Payload';
        dom.embeddedJsonPayloadPreview.textContent = '';
        dom.embeddedJsonTree.innerHTML = '';
        currentEditableJson = null;
        dom.embeddedJsonStatus.textContent = 'No embedded JSON entries match the current filters.';
        return;
    }

    const selectedStillVisible = state.filteredEmbeddedJsonEntries.some((e) => e.id === previouslySelected);
    const selectedId = selectedStillVisible ? previouslySelected : state.filteredEmbeddedJsonEntries[0].id;
    dom.embeddedJsonSelect.value = String(selectedId);
    renderEmbeddedJsonEntry(selectedId);
    dom.embeddedJsonStatus.textContent = '';
}

/**
 * Renders selected embedded entry as payload preview and editable JSON tree.
 * @param {number|string} entryIdRaw
 */
export function renderEmbeddedJsonEntry(entryIdRaw) {
    const entryId = Number(entryIdRaw);
    const entry = state.embeddedJsonEntries.find((item) => item.id === entryId);
    if (!entry) {
        dom.embeddedJsonPayloadPreview.textContent = '';
        dom.embeddedJsonTree.innerHTML = '';
        currentEditableJson = null;
        return;
    }

    const payloadText = entry.payload ?? entry.base64;
    dom.embeddedJsonPayloadPreview.textContent = payloadText.slice(0, 200) + (payloadText.length > 200 ? '...' : '');
    dom.embeddedJsonPayloadLabel.textContent = `Payload (${entry.payload_format || 'base64'}) - ${payloadText.length} chars`;

    try {
        currentEditableJson = JSON.parse(entry.decoded_json);
        dom.embeddedJsonTree.innerHTML = '';
        const treeNode = buildJsonTreeNode(currentEditableJson, null);
        dom.embeddedJsonTree.appendChild(treeNode);
    } catch (e) {
        dom.embeddedJsonTree.innerHTML = `<div style=\"color: #ff6b6b;\">Invalid JSON: ${e.message}</div>`;
        currentEditableJson = null;
    }
}

/**
 * Builds one node for the JSON tree editor UI.
 * @param {any} value
 * @param {string|number|null} key
 * @returns {HTMLDivElement}
 */
export function buildJsonTreeNode(value, key) {
    const node = document.createElement('div');
    node.className = 'json-tree-node';

    const row = document.createElement('div');
    row.className = 'json-tree-row';

    if (key !== null) {
        const toggle = document.createElement('span');
        toggle.className = 'json-tree-toggle';

        const keySpan = document.createElement('span');
        keySpan.className = 'json-tree-key';
        keySpan.textContent = typeof key === 'number' ? `[${key}]` : `\"${key}\"`;

        const colon = document.createElement('span');
        colon.className = 'json-tree-colon';
        colon.textContent = ': ';

        if (value !== null && typeof value === 'object') {
            const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
            toggle.textContent = isEmpty ? (Array.isArray(value) ? '[]' : '{}') : '▼';
            toggle.addEventListener('click', () => {
                const children = node.querySelector(':scope > .json-tree-children');
                if (children) {
                    children.classList.toggle('expanded');
                    toggle.textContent = children.classList.contains('expanded') ? '▼' : '▶';
                }
            });
            row.appendChild(toggle);
            row.appendChild(keySpan);
            row.appendChild(colon);

            const valueSpan = document.createElement('span');
            valueSpan.className = `json-tree-value ${Array.isArray(value) ? 'array' : 'object'}`;
            valueSpan.textContent = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
            row.appendChild(valueSpan);
        } else {
            toggle.textContent = ' ';
            row.appendChild(toggle);
            row.appendChild(keySpan);
            row.appendChild(colon);

            const valueSpan = document.createElement('span');
            const isEditable = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
            valueSpan.className = `json-tree-value ${typeof value}`;
            if (isEditable) {
                valueSpan.classList.add('editable');
                valueSpan.contentEditable = 'true';
                valueSpan.textContent = formatJsonValue(value);
                valueSpan.spellcheck = false;

                valueSpan.addEventListener('blur', () => syncTreeToJson(node, key, valueSpan));
                valueSpan.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        valueSpan.blur();
                    }
                    if (e.key === 'Escape') {
                        valueSpan.textContent = formatJsonValue(value);
                        valueSpan.blur();
                    }
                });
            } else if (value === null) {
                valueSpan.textContent = 'null';
            }
            row.appendChild(valueSpan);
        }
    }

    node.appendChild(row);

    if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
        const children = document.createElement('div');
        children.className = 'json-tree-children expanded';

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                children.appendChild(buildJsonTreeNode(item, index));
            });
        } else {
            Object.entries(value).forEach(([k, v]) => {
                children.appendChild(buildJsonTreeNode(v, k));
            });
        }

        const lastRow = children.lastElementChild;
        if (lastRow) {
            const comma = document.createElement('span');
            comma.className = 'json-tree-comma';
            comma.textContent = ',';
            lastRow.querySelector('.json-tree-row')?.appendChild(comma);
        }

        node.appendChild(children);
    }

    return node;
}

/**
 * Syncs edited scalar tree value back into in-memory JSON object.
 * @param {HTMLElement} node
 * @param {string|number} key
 * @param {HTMLElement} valueSpan
 */
export function syncTreeToJson(node, key, valueSpan) {
    if (!currentEditableJson) return;

    try {
        let parsedValue = valueSpan.textContent;
        if (parsedValue === 'null') {
            parsedValue = null;
        } else if (parsedValue === 'true') {
            parsedValue = true;
        } else if (parsedValue === 'false') {
            parsedValue = false;
        } else if (!isNaN(parsedValue) && parsedValue.trim() !== '') {
            parsedValue = Number(parsedValue);
        }

        setNestedValue(currentEditableJson, node, key, parsedValue);
        valueSpan.classList.remove('error');
        dom.embeddedJsonStatus.textContent = '';
    } catch (e) {
        valueSpan.classList.add('error');
        dom.embeddedJsonStatus.textContent = `Parse error: ${e.message}`;
    }
}

/**
 * Sets nested value by deriving path from tree node ancestry.
 * @param {any} obj
 * @param {HTMLElement} node
 * @param {string|number} key
 * @param {any} value
 */
export function setNestedValue(obj, node, key, value) {
    const path = [];
    let current = node;

    while (current && current.classList.contains('json-tree-node')) {
        const row = current.querySelector(':scope > .json-tree-row');
        if (!row) break;

        const keyEl = row.querySelector('.json-tree-key');
        if (keyEl) {
            const keyText = keyEl.textContent;
            if (keyText.startsWith('[')) {
                path.unshift(parseInt(keyText.slice(1, -1), 10));
            } else {
                path.unshift(keyText.slice(1, -1));
            }
        }

        current = current.parentElement?.closest('.json-tree-node');
    }

    let target = obj;
    for (let i = 0; i < path.length - 1; i += 1) {
        target = target[path[i]];
    }
    target[path.length > 0 ? path[path.length - 1] : key] = value;
}

/**
 * Returns edited JSON object currently represented by tree UI.
 * @returns {any}
 */
export function getJsonFromTree() {
    return currentEditableJson;
}

/**
 * Updates the narrative text panel from extracted character fields.
 * @param {string|null} description
 * @param {string|null} firstMes
 */
export function updateCharacterTextPanel(description, firstMes) {
    const hasDescription = typeof description === 'string' && description.trim().length > 0;
    const hasFirstMes = typeof firstMes === 'string' && firstMes.trim().length > 0;

    if (!hasDescription && !hasFirstMes) {
        dom.characterTextPanel.style.display = 'none';
        dom.characterDescription.textContent = '';
        dom.characterFirstMes.textContent = '';
        return;
    }

    dom.characterTextPanel.style.display = 'flex';
    dom.characterDescription.textContent = hasDescription ? description.trim() : 'Not available';
    dom.characterFirstMes.textContent = hasFirstMes ? firstMes.trim() : 'Not available';
}

/**
 * Returns best embedded payload text for clipboard use.
 * @returns {string}
 */
export function getPreferredEmbeddedJsonText() {
    if (!state.embeddedJsonEntries || state.embeddedJsonEntries.length === 0) {
        return '';
    }

    const selectedId = Number(dom.embeddedJsonSelect?.value);
    const selectedEntry = state.embeddedJsonEntries.find((entry) => entry.id === selectedId);
    const entries = selectedEntry
        ? [selectedEntry, ...state.embeddedJsonEntries.filter((entry) => entry.id !== selectedId)]
        : state.embeddedJsonEntries;

    for (const entry of entries) {
        if (!entry) {
            continue;
        }

        if (typeof entry.decoded_json === 'string' && entry.decoded_json.trim().length > 0) {
            try {
                return JSON.stringify(JSON.parse(entry.decoded_json), null, 2);
            } catch {
                return entry.decoded_json;
            }
        }

        if (typeof entry.payload === 'string' && entry.payload.trim().length > 0) {
            return entry.payload;
        }
    }

    return '';
}
