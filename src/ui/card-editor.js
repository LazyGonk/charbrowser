import { dom } from '../dom.js';
import { state } from '../state.js';
import {
    appendLlmIterationResponse,
    clearLlmIterationHistory,
    createPngCharacterCard,
    getImageDataUrl,
    getLlmIterationResponses,
    pickImageFilePath,
    pickOpenJsonPath,
    pickSaveJsonPath,
    pickSavePngPath,
    readTextFile,
    saveTextFile,
    upsertPngCharacterCard,
} from '../services/tauri-api.js';
import { generateFieldWithOpenAiCompatible } from '../services/llm-service.js';
import { executeComfyWorkflow } from '../services/comfyui-service.js';
import { loadSettings, resolveLlmProvider } from '../services/settings-service.js';
import { IMAGE_PORTRAIT_PRESETS } from '../constants.js';
import { getFileName } from '../utils/file-utils.js';
import { escapeHtml } from '../utils/string-utils.js';
import { selectFileInList, updateNewCardEntryVisibility } from './folder-view.js';
import { resetPreviewStage, setPreviewFileInfo, showPreviewImageDataUrl } from './preview.js';
import { setAdditionalInfoVisibility, setFileInfoVisibility } from './metadata-panel.js';

// Temporary debug tracing is disabled by default.
const debugLog = () => {};

const DEFAULT_PORTRAIT_PRESET =
    Array.isArray(IMAGE_PORTRAIT_PRESETS) && IMAGE_PORTRAIT_PRESETS.length > 0
        ? IMAGE_PORTRAIT_PRESETS[0]
        : { width: 1000, height: 1500 };

let reloadSelectedFile = async () => {};
let reloadDirectory = async () => {};
let loadFileMetadata = async () => {};

let createImageDataUrl = '';
let originalCreateImageDataUrl = '';
let createImageLabel = 'selected-image.png';
let isPopulating = false;
let isFormDirty = false;
let isDraggingOverCreateZone = false;
let isSyncingImageTools = false;
let createImageSourceWidth = 0;
let createImageSourceHeight = 0;
let createImageAspectRatio = 1;
let selectedPortraitPreset = {
    width: DEFAULT_PORTRAIT_PRESET.width,
    height: DEFAULT_PORTRAIT_PRESET.height,
};
let activeGenerationField = '';
let isGeneratingImage = false;
let generatedImageDataUrl = '';
let llmIterationSessionId = 'card-editor-session';
let createSessionCounter = 0;
let pendingCardConfirmResolver = null;
let pendingCardConfirmOptions = null;
let lorebookEntries = [];
let lorebookNextId = 1;

/** @typedef {'name'|'description'|'first_mes'|'creator_notes'|'scenario'|'tags'|'visual_desc'} CardGenerationField */
/** @typedef {{id: number, name: string, keys: string, content: string, meta: Record<string, any>}} LorebookEntry */

/**
 * Scrolls to a confirmation bar and briefly highlights it to draw attention.
 * @param {HTMLElement | null} element
 */
function focusConfirmBar(element) {
    if (!element) {
        return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.remove('confirm-flash');
    void element.offsetWidth;
    element.classList.add('confirm-flash');
}

/**
 * Shows the inline confirmation bar for card editor actions.
 * @param {{
 *   message: string,
 *   confirmLabel: string,
 *   cancelLabel: string,
 *   skipOptionLabel?: string,
 *   skipOptionChecked?: boolean,
 * }} options
 */
function showCardCloseConfirm(options) {
    if (!dom.cardCloseConfirm) {
        return;
    }

    if (dom.cardCloseConfirmMessage) {
        dom.cardCloseConfirmMessage.textContent = options.message;
    }
    if (dom.cardDiscardChangesBtn) {
        dom.cardDiscardChangesBtn.textContent = options.confirmLabel;
    }
    if (dom.cardKeepEditingBtn) {
        dom.cardKeepEditingBtn.textContent = options.cancelLabel;
    }
    if (dom.cardCloseConfirmSkipWrap && dom.cardCloseConfirmSkipCheckbox && dom.cardCloseConfirmSkipLabel) {
        const showSkipOption = typeof options.skipOptionLabel === 'string' && options.skipOptionLabel.trim().length > 0;
        dom.cardCloseConfirmSkipWrap.style.display = showSkipOption ? 'inline-flex' : 'none';
        dom.cardCloseConfirmSkipLabel.textContent = showSkipOption ? options.skipOptionLabel : 'Do not ask again';
        dom.cardCloseConfirmSkipCheckbox.checked = showSkipOption ? Boolean(options.skipOptionChecked) : false;
    }

    dom.cardCloseConfirm.style.display = 'flex';
    focusConfirmBar(dom.cardCloseConfirm);
}

/**
 * Hides the inline confirmation bar for card editor actions.
 */
function hideCardCloseConfirm() {
    if (dom.cardCloseConfirm) {
        dom.cardCloseConfirm.style.display = 'none';
    }
    if (dom.cardCloseConfirmSkipWrap && dom.cardCloseConfirmSkipCheckbox) {
        dom.cardCloseConfirmSkipWrap.style.display = 'none';
        dom.cardCloseConfirmSkipCheckbox.checked = false;
    }
}

/**
 * Resolves any pending inline card confirmation prompt.
 * @param {boolean} confirmed
 */
async function resolvePendingCardConfirm(confirmed) {
    if (!pendingCardConfirmResolver) {
        hideCardCloseConfirm();
        return;
    }

    const resolver = pendingCardConfirmResolver;
    const options = pendingCardConfirmOptions;
    pendingCardConfirmResolver = null;
    pendingCardConfirmOptions = null;
    const skipChecked = Boolean(dom.cardCloseConfirmSkipCheckbox?.checked);
    hideCardCloseConfirm();

    if (confirmed && typeof options?.onConfirm === 'function') {
        try {
            await options.onConfirm({ skipChecked });
        } catch {
            // Keep confirmation flow resilient even if post-confirm callback fails.
        }
    }

    resolver(confirmed);
}

/**
 * Presents settings-style inline confirmation for card editor actions.
 * @param {{
 *   message: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   skipOptionLabel?: string,
 *   skipOptionChecked?: boolean,
 *   onConfirm?: (context: { skipChecked: boolean }) => Promise<void> | void,
 * }} options
 * @returns {Promise<boolean>}
 */
export function requestCardEditorConfirmation(options) {
    if (pendingCardConfirmResolver) {
        return Promise.resolve(false);
    }

    pendingCardConfirmOptions = options || null;

    showCardCloseConfirm({
        message: options.message,
        confirmLabel: options.confirmLabel || '✅ Confirm',
        cancelLabel: options.cancelLabel || '✍️ Keep Editing',
        skipOptionLabel: options.skipOptionLabel,
        skipOptionChecked: options.skipOptionChecked,
    });

    return new Promise((resolve) => {
        pendingCardConfirmResolver = resolve;
    });
}

/**
 * Tracks generation history per field so regenerate uses original user input and revert restores it.
 * @type {Record<CardGenerationField, {original: string, generated: string, hasGenerated: boolean}>}
 */
let generationHistory = {
    name: { original: '', generated: '', hasGenerated: false },
    description: { original: '', generated: '', hasGenerated: false },
    first_mes: { original: '', generated: '', hasGenerated: false },
    creator_notes: { original: '', generated: '', hasGenerated: false },
    scenario: { original: '', generated: '', hasGenerated: false },
    tags: { original: '', generated: '', hasGenerated: false },
    visual_desc: { original: '', generated: '', hasGenerated: false },
};

/**
 * Returns current session key for backend iterative generation memory.
 * @returns {string}
 */
function getLlmIterationSessionId() {
    return llmIterationSessionId;
}

/**
 * Updates backend iteration session key from current editor context.
 */
function refreshLlmIterationSessionId() {
    if (state.cardEditorMode === 'create') {
        llmIterationSessionId = `create:${createSessionCounter}`;
        return;
    }

    if (state.selectedFile) {
        llmIterationSessionId = `file:${state.selectedFile}`;
        return;
    }

    llmIterationSessionId = 'card-editor-session';
}

const GENERATION_FIELD_CONFIG = {
    name: {
        button: () => dom.cardGenerateNameBtn,
        regenerateButton: () => dom.cardRegenerateNameBtn,
        revertButton: () => dom.cardRevertNameBtn,
        getValue: () => String(dom.cardNameInput?.value || ''),
        setValue: (value) => {
            if (dom.cardNameInput) dom.cardNameInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateName',
        promptPrefix: 'Generate a concise, memorable character name suitable for a character card.',
    },
    description: {
        button: () => dom.cardGenerateDescriptionBtn,
        regenerateButton: () => dom.cardRegenerateDescriptionBtn,
        revertButton: () => dom.cardRevertDescriptionBtn,
        getValue: () => String(dom.cardDescriptionInput?.value || ''),
        setValue: (value) => {
            if (dom.cardDescriptionInput) dom.cardDescriptionInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateDescription',
        promptPrefix: 'Write a high-quality character description with personality, style, and key traits.',
    },
    first_mes: {
        button: () => dom.cardGenerateFirstMesBtn,
        regenerateButton: () => dom.cardRegenerateFirstMesBtn,
        revertButton: () => dom.cardRevertFirstMesBtn,
        getValue: () => String(dom.cardFirstMesInput?.value || ''),
        setValue: (value) => {
            if (dom.cardFirstMesInput) dom.cardFirstMesInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateFirstMes',
        promptPrefix: 'Write the first in-character message that starts the conversation naturally.',
    },
    creator_notes: {
        button: () => dom.cardGenerateNotesBtn,
        regenerateButton: () => dom.cardRegenerateNotesBtn,
        revertButton: () => dom.cardRevertNotesBtn,
        getValue: () => String(dom.cardCreatorNotesInput?.value || ''),
        setValue: (value) => {
            if (dom.cardCreatorNotesInput) dom.cardCreatorNotesInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateCreatorNotes',
        promptPrefix: 'Write concise creator notes for tuning behavior and usage recommendations.',
    },
    scenario: {
        button: () => dom.cardGenerateScenarioBtn,
        regenerateButton: () => dom.cardRegenerateScenarioBtn,
        revertButton: () => dom.cardRevertScenarioBtn,
        getValue: () => String(dom.cardScenarioInput?.value || ''),
        setValue: (value) => {
            if (dom.cardScenarioInput) dom.cardScenarioInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateScenario',
        promptPrefix: 'Write a compact scenario/context for this character interaction.',
    },
    tags: {
        button: () => dom.cardGenerateTagsBtn,
        regenerateButton: () => dom.cardRegenerateTagsBtn,
        revertButton: () => dom.cardRevertTagsBtn,
        getValue: () => String(dom.cardTagsInput?.value || ''),
        setValue: (value) => {
            if (dom.cardTagsInput) dom.cardTagsInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateTags',
        promptPrefix: 'Generate a comma-separated list of short descriptive tags (no explanation).',
    },
    visual_desc: {
        button: () => dom.cardGenerateVisualDescBtn,
        regenerateButton: () => null,
        revertButton: () => null,
        getValue: () => String(dom.cardVisualDescriptionInput?.value || ''),
        setValue: (value) => {
            if (dom.cardVisualDescriptionInput) dom.cardVisualDescriptionInput.value = value;
        },
        settingsTemplateKey: 'promptTemplateVisualDesc',
        promptPrefix: 'Extract visual and environment details for image generation from the available character context.',
    },
};

/**
 * Resets all generation history entries and hides associated action buttons.
 */
function resetGenerationHistory() {
    generationHistory = {
        name: { original: '', generated: '', hasGenerated: false },
        description: { original: '', generated: '', hasGenerated: false },
        first_mes: { original: '', generated: '', hasGenerated: false },
        creator_notes: { original: '', generated: '', hasGenerated: false },
        scenario: { original: '', generated: '', hasGenerated: false },
        tags: { original: '', generated: '', hasGenerated: false },
        visual_desc: { original: '', generated: '', hasGenerated: false },
    };

    for (const field of Object.keys(GENERATION_FIELD_CONFIG)) {
        setGenerationActionVisibility(/** @type {CardGenerationField} */ (field), false);
    }
}

/**
 * Shows or hides regenerate/revert controls for one field.
 * @param {CardGenerationField} field
 * @param {boolean} visible
 */
function setGenerationActionVisibility(field, visible) {
    const config = GENERATION_FIELD_CONFIG[field];
    const regenerateButton = config?.regenerateButton?.();
    const revertButton = config?.revertButton?.();

    if (regenerateButton) {
        regenerateButton.style.display = visible ? 'inline-block' : 'none';
    }
    if (revertButton) {
        revertButton.style.display = visible ? 'inline-block' : 'none';
    }
}

/**
 * Enables or disables all AI generation buttons based on active LLM settings.
 */
function updateGenerationButtonAvailability() {
    const settings = loadSettings();
    const isConfigured = Boolean(settings.llmEndpoint && settings.llmModel);

    for (const [field, config] of Object.entries(GENERATION_FIELD_CONFIG)) {
        const button = config.button();
        if (!button) {
            continue;
        }

        button.disabled = !isConfigured || Boolean(activeGenerationField);
        button.title = isConfigured
            ? 'Generate with AI'
            : 'Configure LLM endpoint and model in Settings first';

        const regenerateButton = config.regenerateButton?.();
        if (regenerateButton) {
            regenerateButton.disabled = !isConfigured || Boolean(activeGenerationField) || !generationHistory[/** @type {CardGenerationField} */ (field)].hasGenerated;
        }

        const revertButton = config.revertButton?.();
        if (revertButton) {
            revertButton.disabled = !generationHistory[/** @type {CardGenerationField} */ (field)].hasGenerated;
        }
    }

    if (dom.cardGenerateAllBtn) {
        dom.cardGenerateAllBtn.disabled = !isConfigured || Boolean(activeGenerationField);
    }

    if (dom.lorebookGenerateAllBtn) {
        const schemaVersion = dom.cardSchemaVersion?.value || '2.0';
        const isSupportedSchema = schemaVersion === '2.0' || schemaVersion === '3.0';
        dom.lorebookGenerateAllBtn.disabled = !isConfigured || Boolean(activeGenerationField) || !isSupportedSchema;
    }
}

/**
 * Returns normalized comma-separated key text from arbitrary character-book key input.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLorebookKeys(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter((item) => item.length > 0)
            .join(', ');
    }

    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(', ');
}

/**
 * Returns true for metadata values that should be shown in advanced field editors.
 * @param {unknown} value
 * @returns {boolean}
 */
function isVisibleLorebookMetaValue(value) {
    if (value == null) {
        return false;
    }
    if (typeof value === 'string') {
        return value.trim().length > 0;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === 'object') {
        return Object.keys(value).length > 0;
    }
    return true;
}

/**
 * Produces a readable label for one advanced metadata key.
 * @param {string} key
 * @returns {string}
 */
function formatLorebookMetaLabel(key) {
    return key
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Converts one unknown character-book entry shape into internal editor state.
 * @param {any} entry
 * @param {number} fallbackId
 * @returns {LorebookEntry | null}
 */
function toLorebookEntry(entry, fallbackId) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const name = String(entry.comment || entry.name || entry.memo || '').trim();
    const keys = normalizeLorebookKeys(entry.keys || entry.key || entry.keysecondary || entry.secondary_keys || '');
    const content = String(entry.content || entry.text || '').trim();

    const meta = {};
    for (const [key, value] of Object.entries(entry)) {
        if (key === 'content' || key === 'text') {
            continue;
        }
        if (key === 'keys' || key === 'key') {
            continue;
        }
        if (key === 'comment' || key === 'memo') {
            continue;
        }
        meta[key] = value;
    }

    if (!Object.prototype.hasOwnProperty.call(meta, 'id')) {
        meta.id = Number.isFinite(Number(fallbackId)) ? Number(fallbackId) : null;
    }

    return {
        id: lorebookNextId++,
        name,
        keys,
        content,
        meta,
    };
}

/**
 * Extracts character-book entries from common v2/v3 and legacy payload locations.
 * @param {any} card
 * @returns {LorebookEntry[]}
 */
function extractLorebookEntriesFromCard(card) {
    const raw = Array.isArray(card?.character_book?.entries)
        ? card.character_book.entries
        : (card?.character_book?.entries && typeof card.character_book.entries === 'object')
            ? Object.values(card.character_book.entries)
            : Array.isArray(card?.character_book)
                ? card.character_book
                : (card?.character_book && typeof card.character_book === 'object' && !Array.isArray(card.character_book))
                    ? Object.values(card.character_book)
                    : Array.isArray(card?.persona?.lorebook)
                        ? card.persona.lorebook
                        : Array.isArray(card?.lorebook)
                            ? card.lorebook
                            : [];

    debugLog('extractLorebookEntriesFromCard: raw count =', raw.length, 'raw:', raw);
    
    const result = [];
    for (let index = 0; index < raw.length; index += 1) {
        const mapped = toLorebookEntry(raw[index], index);
        if (mapped) {
            result.push(mapped);
            debugLog('  Entry', index, '-> mapped id:', mapped.id, 'name:', mapped.name);
        }
    }
    debugLog('extractLorebookEntriesFromCard: result count =', result.length);
    return result;
}

/**
 * Updates character-book count badge text.
 */
function updateLorebookCount() {
    if (dom.lorebookCount) {
        const count = lorebookEntries.length;
        dom.lorebookCount.textContent = `(${count} entr${count === 1 ? 'y' : 'ies'})`;
    }
}

/**
 * Shows character-book controls for v2/v3 and disables them for v1.
 */
function syncLorebookSchemaState() {
    const schemaVersion = dom.cardSchemaVersion?.value || '2.0';
    const isSupportedSchema = schemaVersion === '2.0' || schemaVersion === '3.0';
    if (dom.cardLorebookSection) {
        dom.cardLorebookSection.classList.toggle('is-disabled', !isSupportedSchema);
        const controls = dom.cardLorebookSection.querySelectorAll('input, textarea, button');
        for (const control of controls) {
            if (!(control instanceof HTMLInputElement)
                && !(control instanceof HTMLTextAreaElement)
                && !(control instanceof HTMLButtonElement)) {
                continue;
            }
            control.disabled = !isSupportedSchema;
        }
    }
    if (dom.lorebookSchemaHint) {
        dom.lorebookSchemaHint.textContent = isSupportedSchema
            ? 'Character Book entries are included in card JSON when saving schema v2/v3.'
            : 'Switch schema to v2 or v3 to edit Character Book entries.';
    }
    if (dom.lorebookAddEntryBtn) {
        dom.lorebookAddEntryBtn.disabled = !isSupportedSchema;
    }
    if (dom.lorebookImportBtn) {
        dom.lorebookImportBtn.disabled = !isSupportedSchema;
    }
    if (dom.lorebookExportBtn) {
        dom.lorebookExportBtn.disabled = !isSupportedSchema;
    }
    updateGenerationButtonAvailability();
}

/**
 * Renders all lorebook entries into the card editor list container.
 */
function renderLorebookEntries() {
    debugLog('renderLorebookEntries: starting, count =', lorebookEntries.length);
    if (!dom.lorebookEntries) {
        debugLog('renderLorebookEntries: dom.lorebookEntries not found');
        return;
    }

    dom.lorebookEntries.innerHTML = '';
    
    for (const entry of lorebookEntries) {
        try {
            const meta = (entry.meta && typeof entry.meta === 'object') ? entry.meta : {};
            const displayId = Number.isFinite(Number(meta.id)) ? Number(meta.id) : entry.id;
            
            const row = document.createElement('div');
            row.className = 'lorebook-entry';
            row.dataset.entryId = String(entry.id);
            
            const contentPreview = String(entry.content || '')
                .slice(0, 60)
                .replace(/\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            const keysDisplay = String(entry.keys || '').split(',').map((k) => k.trim()).filter((k) => k).slice(0, 2).join(', ');
            
            const summaryText = [
                entry.name ? `"${String(entry.name).slice(0, 20)}"` : '(untitled)',
                keysDisplay ? `[${keysDisplay}${String(entry.keys || '').split(',').length > 2 ? '...' : ''}]` : '[no keys]',
                contentPreview ? `"${contentPreview}${String(entry.content || '').length > 60 ? '…' : ''}"` : '(empty)',
            ].join(' • ');
            const escapedSummaryText = escapeHtml(summaryText);
            const escapedName = escapeHtml(String(entry.name || ''));
            const escapedKeys = escapeHtml(String(entry.keys || ''));
            const escapedContent = escapeHtml(String(entry.content || ''));
            
            const getManyFieldsHtml = () => {
                const advanced = [];
                for (const [metaKey, metaValue] of Object.entries(meta)) {
                    if (metaKey === 'extensions' || !isVisibleLorebookMetaValue(metaValue)) {
                        continue;
                    }

                    const escapedMetaKey = escapeHtml(metaKey);
                    const escapedMetaLabel = escapeHtml(formatLorebookMetaLabel(metaKey));
                    
                    if (typeof metaValue === 'boolean') {
                        advanced.push(`
                            <label class="meta-field-bool">
                                <input type="checkbox" data-meta-key="${escapedMetaKey}" data-meta-type="boolean"${metaValue ? ' checked' : ''} />
                                <span>${escapedMetaLabel}</span>
                            </label>
                        `);
                    } else if (typeof metaValue === 'number') {
                        advanced.push(`
                            <div class="meta-field">
                                <label>${escapedMetaLabel}</label>
                                <input type="number" class="embedded-json-text-filter" data-meta-key="${escapedMetaKey}" data-meta-type="number" value="${metaValue}" />
                            </div>
                        `);
                    } else if (Array.isArray(metaValue)) {
                        advanced.push(`
                            <div class="meta-field">
                                <label>${escapedMetaLabel}</label>
                                <input type="text" class="embedded-json-text-filter" data-meta-key="${escapedMetaKey}" data-meta-type="array" value="${escapeHtml(metaValue.join(', '))}" />
                            </div>
                        `);
                    } else if (metaValue && typeof metaValue === 'object') {
                        advanced.push(`
                            <div class="meta-field">
                                <label>${escapedMetaLabel}</label>
                                <textarea class="json-editor lorebook-entry-meta-object" data-meta-key="${escapedMetaKey}" data-meta-type="object" rows="4">${escapeHtml(JSON.stringify(metaValue, null, 2))}</textarea>
                            </div>
                        `);
                    } else {
                        advanced.push(`
                            <div class="meta-field">
                                <label>${escapedMetaLabel}</label>
                                <input type="text" class="embedded-json-text-filter" data-meta-key="${escapedMetaKey}" data-meta-type="string" value="${escapeHtml(String(metaValue || ''))}" />
                            </div>
                        `);
                    }
                }
                return advanced.join('');
            };
            
            const hasExtensions = Object.prototype.hasOwnProperty.call(meta, 'extensions');
            
            row.innerHTML = `
                <div class="lorebook-entry-main">
                    <div class="lorebook-entry-id-badge">ID ${displayId}</div>
                    <div class="lorebook-entry-summary-line">${escapedSummaryText}</div>
                    <button class="btn btn-secondary btn-small lorebook-entry-delete" data-action="delete" type="button" title="Delete entry">🗑️</button>
                </div>
                
                <details class="lorebook-entry-details">
                    <summary>Edit</summary>
                    
                    <div class="lorebook-entry-editor">
                        <div class="lorebook-field">
                            <label>Comment/Title</label>
                            <input type="text" class="embedded-json-text-filter lorebook-entry-name" data-role="name" placeholder="Optional comment" value="${escapedName}" />
                        </div>
                        
                        <div class="lorebook-field">
                            <label>Keys (comma-separated)</label>
                            <input type="text" class="embedded-json-text-filter lorebook-entry-keys" data-role="keys" placeholder="keyword1, keyword2" value="${escapedKeys}" />
                        </div>
                        
                        <div class="lorebook-field">
                            <label>Content</label>
                            <textarea class="json-editor lorebook-entry-content" data-role="content" placeholder="Entry content..." rows="5">${escapedContent}</textarea>
                        </div>
                        
                        <div class="lorebook-entry-actions">
                            <button class="btn btn-secondary btn-small lorebook-entry-refine" data-action="refine" type="button" title="Refine with AI">🤖 Refine</button>
                        </div>
                        
                        ${getManyFieldsHtml() || '<div class="lorebook-no-advanced">No additional fields</div>'}
                        
                        ${hasExtensions ? `
                            <details class="lorebook-entry-extensions-wrap">
                                <summary>Extensions (JSON)</summary>
                                <textarea class="json-editor lorebook-entry-extensions" data-meta-key="extensions" data-meta-type="object" rows="6">${escapeHtml(JSON.stringify(meta.extensions, null, 2))}</textarea>
                            </details>
                        ` : ''}
                    </div>
                </details>
            `;
            
            dom.lorebookEntries.appendChild(row);
            debugLog('  Entry rendered: id=' + displayId + ', name=' + (entry.name ? '"' + entry.name.slice(0, 20) + '"' : '(untitled)'));
        } catch (error) {
            debugLog('Error rendering lorebook entry:', error, entry);
        }
    }

    if (lorebookEntries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'lorebook-empty';
        empty.textContent = 'No Character Book entries yet. Add one manually or generate entries with AI.';
        dom.lorebookEntries.appendChild(empty);
        debugLog('renderLorebookEntries: rendered empty state');
    }

    updateLorebookCount();
    syncLorebookSchemaState();
    debugLog('renderLorebookEntries: complete');
}

/**
 * Appends one empty character-book entry and focuses it for quick manual input.
 */
function addLorebookEntry() {
    const nextMetaId = lorebookEntries.length > 0
        ? Math.max(...lorebookEntries.map((item) => Number(item?.meta?.id)).filter((value) => Number.isFinite(value))) + 1
        : 0;

    lorebookEntries.push({
        id: lorebookNextId++,
        name: '',
        keys: '',
        content: '',
        meta: {
            id: Number.isFinite(nextMetaId) ? nextMetaId : 0,
            enabled: true,
            constant: false,
            selective: false,
            use_regex: false,
            case_sensitive: false,
            insertion_order: null,
            position: 'after_char',
            priority: null,
            secondary_keys: [],
            extensions: {},
        },
    });
    renderLorebookEntries();
    isFormDirty = true;

    const newest = dom.lorebookEntries?.querySelector('.lorebook-entry:last-child .lorebook-entry-name');
    if (newest instanceof HTMLElement) {
        newest.focus();
    }
}

/**
 * Synchronizes one character-book entry object from rendered DOM inputs.
 * @param {number} entryId
 */
function syncLorebookEntryFromDom(entryId) {
    const entry = lorebookEntries.find((item) => item.id === entryId);
    const row = dom.lorebookEntries?.querySelector(`.lorebook-entry[data-entry-id="${entryId}"]`);
    if (!entry || !(row instanceof HTMLElement)) {
        return;
    }

    const name = row.querySelector('[data-role="name"]');
    const keys = row.querySelector('[data-role="keys"]');
    const content = row.querySelector('[data-role="content"]');

    entry.name = String(/** @type {HTMLInputElement | null} */ (name)?.value || '').trim();
    entry.keys = normalizeLorebookKeys(String(/** @type {HTMLInputElement | null} */ (keys)?.value || ''));
    entry.content = String(/** @type {HTMLTextAreaElement | null} */ (content)?.value || '').trim();

    const nextMeta = {
        ...(entry.meta && typeof entry.meta === 'object' ? entry.meta : {}),
    };

    const metaFields = row.querySelectorAll('[data-meta-key]');
    for (const field of metaFields) {
        if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
            continue;
        }

        const metaKey = String(field.getAttribute('data-meta-key') || '').trim();
        const metaType = String(field.getAttribute('data-meta-type') || 'string').trim();
        if (!metaKey) {
            continue;
        }

        if (metaType === 'boolean' && field instanceof HTMLInputElement) {
            nextMeta[metaKey] = field.checked;
            continue;
        }

        if (metaType === 'number' && field instanceof HTMLInputElement) {
            const raw = field.value.trim();
            nextMeta[metaKey] = raw.length === 0 ? null : (Number.isFinite(Number(raw)) ? Number(raw) : null);
            continue;
        }

        if (metaType === 'array' && field instanceof HTMLInputElement) {
            nextMeta[metaKey] = field.value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
            continue;
        }

        if (metaType === 'object' && field instanceof HTMLTextAreaElement) {
            const raw = field.value.trim();
            if (!raw) {
                nextMeta[metaKey] = {};
                continue;
            }

            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    nextMeta[metaKey] = parsed;
                }
            } catch {
                // Keep previous value if JSON is invalid while typing.
            }
            continue;
        }

        const raw = field.value;
        nextMeta[metaKey] = raw;
    }

    entry.meta = nextMeta;
}

/**
 * Removes one character-book entry by internal id and refreshes the list.
 * @param {number} entryId
 */
function deleteLorebookEntry(entryId) {
    lorebookEntries = lorebookEntries.filter((entry) => entry.id !== entryId);
    renderLorebookEntries();
    isFormDirty = true;
}

/**
 * Generates content for one card field and writes the model response into the form.
 * @param {CardGenerationField} targetField
 * @param {{regenerate?: boolean, quietStatus?: boolean}} [options]
 */
async function generateCardField(targetField, options = {}) {
    if (activeGenerationField) {
        return;
    }

    const config = GENERATION_FIELD_CONFIG[targetField];
    const button = config?.button?.();
    if (!config || !button) {
        return;
    }

    const settings = loadSettings();
    if (!settings.llmEndpoint || !settings.llmModel) {
        setStatus('Configure LLM endpoint and model in Settings before generating fields.');
        return;
    }

    const isRegenerate = Boolean(options.regenerate);
    const currentValue = String(config.getValue?.() || '').trim();
    if (!generationHistory[targetField].hasGenerated) {
        generationHistory[targetField].original = currentValue;
    }

    activeGenerationField = targetField;
    button.classList.add('loading');
    const previousLabel = button.textContent;
    button.textContent = '⏳';
    if (!options.quietStatus) {
        setStatus(`${isRegenerate ? 'Regenerating' : 'Generating'} ${targetField.replace('_', ' ')}...`);
    }

    updateGenerationButtonAvailability();

    try {
        const formData = readFormData();
        let previousResponses = [];
        try {
            previousResponses = await getLlmIterationResponses({
                sessionId: getLlmIterationSessionId(),
                targetField,
                limit: 8,
            });
        } catch {
            previousResponses = [];
        }

        const value = await generateFieldWithOpenAiCompatible({
            endpoint: settings.llmEndpoint,
            apiKey: settings.llmApiKey,
            apiType: resolveLlmProvider(settings),
            model: settings.llmModel,
            temperature: settings.llmTemperature,
            maxTokens: settings.llmMaxTokens,
            systemPrompt: settings.llmSystemPrompt,
            targetField,
            fieldPromptPrefix: config.promptPrefix,
            fieldPromptTemplate: settings[config.settingsTemplateKey] || '',
            userInputOverride: isRegenerate
                ? generationHistory[targetField].original
                : currentValue,
            previousResponses,
            formData,
        });

        config.setValue(value);
        generationHistory[targetField].generated = value;
        generationHistory[targetField].hasGenerated = true;
        setGenerationActionVisibility(targetField, true);

        try {
            await appendLlmIterationResponse({
                sessionId: getLlmIterationSessionId(),
                targetField,
                responseText: value,
            });
        } catch {
            // Keep generation resilient if history persistence fails.
        }

        isFormDirty = true;
        if (!options.quietStatus) {
            setStatus(`${isRegenerate ? 'Regenerated' : 'Generated'} ${targetField.replace('_', ' ')}.`);
        }
    } catch (error) {
        if (!options.quietStatus) {
            setStatus(`AI generation failed: ${String(error)}`);
        }
    } finally {
        activeGenerationField = '';
        button.classList.remove('loading');
        button.textContent = previousLabel;
        updateGenerationButtonAvailability();
    }
}

/**
 * Reverts one field back to the value captured before the first generation.
 * @param {CardGenerationField} targetField
 */
function revertGeneratedField(targetField) {
    const config = GENERATION_FIELD_CONFIG[targetField];
    if (!config || !generationHistory[targetField].hasGenerated) {
        return;
    }

    config.setValue(generationHistory[targetField].original || '');
    generationHistory[targetField] = { original: '', generated: '', hasGenerated: false };
    setGenerationActionVisibility(targetField, false);
    isFormDirty = true;
    setStatus(`Reverted ${targetField.replace('_', ' ')}.`);
}

/**
 * Generates all currently empty fields in sequence using the per-field logic.
 */
async function generateAllEmptyFields() {
    if (activeGenerationField) {
        return;
    }

    const orderedFields = /** @type {CardGenerationField[]} */ (['name', 'description', 'first_mes', 'creator_notes', 'scenario', 'tags', 'visual_desc']);
    const targets = orderedFields.filter((field) => {
        const config = GENERATION_FIELD_CONFIG[field];
        return config && !String(config.getValue?.() || '').trim();
    });

    if (targets.length === 0) {
        setStatus('All fields already contain values.');
        return;
    }

    let completed = 0;
    for (const field of targets) {
        setStatus(`Generate All: ${completed + 1}/${targets.length} (${field.replace('_', ' ')})`);
        await generateCardField(field, { quietStatus: true });
        completed += 1;
    }

    setStatus(`Generate All finished: ${completed}/${targets.length} field${targets.length === 1 ? '' : 's'} processed.`);
}

/**
 * Builds compact character-book entry input text for refine prompts.
 * @param {LorebookEntry} entry
 * @returns {string}
 */
function formatLorebookEntryForPrompt(entry) {
    return JSON.stringify({ name: entry.name, keys: entry.keys, content: entry.content }, null, 2);
}

/**
 * Extracts likely JSON payload text candidates from raw LLM output.
 * Supports direct JSON, markdown code fences, and free text wrapping.
 * @param {string} text
 * @returns {string[]}
 */
function extractJsonCandidatesFromText(text) {
    const candidates = [];
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        return candidates;
    }

    candidates.push(trimmed);

    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(trimmed)) !== null) {
        const fenced = String(fenceMatch[1] || '').trim();
        if (fenced) {
            candidates.push(fenced);
        }
    }

    const firstArray = trimmed.indexOf('[');
    const lastArray = trimmed.lastIndexOf(']');
    if (firstArray >= 0 && lastArray > firstArray) {
        candidates.push(trimmed.slice(firstArray, lastArray + 1).trim());
    }

    const firstObject = trimmed.indexOf('{');
    const lastObject = trimmed.lastIndexOf('}');
    if (firstObject >= 0 && lastObject > firstObject) {
        candidates.push(trimmed.slice(firstObject, lastObject + 1).trim());
    }

    return [...new Set(candidates.filter((item) => item.length > 0))];
}

/**
 * Resolves possible entry-array containers from parsed JSON payloads.
 * @param {any} parsed
 * @returns {any[]}
 */
function resolveLorebookEntryCandidates(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (!parsed || typeof parsed !== 'object') {
        return [];
    }

    if (Array.isArray(parsed.entries)) {
        return parsed.entries;
    }

    if (Array.isArray(parsed?.character_book?.entries)) {
        return parsed.character_book.entries;
    }

    if (Array.isArray(parsed?.data?.character_book?.entries)) {
        return parsed.data.character_book.entries;
    }

    const preferredArrayKeys = ['desires', 'lorebook', 'character_books', 'items', 'results'];
    for (const key of preferredArrayKeys) {
        if (Array.isArray(parsed[key])) {
            return parsed[key];
        }
    }

    const objectValues = Object.values(parsed);
    if (objectValues.length === 1 && Array.isArray(objectValues[0])) {
        return objectValues[0];
    }

    return [parsed];
}

/**
 * Extracts complete top-level JSON object literals from an array-like text payload.
 * This tolerates truncated array output by returning only objects with balanced braces.
 * @param {string} text
 * @returns {string[]}
 */
function extractCompleteObjectsFromArrayText(text) {
    const input = String(text || '');
    const objects = [];

    let inString = false;
    let escaped = false;
    let depth = 0;
    let objectStart = -1;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (ch === '{') {
            if (depth === 0) {
                objectStart = i;
            }
            depth += 1;
            continue;
        }

        if (ch === '}') {
            if (depth > 0) {
                depth -= 1;
                if (depth === 0 && objectStart >= 0) {
                    const objectText = input.slice(objectStart, i + 1).trim();
                    if (objectText.length > 0) {
                        objects.push(objectText);
                    }
                    objectStart = -1;
                }
            }
        }
    }

    return objects;
}

/**
 * Attempts to recover character-book entries from truncated JSON array output.
 * @param {string} text
 * @returns {LorebookEntry[]}
 */
function recoverLorebookEntriesFromTruncatedJson(text) {
    const recovered = [];
    const arrayLike = String(text || '').trim();
    if (!arrayLike.includes('[') || !arrayLike.includes('{')) {
        return recovered;
    }

    const objectSnippets = extractCompleteObjectsFromArrayText(arrayLike);
    for (const snippet of objectSnippets) {
        try {
            const parsed = JSON.parse(snippet);
            const mapped = toLorebookEntry(parsed);
            if (!mapped) {
                continue;
            }
            if (!mapped.name && !mapped.keys && !mapped.content) {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(mapped.meta, 'extensions')) {
                mapped.meta.extensions = {};
            }
            recovered.push(mapped);
        } catch {
            // Ignore malformed object snippets and continue recovery.
        }
    }

    return recovered;
}

/**
 * Parses character-book generation output from JSON or KEYS/CONTENT fallback format.
 * @param {string} rawText
 * @returns {LorebookEntry[]}
 */
function parseLorebookEntriesFromLlm(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        return [];
    }

    const result = [];

    for (const candidateText of extractJsonCandidatesFromText(text)) {
        try {
            const parsed = JSON.parse(candidateText);
            if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
                const wrappedContent = parsed.choices[0]?.message?.content;
                if (typeof wrappedContent === 'string' && wrappedContent.trim().length > 0) {
                    const wrappedEntries = parseLorebookEntriesFromLlm(wrappedContent);
                    if (wrappedEntries.length > 0) {
                        return wrappedEntries;
                    }
                }
            }

            const entries = resolveLorebookEntryCandidates(parsed);

            for (const item of entries) {
                const mapped = toLorebookEntry(item);
                if (!mapped) {
                    continue;
                }

                if (!mapped.name && !mapped.keys && !mapped.content) {
                    continue;
                }

                if (!Object.prototype.hasOwnProperty.call(mapped.meta, 'extensions')) {
                    mapped.meta.extensions = {};
                }
                result.push(mapped);
            }
            if (result.length > 0) {
                return result;
            }
        } catch {
            // Try next candidate.
        }
    }

    for (const candidateText of extractJsonCandidatesFromText(text)) {
        const recovered = recoverLorebookEntriesFromTruncatedJson(candidateText);
        if (recovered.length > 0) {
            return recovered;
        }
    }

    const chunks = text.split(/\n\s*\n+/);
    for (const chunk of chunks) {
        const keysMatch = chunk.match(/(?:^|\n)\s*KEYS\s*:\s*([^\n]+)/i);
        const contentMatch = chunk.match(/(?:^|\n)\s*CONTENT\s*:\s*([\s\S]+)/i);
        const nameMatch = chunk.match(/(?:^|\n)\s*(?:NAME|TITLE)\s*:\s*([^\n]+)/i);
        if (!keysMatch && !contentMatch) {
            continue;
        }

        const mapped = toLorebookEntry({
            name: nameMatch?.[1] || '',
            keys: keysMatch?.[1] || '',
            content: contentMatch?.[1] || '',
        });
        if (mapped) {
            if (!Object.prototype.hasOwnProperty.call(mapped.meta, 'extensions')) {
                mapped.meta.extensions = {};
            }
            result.push(mapped);
        }
    }

    return result;
}

/**
 * Builds a normalized deduplication signature for one character-book entry.
 * @param {LorebookEntry} entry
 * @returns {string}
 */
function buildLorebookEntrySignature(entry) {
    const name = String(entry?.name || '').trim().toLowerCase();
    const content = String(entry?.content || '').trim().toLowerCase();
    const keys = normalizeLorebookKeys(entry?.keys || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0)
        .sort()
        .join('|');
    return `${name}::${keys}::${content}`;
}

/**
 * Uses configured LLM settings to generate multiple character-book entries from current form context.
 */
async function generateLorebookEntries() {
    if (activeGenerationField) {
        return;
    }

    const settings = loadSettings();
    if (!settings.llmEndpoint || !settings.llmModel) {
        setStatus('Configure LLM endpoint and model in Settings before generating Character Book entries.');
        return;
    }

    const schemaVersion = dom.cardSchemaVersion?.value || '2.0';
    if (schemaVersion !== '2.0' && schemaVersion !== '3.0') {
        setStatus('Character Book generation is available only for schema v2/v3.');
        return;
    }

    activeGenerationField = 'lorebook_generate';
    if (dom.lorebookGenerateAllBtn) {
        dom.lorebookGenerateAllBtn.textContent = '⏳ Generating...';
    }
    updateGenerationButtonAvailability();

    try {
        const formData = readFormData();
        const existingEntriesContext = JSON.stringify(
            lorebookEntries.map((entry) => ({
                name: entry.name,
                keys: entry.keys,
                content: entry.content,
            })),
            null,
            2,
        );
        const result = await generateFieldWithOpenAiCompatible({
            endpoint: settings.llmEndpoint,
            apiKey: settings.llmApiKey,
            apiType: resolveLlmProvider(settings),
            model: settings.llmModel,
            temperature: settings.llmTemperature,
            maxTokens: settings.llmMaxTokens,
            systemPrompt: settings.llmSystemPrompt,
            targetField: 'character_book_generate',
            fieldPromptPrefix: 'Generate character-book entries. Return ONLY raw JSON (no markdown fences, no explanation) as an array of objects with keys: name, keys, content.',
            fieldPromptTemplate: settings.promptTemplateCharacterBookGenerate || settings.promptTemplateLorebookGenerate || '',
            userInputOverride: `Existing entries are read-only. Return only NEW entries that do not duplicate existing ones.\n\nExisting entries:\n${existingEntriesContext}`,
            formData,
        });

        const parsedEntries = parseLorebookEntriesFromLlm(result);
        if (parsedEntries.length === 0) {
            setStatus('Character Book generation returned no valid entries.');
            return;
        }

        const seen = new Set(lorebookEntries.map((entry) => buildLorebookEntrySignature(entry)));
        const newEntries = [];
        for (const candidate of parsedEntries) {
            const signature = buildLorebookEntrySignature(candidate);
            if (seen.has(signature)) {
                continue;
            }
            seen.add(signature);
            if (!Object.prototype.hasOwnProperty.call(candidate.meta, 'extensions')) {
                candidate.meta.extensions = {};
            }
            lorebookEntries.push(candidate);
            newEntries.push(candidate);
        }

        if (newEntries.length === 0) {
            setStatus('Character Book generation returned only duplicates. No entries were added.');
            return;
        }

        renderLorebookEntries();
        isFormDirty = true;
        setStatus(`Generated ${newEntries.length} new Character Book entr${newEntries.length === 1 ? 'y' : 'ies'}.`);
    } catch (error) {
        setStatus(`Character Book generation failed: ${String(error)}`);
    } finally {
        activeGenerationField = '';
        if (dom.lorebookGenerateAllBtn) {
            dom.lorebookGenerateAllBtn.textContent = '✨ Generate Character Books';
        }
        updateGenerationButtonAvailability();
    }
}

/**
 * Refines one character-book entry in place using the configured LLM.
 * @param {number} entryId
 */
async function refineLorebookEntry(entryId) {
    if (activeGenerationField) {
        return;
    }

    const entry = lorebookEntries.find((item) => item.id === entryId);
    if (!entry) {
        return;
    }

    const settings = loadSettings();
    if (!settings.llmEndpoint || !settings.llmModel) {
        setStatus('Configure LLM endpoint and model in Settings before refining Character Book entries.');
        return;
    }

    activeGenerationField = 'character_book_refine';
    const refineBtn = dom.lorebookEntries?.querySelector(`.lorebook-entry[data-entry-id="${entryId}"] [data-action="refine"]`);
    if (refineBtn instanceof HTMLButtonElement) {
        refineBtn.disabled = true;
        refineBtn.textContent = '⏳';
    }
    updateGenerationButtonAvailability();

    try {
        const formData = readFormData();
        const result = await generateFieldWithOpenAiCompatible({
            endpoint: settings.llmEndpoint,
            apiKey: settings.llmApiKey,
            apiType: resolveLlmProvider(settings),
            model: settings.llmModel,
            temperature: settings.llmTemperature,
            maxTokens: settings.llmMaxTokens,
            systemPrompt: settings.llmSystemPrompt,
            targetField: 'character_book_refine',
            fieldPromptPrefix: 'Refine one character-book entry. Return ONLY raw JSON (no markdown fences, no explanation) as one object with keys: name, keys, content.',
            fieldPromptTemplate: settings.promptTemplateCharacterBookRefine || settings.promptTemplateLorebookRefine || '',
            userInputOverride: formatLorebookEntryForPrompt(entry),
            formData,
        });

        const parsed = parseLorebookEntriesFromLlm(result);
        if (parsed.length === 0) {
            setStatus('Character Book refine returned no valid entry.');
            return;
        }

        entry.name = parsed[0].name;
        entry.keys = parsed[0].keys;
        entry.content = parsed[0].content;
        renderLorebookEntries();
        isFormDirty = true;
        setStatus('Character Book entry refined.');
    } catch (error) {
        setStatus(`Character Book refine failed: ${String(error)}`);
    } finally {
        activeGenerationField = '';
        if (refineBtn instanceof HTMLButtonElement && refineBtn.isConnected) {
            refineBtn.disabled = false;
            refineBtn.textContent = '🤖 Refine';
        }
        updateGenerationButtonAvailability();
    }
}

/**
 * Imports character-book entries from a selected JSON file and appends them to current entries.
 */
async function importLorebookEntries() {
    const schemaVersion = dom.cardSchemaVersion?.value || '2.0';
    if (schemaVersion !== '2.0' && schemaVersion !== '3.0') {
        setStatus('Character Book import is available only for schema v2/v3.');
        return;
    }

    const filePath = await pickOpenJsonPath();
    if (!filePath) {
        setStatus('Character Book import canceled.');
        return;
    }

    try {
        const jsonText = await readTextFile(filePath);
        const parsed = JSON.parse(jsonText);
        const entries = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.character_book?.entries)
                ? parsed.character_book.entries
            : Array.isArray(parsed?.entries)
                ? parsed.entries
                : [];

        const mappedEntries = [];
        for (const item of entries) {
            const mapped = toLorebookEntry(item);
            if (mapped) {
                mappedEntries.push(mapped);
            }
        }

        if (mappedEntries.length === 0) {
            setStatus('Character Book import failed: no valid entries found.');
            return;
        }

        lorebookEntries = [...lorebookEntries, ...mappedEntries];
        renderLorebookEntries();
        isFormDirty = true;
        setStatus(`Imported ${mappedEntries.length} Character Book entr${mappedEntries.length === 1 ? 'y' : 'ies'}.`);
    } catch (error) {
        setStatus(`Character Book import failed: ${String(error)}`);
    }
}

/**
 * Exports current character-book entries to a JSON file using simple editor format.
 */
async function exportLorebookEntries() {
    const schemaVersion = dom.cardSchemaVersion?.value || '2.0';
    if (schemaVersion !== '2.0' && schemaVersion !== '3.0') {
        setStatus('Character Book export is available only for schema v2/v3.');
        return;
    }

    const exportPayload = lorebookEntries.map((entry) => ({
        name: entry.name,
        keys: entry.keys,
        content: entry.content,
    }));
    const targetPath = await pickSaveJsonPath(`${sanitizeFilename(dom.cardNameInput?.value || 'character-card')}_character_book.json`);
    if (!targetPath) {
        setStatus('Character Book export canceled.');
        return;
    }

    try {
        await saveTextFile(targetPath, JSON.stringify(exportPayload, null, 2));
        setStatus(`Character Book exported: ${getFileName(targetPath) || targetPath}`);
    } catch (error) {
        setStatus(`Character Book export failed: ${String(error)}`);
    }
}

/**
 * Loads one image element from a PNG data URL for client-side transforms.
 * This keeps resize/crop operations local to the editor without backend round-trips.
 * @param {string} imageDataUrl
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(imageDataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();

        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Unsupported image payload.'));
        image.src = imageDataUrl;
    });
}

/**
 * Returns true when the given payload is already a PNG data URL.
 * @param {string} imageDataUrl
 * @returns {boolean}
 */
function isPngDataUrl(imageDataUrl) {
    return /^data:image\/png(?:;base64)?,/i.test(String(imageDataUrl || ''));
}

/**
 * Normalizes any supported image data URL into PNG so backend save is consistent.
 * @param {string} imageDataUrl
 * @returns {Promise<string>}
 */
async function normalizeImageDataUrlToPng(imageDataUrl) {
    if (isPngDataUrl(imageDataUrl)) {
        return imageDataUrl;
    }

    const image = await loadImageElement(imageDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Canvas 2D context unavailable');
    }

    ctx.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
}

/**
 * Updates image tool controls from the current working image payload.
 * The original import dimensions are preserved so users can reset destructive edits.
 * @param {string} imageDataUrl
 * @param {{resetOriginal?: boolean}} [options]
 */
async function syncImageToolState(imageDataUrl, options = {}) {
    if (!dom.cardImageToolsPanel || !imageDataUrl) {
        return;
    }

    try {
        isSyncingImageTools = true;
        const image = await loadImageElement(imageDataUrl);
        createImageAspectRatio = image.naturalWidth / Math.max(image.naturalHeight, 1);

        if (options.resetOriginal || !originalCreateImageDataUrl) {
            originalCreateImageDataUrl = imageDataUrl;
            createImageSourceWidth = image.naturalWidth;
            createImageSourceHeight = image.naturalHeight;
        }

        if (dom.cardImageToolsMeta) {
            dom.cardImageToolsMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
        }
        dom.cardImageToolsPanel.style.display = state.cardEditorMode === 'create' ? 'block' : 'none';
    } catch {
        if (dom.cardImageToolsMeta) {
            dom.cardImageToolsMeta.textContent = 'Image tools unavailable';
        }
    } finally {
        isSyncingImageTools = false;
    }
}

/**
 * Resets image tool state when leaving create mode or discarding the imported image.
 */
function resetImageToolState() {
    originalCreateImageDataUrl = '';
    createImageLabel = 'selected-image.png';
    createImageSourceWidth = 0;
    createImageSourceHeight = 0;
    createImageAspectRatio = 1;
    selectedPortraitPreset = {
        width: DEFAULT_PORTRAIT_PRESET.width,
        height: DEFAULT_PORTRAIT_PRESET.height,
    };
    isSyncingImageTools = false;

    if (dom.cardImageToolsPanel) {
        dom.cardImageToolsPanel.style.display = 'none';
    }
    if (dom.cardImageToolsMeta) {
        dom.cardImageToolsMeta.textContent = 'No image selected';
    }
    if (dom.cardImageFitMode) {
        dom.cardImageFitMode.value = 'contain';
    }

    updatePortraitPresetSelectionUI();
}

/**
 * Updates portrait preset button visual state.
 */
function updatePortraitPresetSelectionUI() {
    const activeKey = `${selectedPortraitPreset.width}x${selectedPortraitPreset.height}`;
    const presets = [
        { button: dom.cardPreset1000x1500Btn, key: '1000x1500' },
        { button: dom.cardPreset800x1200Btn, key: '800x1200' },
        { button: dom.cardPreset400x600Btn, key: '400x600' },
    ];

    for (const preset of presets) {
        if (!preset.button) {
            continue;
        }
        const isActive = preset.key === activeKey;
        preset.button.classList.toggle('is-active', isActive);
        preset.button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
}

/**
 * Applies a portrait 2:3 preset to the current image tool target.
 * @param {number} width
 * @param {number} height
 */
function applyPortraitPreset(width, height) {
    selectedPortraitPreset = {
        width,
        height,
    };
    updatePortraitPresetSelectionUI();
}

/**
 * Applies the current resize/crop controls to the working create-mode image.
 * The transform stays entirely client-side and updates the preview immediately.
 */
async function applyImageToolsTransform() {
    if (!createImageDataUrl) {
        setStatus('Select an image before applying resize tools.');
        return;
    }
    if (!dom.cardImageFitMode) {
        return;
    }

    const targetWidth = Math.max(32, Math.round(Number(selectedPortraitPreset.width) || DEFAULT_PORTRAIT_PRESET.width));
    const targetHeight = Math.max(32, Math.round(Number(selectedPortraitPreset.height) || DEFAULT_PORTRAIT_PRESET.height));
    const fitMode = dom.cardImageFitMode.value || 'contain';

    try {
        const image = await loadImageElement(createImageDataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context unavailable');
        }

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = image.naturalWidth;
        let sourceHeight = image.naturalHeight;

        if (fitMode === 'cover') {
            const targetAspectRatio = targetWidth / Math.max(targetHeight, 1);
            const sourceAspectRatio = image.naturalWidth / Math.max(image.naturalHeight, 1);

            if (sourceAspectRatio > targetAspectRatio) {
                sourceWidth = Math.round(image.naturalHeight * targetAspectRatio);
                sourceX = Math.round((image.naturalWidth - sourceWidth) / 2);
            } else if (sourceAspectRatio < targetAspectRatio) {
                sourceHeight = Math.round(image.naturalWidth / targetAspectRatio);
                sourceY = Math.round((image.naturalHeight - sourceHeight) / 2);
            }
        }

        ctx.drawImage(
            image,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            targetWidth,
            targetHeight,
        );

        createImageDataUrl = canvas.toDataURL('image/png');
        isFormDirty = true;
        showPreviewImageDataUrl(createImageDataUrl);
        setPreviewFileInfo(createImageLabel);
        await syncImageToolState(createImageDataUrl, { resetOriginal: false });
        setStatus(`Image updated: ${targetWidth} × ${targetHeight}${fitMode === 'cover' ? ' (center crop)' : ''}`);
    } catch (error) {
        setStatus(`Image transform failed: ${String(error)}`);
    }
}

/**
 * Restores the create-mode image to the original imported payload.
 */
async function resetImageToolsToOriginal() {
    if (!originalCreateImageDataUrl) {
        setStatus('No original image state available.');
        return;
    }

    createImageDataUrl = originalCreateImageDataUrl;
    isFormDirty = true;
    showPreviewImageDataUrl(createImageDataUrl);
    setPreviewFileInfo(createImageLabel);
    await syncImageToolState(createImageDataUrl, { resetOriginal: false });
    applyPortraitPreset(DEFAULT_PORTRAIT_PRESET.width, DEFAULT_PORTRAIT_PRESET.height);
    setStatus('Image reset to original import.');
}

/**
 * Applies image data URL to create-mode state and preview.
 * @param {string} imageDataUrl
 * @param {string} displayName
 * @param {{resetOriginal?: boolean}} [options]
 */
function applyCreateImageDataUrl(imageDataUrl, displayName, options = {}) {
    createImageDataUrl = imageDataUrl;
    createImageLabel = displayName || 'selected-image.png';
    isFormDirty = true;
    if (dom.noPreview) {
        dom.noPreview.style.display = 'none';
    }
    showPreviewImageDataUrl(imageDataUrl);
    setPreviewFileInfo(createImageLabel);
    void syncImageToolState(imageDataUrl, { resetOriginal: options.resetOriginal !== false });
    setStatus(`Image selected: ${createImageLabel}`);
}

/**
 * Handles image file drop in create mode.
 * @param {File|null} file - File object from browser drag, or null if from Tauri
 * @param {string} [filePath] - File path from Tauri drag
 */
async function handleCreateModeImageDrop(file, filePath) {
    if (state.cardEditorMode !== 'create') {
        return;
    }

    if (filePath) {
        try {
            const dataUrl = await getImageDataUrl(filePath);
            const displayName = getFileName(filePath) || 'selected-image.png';
            await setCreateImageFromDataUrl(dataUrl, displayName);
        } catch (err) {
            setStatus(`Failed to load image: ${String(err)}`);
        }
        return;
    }

    if (file && isLikelyImageFile(file)) {
        await setCreateImageFromFile(file);
    }
}

/**
 * Handles JSON drop in create mode from browser file objects.
 * @param {File} file
 */
async function handleCreateModeJsonDrop(file) {
    if (!file || state.cardEditorMode !== 'create') {
        return;
    }

    try {
        const jsonText = await file.text();
        await importJsonText(jsonText);
    } catch (error) {
        setStatus(`JSON import failed: ${String(error)}`);
    }
}

/**
 * Handles JSON path drops in create mode for native drag/drop events.
 * @param {string} filePath
 */
export async function handleCreateModeJsonPathDrop(filePath) {
    if (!filePath || state.cardEditorMode !== 'create') {
        return;
    }

    try {
        const jsonText = await readTextFile(filePath);
        await importJsonText(jsonText);
    } catch (error) {
        setStatus(`JSON import failed: ${String(error)}`);
    }
}

/**
 * Returns true when browser file metadata likely represents an image.
 * @param {File|null|undefined} file
 */
function isLikelyImageFile(file) {
    if (!file) {
        return false;
    }
    if (typeof file.type === 'string' && file.type.startsWith('image/')) {
        return true;
    }
    const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    return /\.(png|jpe?g|gif|webp|bmp|tif|tiff)$/i.test(name);
}

/**
 * Returns true when browser file metadata likely represents a JSON document.
 * @param {File|null|undefined} file
 */
function isLikelyJsonFile(file) {
    if (!file) {
        return false;
    }

    if (typeof file.type === 'string' && file.type.toLowerCase() === 'application/json') {
        return true;
    }

    const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    return name.endsWith('.json');
}

/**
 * Hides all metadata sections for create mode.
 */
function hideMetadataSections() {
    if (dom.metadataContent) dom.metadataContent.style.display = 'none';
    if (dom.embeddedJsonSection) dom.embeddedJsonSection.style.display = 'none';
    if (dom.textEntriesSection) dom.textEntriesSection.style.display = 'none';
    if (dom.fileInfoHeader) dom.fileInfoHeader.style.display = 'none';
    if (dom.copyMetadataBtn) dom.copyMetadataBtn.style.display = 'none';
    setFileInfoVisibility(false);
    setAdditionalInfoVisibility(false);
}

/**
 * Shows all metadata sections for view/edit mode.
 */
function showMetadataSections() {
    if (dom.metadataContent) dom.metadataContent.style.display = '';
    if (dom.embeddedJsonSection) dom.embeddedJsonSection.style.display = '';
    if (dom.textEntriesSection) dom.textEntriesSection.style.display = '';
    if (dom.fileInfoHeader) dom.fileInfoHeader.style.display = 'none';
    if (dom.copyMetadataBtn) dom.copyMetadataBtn.style.display = 'inline-block';
    setFileInfoVisibility(false);
    setAdditionalInfoVisibility(true);
}

/**
 * Manages metadata sections when a card payload is already present.
 * Shows card-relevant metadata (embedded JSON for editing) while hiding verbose file info.
 * @param {boolean} hasCardPayload
 */
function setCardAwareMetadataVisibility(hasCardPayload) {
    if (!hasCardPayload) {
        showMetadataSections();
        return;
    }

    // Show metadata for card editing, but hide raw file-info details
    if (dom.metadataContent) dom.metadataContent.style.display = '';
    if (dom.fileInfoHeader) dom.fileInfoHeader.style.display = 'none';
    if (dom.copyMetadataBtn) dom.copyMetadataBtn.style.display = 'inline-block';
    if (dom.embeddedJsonSection) dom.embeddedJsonSection.style.display = '';  // Show embedded JSON for editing
    if (dom.textEntriesSection) dom.textEntriesSection.style.display = 'none';
    setFileInfoVisibility(false);
    setAdditionalInfoVisibility(false);
}

/**
 * Checks for unsaved changes and returns false if user cancels.
 * @returns {Promise<boolean>} True if safe to proceed, false if user cancels
 */
export async function checkUnsavedChanges() {
    if (!isFormDirty) return true;

    return requestCardEditorConfirmation({
        message: 'You have unsaved changes. Discard them?',
        confirmLabel: '🗑️ Discard',
        cancelLabel: '✍️ Keep Editing',
    });
}

/**
 * Returns true when the card editor currently contains unsaved changes.
 * This includes both create mode and PNG edit mode.
 * @returns {boolean}
 */
export function hasUnsavedCardChanges() {
    return isFormDirty;
}

/**
 * Confirms whether the current card editor state may be abandoned.
 * Use this for any navigation or app-close path that leaves the current card context.
 * @returns {Promise<boolean>}
 */
export async function confirmCardEditorExit() {
    return checkUnsavedChanges();
}

/**
 * Marks the current card editor state as clean after the user confirmed discarding changes.
 */
export function discardUnsavedCardChanges() {
    isFormDirty = false;
}

/**
 * Initializes card editor events and action callbacks.
 * @param {{
 *   onReloadSelectedFile: () => Promise<void>,
 *   onReloadDirectory: () => Promise<void>,
 *   onLoadFileMetadata: (filePath: string) => Promise<void>,
 * }} options
 */
export function initCardEditor(options) {
    reloadSelectedFile = options?.onReloadSelectedFile || reloadSelectedFile;
    reloadDirectory = options?.onReloadDirectory || reloadDirectory;
    loadFileMetadata = options?.onLoadFileMetadata || loadFileMetadata;

    dom.createCardBtn?.addEventListener('click', async () => {
        await startCreateCardMode();
    });

    dom.cardSaveBtn?.addEventListener('click', async () => {
        await saveCard();
    });

    dom.cardCancelCreateBtn?.addEventListener('click', async () => {
        const stopped = await stopCreateCardMode();
        if (stopped) {
            setStatus('Create canceled.');
        }
    });

    dom.cardDiscardChangesBtn?.addEventListener('click', () => {
        void resolvePendingCardConfirm(true);
    });

    dom.cardKeepEditingBtn?.addEventListener('click', () => {
        void resolvePendingCardConfirm(false);
    });

    dom.cardExportJsonBtn?.addEventListener('click', async () => {
        await exportCurrentCardJson();
    });

    dom.cardImportJsonBtn?.addEventListener('click', async () => {
        await importJsonFromFile();
    });

    dom.cardGenerateNameBtn?.addEventListener('click', async () => {
        await generateCardField('name');
    });
    dom.cardRegenerateNameBtn?.addEventListener('click', async () => {
        await generateCardField('name', { regenerate: true });
    });
    dom.cardRevertNameBtn?.addEventListener('click', () => {
        revertGeneratedField('name');
    });

    dom.cardGenerateDescriptionBtn?.addEventListener('click', async () => {
        await generateCardField('description');
    });
    dom.cardRegenerateDescriptionBtn?.addEventListener('click', async () => {
        await generateCardField('description', { regenerate: true });
    });
    dom.cardRevertDescriptionBtn?.addEventListener('click', () => {
        revertGeneratedField('description');
    });

    dom.cardGenerateFirstMesBtn?.addEventListener('click', async () => {
        await generateCardField('first_mes');
    });
    dom.cardRegenerateFirstMesBtn?.addEventListener('click', async () => {
        await generateCardField('first_mes', { regenerate: true });
    });
    dom.cardRevertFirstMesBtn?.addEventListener('click', () => {
        revertGeneratedField('first_mes');
    });

    dom.cardGenerateNotesBtn?.addEventListener('click', async () => {
        await generateCardField('creator_notes');
    });
    dom.cardRegenerateNotesBtn?.addEventListener('click', async () => {
        await generateCardField('creator_notes', { regenerate: true });
    });
    dom.cardRevertNotesBtn?.addEventListener('click', () => {
        revertGeneratedField('creator_notes');
    });

    dom.cardGenerateScenarioBtn?.addEventListener('click', async () => {
        await generateCardField('scenario');
    });
    dom.cardRegenerateScenarioBtn?.addEventListener('click', async () => {
        await generateCardField('scenario', { regenerate: true });
    });
    dom.cardRevertScenarioBtn?.addEventListener('click', () => {
        revertGeneratedField('scenario');
    });

    dom.cardGenerateTagsBtn?.addEventListener('click', async () => {
        await generateCardField('tags');
    });
    dom.cardRegenerateTagsBtn?.addEventListener('click', async () => {
        await generateCardField('tags', { regenerate: true });
    });
    dom.cardRevertTagsBtn?.addEventListener('click', () => {
        revertGeneratedField('tags');
    });

    dom.cardGenerateVisualDescBtn?.addEventListener('click', async () => {
        const description = String(dom.cardDescriptionInput?.value || '').trim();
        const firstMessage = String(dom.cardFirstMesInput?.value || '').trim();
        if (!description && !firstMessage) {
            setStatus('Fill in Description or First Message first to extract a visual prompt.');
            return;
        }
        await generateCardField('visual_desc');
    });

    dom.cardGenerateAllBtn?.addEventListener('click', async () => {
        await generateAllEmptyFields();
    });

    dom.cardGenerateImageBtn?.addEventListener('click', async () => {
        await generateCardImage();
    });
    dom.cardPreset1000x1500Btn?.addEventListener('click', () => {
        applyPortraitPreset(IMAGE_PORTRAIT_PRESETS[0].width, IMAGE_PORTRAIT_PRESETS[0].height);
    });

    dom.cardPreset800x1200Btn?.addEventListener('click', () => {
        applyPortraitPreset(IMAGE_PORTRAIT_PRESETS[1].width, IMAGE_PORTRAIT_PRESETS[1].height);
    });

    dom.cardPreset400x600Btn?.addEventListener('click', () => {
        applyPortraitPreset(IMAGE_PORTRAIT_PRESETS[2].width, IMAGE_PORTRAIT_PRESETS[2].height);
    });

    dom.cardApplyImageToolsBtn?.addEventListener('click', async () => {
        await applyImageToolsTransform();
    });

    dom.cardResetImageToolsBtn?.addEventListener('click', async () => {
        await resetImageToolsToOriginal();
    });

    // Create mode drop zone drag-drop handlers
    const previewStage = dom.previewStage;
    if (previewStage) {
        previewStage.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.cardEditorMode === 'create') {
                isDraggingOverCreateZone = true;
                previewStage.classList.add('drag-over');
            }
        });

        previewStage.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.cardEditorMode === 'create' && e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        previewStage.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!previewStage.contains(e.relatedTarget)) {
                isDraggingOverCreateZone = false;
                previewStage.classList.remove('drag-over');
            }
        });

        previewStage.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDraggingOverCreateZone = false;
            previewStage.classList.remove('drag-over');

            if (state.cardEditorMode !== 'create') {
                return;
            }

            const file = e.dataTransfer?.files?.[0];

            if (file && isLikelyJsonFile(file)) {
                await handleCreateModeJsonDrop(file);
                return;
            }

            if (file && isLikelyImageFile(file)) {
                await handleCreateModeImageDrop(file, null);
            }
        });
    }

    // Clicking the create-mode drop zone area opens an image file picker.
    dom.noPreview?.addEventListener('click', async () => {
        if (state.cardEditorMode !== 'create') {
            return;
        }
        try {
            const filePath = await pickImageFilePath();
            if (filePath) {
                await handleCreateModeImageDrop(null, filePath);
            }
        } catch {
            // Picker cancelled or dismissed.
        }
    });

    const trackedFieldElements = [
        { key: 'name', el: dom.cardNameInput },
        { key: 'description', el: dom.cardDescriptionInput },
        { key: 'first_mes', el: dom.cardFirstMesInput },
        { key: 'creator_notes', el: dom.cardCreatorNotesInput },
        { key: 'scenario', el: dom.cardScenarioInput },
        { key: 'tags', el: dom.cardTagsInput },
        { key: 'visual_desc', el: dom.cardVisualDescriptionInput },
    ];

    const formDirtyElements = [
        dom.cardSchemaVersion,
        dom.cardNameInput,
        dom.cardDescriptionInput,
        dom.cardFirstMesInput,
        dom.cardCreatorNotesInput,
        dom.cardScenarioInput,
        dom.cardTagsInput,
        dom.cardVisualDescriptionInput,
    ];

    for (const field of formDirtyElements) {
        field?.addEventListener('input', () => {
            if (isPopulating) {
                return;
            }

            isFormDirty = true;
            setStatus('');
        });
    }

    dom.cardSchemaVersion?.addEventListener('change', () => {
        if (isPopulating) {
            return;
        }
        syncLorebookSchemaState();
        isFormDirty = true;
    });

    for (const field of trackedFieldElements) {
        field.el?.addEventListener('input', () => {
            if (isPopulating) {
                return;
            }

            generationHistory[/** @type {CardGenerationField} */ (field.key)] = {
                original: '',
                generated: '',
                hasGenerated: false,
            };
            setGenerationActionVisibility(/** @type {CardGenerationField} */ (field.key), false);
            updateGenerationButtonAvailability();
        });
    }

    dom.lorebookAddEntryBtn?.addEventListener('click', () => {
        addLorebookEntry();
    });

    dom.lorebookGenerateAllBtn?.addEventListener('click', async () => {
        await generateLorebookEntries();
    });

    dom.lorebookImportBtn?.addEventListener('click', async () => {
        await importLorebookEntries();
    });

    dom.lorebookExportBtn?.addEventListener('click', async () => {
        await exportLorebookEntries();
    });

    dom.lorebookEntries?.addEventListener('input', (event) => {
        if (isPopulating) {
            return;
        }

        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const row = target.closest('.lorebook-entry');
        const entryId = Number(row?.getAttribute('data-entry-id'));
        if (!Number.isFinite(entryId)) {
            return;
        }

        syncLorebookEntryFromDom(entryId);
        isFormDirty = true;
    });

    dom.lorebookEntries?.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const actionElement = target.closest('[data-action]');
        if (!(actionElement instanceof HTMLElement)) {
            return;
        }

        const row = actionElement.closest('.lorebook-entry');
        const entryId = Number(row?.getAttribute('data-entry-id'));
        if (!Number.isFinite(entryId)) {
            return;
        }

        const action = String(actionElement.getAttribute('data-action') || '');
        if (action === 'delete') {
            deleteLorebookEntry(entryId);
            return;
        }

        if (action === 'refine') {
            syncLorebookEntryFromDom(entryId);
            await refineLorebookEntry(entryId);
        }
    });

    window.addEventListener('storage', (event) => {
        if (event.key && event.key.startsWith('charbrowser.settings.')) {
            updateGenerationButtonAvailability();
        }
    });

    window.addEventListener('charbrowser:settings-saved', () => {
        updateGenerationButtonAvailability();
    });

    renderLorebookEntries();
    syncLorebookSchemaState();
    updateGenerationButtonAvailability();
}

/**
 * Syncs editor UI from current file selection and embedded JSON entries.
 * @param {{filePath: string, ext: string, entries: Array<{decoded_json: string}>}} payload
 */
export function syncCardEditorFromSelection(payload) {
    const isCreateMode = state.cardEditorMode === 'create';
    if (isCreateMode) {
        return;
    }

    if (payload.ext !== 'png') {
        hideCardEditor();
        return;
    }

    debugLog('syncCardEditorFromSelection: starting, entries:', payload.entries?.length);
    const candidate = findCardPayload(payload.entries || []);
    debugLog('syncCardEditorFromSelection: candidate found:', !!candidate);

    // Only show card editor if valid card JSON is found
    if (!candidate) {
        hideCardEditor();
        setCardAwareMetadataVisibility(false);
        return;
    }

    showCardEditor('edit');
    llmIterationSessionId = `file:${payload.filePath}`;
    setCardAwareMetadataVisibility(true);
    debugLog('syncCardEditorFromSelection: calling populateFromCard');
    populateFromCard(candidate);
    setStatus('Card fields loaded from embedded JSON.');
}

/**
 * Starts create mode with an empty card form and image prompt.
 */
export async function startCreateCardMode() {
    if (!(await checkUnsavedChanges())) {
        return false;
    }

    state.cardEditorMode = 'create';
    createSessionCounter += 1;
    refreshLlmIterationSessionId();
    state.preserveEmptySelection = Boolean(state.currentDirectory);
    state.selectedFile = null;
    createImageDataUrl = '';
    isFormDirty = false;
    isGeneratingImage = false;
    generatedImageDataUrl = '';
    resetGenerationHistory();

    if (dom.dropZone) {
        dom.dropZone.style.display = 'none';
    }
    if (dom.metadataView) {
        dom.metadataView.style.display = 'flex';
    }

    // Clear preview image completely and set up create mode drop zone
    resetPreviewStage('Create mode: drag & drop an image here.');
    dom.previewStage?.classList.add('create-mode-drop-zone');
    // Enrich the placeholder with the same SVG icon + layout as the view-mode drop zone.
    if (dom.noPreview) {
        dom.noPreview.innerHTML = `<div class="drop-zone-content">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            <h2>Drop an image here</h2>
            <p class="drop-zone-hint">or click to browse for an image</p>
        </div>`;
    }
    resetImageToolState();

    // Hide character text panel and clear its content
    if (dom.characterTextPanel) {
        dom.characterTextPanel.style.display = 'none';
    }
    if (dom.characterDescription) dom.characterDescription.textContent = '';
    if (dom.characterFirstMes) dom.characterFirstMes.textContent = '';

    selectFileInList(null);
    clearFields();
    dom.cardSchemaVersion.value = '3.0';
    showCardEditor('create');
    hideMetadataSections();
    updateNewCardEntryVisibility();
    if (dom.clearSelectionBtn) {
        dom.clearSelectionBtn.style.display = 'inline-block';
    }
    setStatus('Create mode enabled. Pick an image, fill card fields, then save.');
    return true;
}

/**
 * Stops create mode and returns card editor to normal file-driven behavior.
 */
export async function stopCreateCardMode(options = {}) {
    if (!options.skipUnsavedCheck && !(await checkUnsavedChanges())) {
        return false;
    }

    resolvePendingCardConfirm(false);

    const hasFolder = Boolean(state.currentDirectory);

    state.cardEditorMode = 'view';
    void clearLlmIterationHistory(getLlmIterationSessionId());
    state.selectedFile = null;
    refreshLlmIterationSessionId();
    state.preserveEmptySelection = hasFolder;
    createImageDataUrl = '';
    isFormDirty = false;
    isGeneratingImage = false;
    generatedImageDataUrl = '';
    resetGenerationHistory();
    isDraggingOverCreateZone = false;

    // Reset generate image button to default state
    if (dom.cardGenerateImageBtn) {
        dom.cardGenerateImageBtn.disabled = true;
        dom.cardGenerateImageBtn.textContent = '🎨 Generate Image';
    }
    if (dom.cardImageGenerationProgress) {
        dom.cardImageGenerationProgress.style.display = 'none';
    }

    // Clean up create mode drop zone styling
    if (dom.previewStage) {
        dom.previewStage.classList.remove('create-mode-drop-zone');
        dom.previewStage.classList.remove('drag-over');
    }

    resetImageToolState();
    clearFields();
    selectFileInList(null);
    resetPreviewStage(hasFolder ? 'Select a file to view metadata.' : 'No preview available');

    if (dom.metadataView) {
        dom.metadataView.style.display = 'none';
    }
    if (dom.dropZone) {
        dom.dropZone.style.display = 'flex';
    }
    if (dom.dropZoneTitle) {
        dom.dropZoneTitle.textContent = hasFolder ? 'Select a file to inspect' : 'Drop a file here';
    }
    if (dom.dropZoneHint) {
        dom.dropZoneHint.textContent = hasFolder
            ? 'Choose a file from the folder list or start a new card.'
            : 'or click "Open Folder" to browse files';
    }
    hideCardEditor();
    showMetadataSections();

    updateNewCardEntryVisibility();
    if (dom.cardCancelCreateBtn) {
        dom.cardCancelCreateBtn.style.display = 'none';
    }
    return true;
}

/**
 * Sets create-mode image state from a dropped/selected file and updates preview.
 * @param {File} file
 * @returns {Promise<boolean>} True when image assignment succeeded.
 */
export async function setCreateImageFromFile(file) {
    try {
        const dataUrl = await convertImageToPngDataUrl(file);
        applyCreateImageDataUrl(dataUrl, file.name || 'selected-image.png', { resetOriginal: true });
        return true;
    } catch (error) {
        setStatus(`Image conversion failed: ${String(error)}`);
        return false;
    }
}

/**
 * Sets create-mode image state from an existing data URL payload.
 * @param {string} imageDataUrl
 * @param {string} displayName
 * @returns {boolean} True when payload accepted.
 */
export async function setCreateImageFromDataUrl(imageDataUrl, displayName) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
        setStatus('Image import failed: unsupported image payload.');
        return false;
    }

    try {
        const normalizedDataUrl = await normalizeImageDataUrlToPng(imageDataUrl);
        applyCreateImageDataUrl(normalizedDataUrl, displayName || 'selected-image.png', { resetOriginal: true });
        return true;
    } catch {
        setStatus('Image import failed: unsupported image payload.');
        return false;
    }
}

/**
 * Shows card editor in create or edit mode.
 * @param {'create'|'edit'} mode
 */
export function showCardEditor(mode) {
    if (dom.cardEditorSection) {
        dom.cardEditorSection.style.display = 'block';
    }
    updateModeBadge(mode);

    if (dom.cardCancelCreateBtn) {
        dom.cardCancelCreateBtn.style.display = mode === 'create' ? 'inline-block' : 'none';
    }
    if (dom.cardImageToolsPanel) {
        dom.cardImageToolsPanel.style.display = mode === 'create' && createImageDataUrl ? 'block' : 'none';
    }
    if (dom.cardGenerateImageBtn) {
        dom.cardGenerateImageBtn.disabled = mode !== 'create';
    }
}

/**
 * Hides card editor when current file cannot support card edits.
 */
export function hideCardEditor() {
    if (dom.cardEditorSection) {
        dom.cardEditorSection.style.display = 'none';
    }
    if (dom.cardImageToolsPanel) {
        dom.cardImageToolsPanel.style.display = 'none';
    }
    resolvePendingCardConfirm(false);
    isFormDirty = false;
    resetGenerationHistory();
}

/**
 * Generates a character image via ComfyUI using Visual Description when available.
 * Falls back to Description when the dedicated visual prompt is empty.
 * On success the generated image replaces the current create-mode image.
 * Only active in create mode; prevents double-clicks via isGeneratingImage guard.
 */
async function generateCardImage() {
    if (state.cardEditorMode !== 'create') {
        return;
    }
    if (isGeneratingImage) {
        return;
    }

    const description = (dom.cardDescriptionInput?.value || '').trim();
    const visualDescription = (dom.cardVisualDescriptionInput?.value || '').trim();
    const comfyPrompt = visualDescription || description;

    if (!comfyPrompt) {
        setStatus('Fill in Description or Visual Description first — one is required as image prompt.');
        return;
    }

    isGeneratingImage = true;

    if (dom.cardGenerateImageBtn) {
        dom.cardGenerateImageBtn.disabled = true;
        dom.cardGenerateImageBtn.textContent = 'Generating...';
    }
    if (dom.cardImageGenerationProgress) {
        dom.cardImageGenerationProgress.style.display = 'block';
    }
    if (dom.cardImageGenerationStatus) {
        dom.cardImageGenerationStatus.textContent = 'Initializing...';
    }

    const onProgress = (msg) => {
        if (dom.cardImageGenerationStatus) {
            dom.cardImageGenerationStatus.textContent = msg;
        }
    };

    try {
        const dataUrl = await executeComfyWorkflow(comfyPrompt, onProgress);
        generatedImageDataUrl = dataUrl;
        applyCreateImageDataUrl(dataUrl, 'comfyui-generated.png', { resetOriginal: true });
        setStatus(visualDescription
            ? 'Image generated successfully using Visual Description.'
            : 'Image generated successfully using Description (Visual Description was empty).');
        if (dom.cardGenerateImageBtn) {
            dom.cardGenerateImageBtn.textContent = '🎨 Regenerate Image';
        }
    } catch (error) {
        setStatus(`Image generation failed: ${String(error)}`);
    } finally {
        isGeneratingImage = false;
        if (dom.cardGenerateImageBtn) {
            dom.cardGenerateImageBtn.disabled = false;
        }
        if (dom.cardImageGenerationProgress) {
            dom.cardImageGenerationProgress.style.display = 'none';
        }
    }
}

/**
 * Saves current card editor content via create or upsert backend command.
 */
export async function saveCard() {
    const form = readFormData();
    if (!form.name || !form.description) {
        setStatus('Name and Description are required.');
        return;
    }

    const jsonText = JSON.stringify(buildCardPayload(form), null, 2);

    if (state.cardEditorMode === 'create') {
        if (!createImageDataUrl) {
            setStatus('Select an image before saving.');
            return;
        }

        const defaultName = `${sanitizeFilename(form.name)}.png`;
        const targetPath = await pickSavePngPath(defaultName);
        if (!targetPath) {
            setStatus('Save canceled.');
            return;
        }

        try {
            await createPngCharacterCard({
                filePath: targetPath,
                imageDataUrl: createImageDataUrl,
                jsonText,
            });

            isFormDirty = false;
            setStatus(`Created card: ${getFileName(targetPath) || targetPath}`);
            await stopCreateCardMode();
            await reloadDirectory();
            await loadFileMetadata(targetPath);
        } catch (error) {
            setStatus(`Create failed: ${String(error)}`);
        }
        return;
    }

    if (!state.selectedFile) {
        setStatus('No file selected for save.');
        return;
    }

    const editConfirmed = await requestCardEditorConfirmation({
        message: `Save card changes to ${getFileName(state.selectedFile) || 'selected file'}?`,
        confirmLabel: '💾 Save',
        cancelLabel: '❌ Cancel',
    });
    if (!editConfirmed) {
        setStatus('Save canceled.');
        return;
    }

    try {
        await upsertPngCharacterCard({
            filePath: state.selectedFile,
            jsonText,
        });
        isFormDirty = false;
        setStatus('Card metadata saved.');
        await reloadSelectedFile();
    } catch (error) {
        setStatus(`Save failed: ${String(error)}`);
    }
}

/**
 * Exports current form values as schema-compliant JSON file.
 */
export async function exportCurrentCardJson() {
    const form = readFormData();
    const payload = buildCardPayload(form);
    const jsonText = JSON.stringify(payload, null, 2);
    const defaultName = `${sanitizeFilename(form.name || 'character-card')}.json`;

    const targetPath = await pickSaveJsonPath(defaultName);
    if (!targetPath) {
        setStatus('Export canceled.');
        return;
    }

    try {
        await saveTextFile(targetPath, jsonText);
        setStatus(`Exported JSON: ${getFileName(targetPath) || targetPath}`);
    } catch (error) {
        setStatus(`Export failed: ${String(error)}`);
    }
}

/**
 * Imports card JSON via file picker and populates current form fields.
 */
export async function importJsonFromFile() {
    if (state.cardEditorMode !== 'create') {
        setStatus('JSON import is available only in create mode.');
        return;
    }

    const filePath = await pickOpenJsonPath();
    if (!filePath) {
        setStatus('Import canceled.');
        return;
    }

    try {
        const jsonText = await readTextFile(filePath);
        await importJsonText(jsonText);
    } catch (error) {
        setStatus(`Import failed: ${String(error)}`);
    }
}

/**
 * Imports JSON text and maps recognized character card fields into the editor.
 * @param {string} jsonText
 */
export async function importJsonText(jsonText) {
    if (state.cardEditorMode !== 'create') {
        setStatus('JSON import is available only in create mode.');
        return;
    }

    if (!jsonText || typeof jsonText !== 'string') {
        setStatus('Import failed: JSON text is empty.');
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        setStatus(`Import failed: invalid JSON (${String(error)})`);
        return;
    }

    const unwrapped = unwrapCardData(parsed);
    if (!isCardLike(unwrapped)) {
        setStatus('Import failed: JSON does not look like a supported character card schema.');
        return;
    }

    if (isFormDirty) {
        const overwriteConfirmed = await requestCardEditorConfirmation({
            message: 'This will replace existing form values. Continue?',
            confirmLabel: '✅ Replace',
            cancelLabel: '❌ Cancel',
        });
        if (!overwriteConfirmed) {
            setStatus('Import canceled.');
            return;
        }
    }

    const version = detectSchemaVersion(parsed) || '3.0';
    if (dom.cardSchemaVersion) {
        dom.cardSchemaVersion.value = version;
    }

    populateFromCard(parsed);
    isFormDirty = true;
    setStatus('Card JSON imported.');
}

/**
 * Reads card form values and returns normalized payload fields.
 * @returns {{schemaVersion: string, name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[], characterBook: Array<{name: string, keys: string, content: string, meta: Record<string, any>}>}}
 */
export function readFormData() {
    const lorebook = lorebookEntries
        .map((entry) => ({
            name: String(entry.name || '').trim(),
            keys: normalizeLorebookKeys(entry.keys),
            content: String(entry.content || '').trim(),
            meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
        }));

    return {
        schemaVersion: dom.cardSchemaVersion?.value || '2.0',
        name: (dom.cardNameInput?.value || '').trim(),
        description: (dom.cardDescriptionInput?.value || '').trim(),
        firstMes: (dom.cardFirstMesInput?.value || '').trim(),
        creatorNotes: (dom.cardCreatorNotesInput?.value || '').trim(),
        scenario: (dom.cardScenarioInput?.value || '').trim(),
        tags: (dom.cardTagsInput?.value || '')
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        characterBook: lorebook,
    };
}

/**
 * Builds a schema-specific card JSON payload from normalized form values.
 * @param {{schemaVersion: string, name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[], characterBook: Array<{name: string, keys: string, content: string, meta: Record<string, any>}>}} form
 */
export function buildCardPayload(form) {
    if (form.schemaVersion === '1.0') {
        return {
            name: form.name,
            description: form.description,
            personality: form.creatorNotes,
            scenario: form.scenario,
            first_mes: form.firstMes,
            mes_example: '',
        };
    }

    const baseData = {
        name: form.name,
        description: form.description,
        personality: '',
        scenario: form.scenario,
        first_mes: form.firstMes,
        mes_example: '',
        creator_notes: form.creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        tags: form.tags,
        creator: '',
        character_version: '',
        alternate_greetings: [],
        extensions: {},
    };

    const characterBookEntries = (form.characterBook || []).map((entry, index) => {
        const keys = normalizeLorebookKeys(entry.keys)
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
        const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};

        const normalizedMeta = {};
        for (const [metaKey, metaValue] of Object.entries(meta)) {
            if (metaKey === 'keys' || metaKey === 'key' || metaKey === 'content' || metaKey === 'text') {
                continue;
            }
            normalizedMeta[metaKey] = metaValue;
        }

        const output = {
            ...normalizedMeta,
            id: Number.isFinite(Number(normalizedMeta.id)) ? Number(normalizedMeta.id) : index,
            keys,
            content: String(entry.content || '').trim(),
            comment: String(entry.name || '').trim(),
        };

        if (typeof output.name !== 'string' || output.name.trim().length === 0) {
            output.name = String(entry.name || '').trim();
        }

        return output;
    }).filter((entry) => {
        if (Array.isArray(entry.keys) && entry.keys.length > 0) {
            return true;
        }
        if (typeof entry.content === 'string' && entry.content.trim().length > 0) {
            return true;
        }
        if (typeof entry.comment === 'string' && entry.comment.trim().length > 0) {
            return true;
        }

        return Object.entries(entry)
            .some(([key, value]) => key !== 'keys' && key !== 'content' && key !== 'comment' && isVisibleLorebookMetaValue(value));
    });

    const characterBook = characterBookEntries.length > 0
        ? {
            name: '',
            description: '',
            scan_depth: 2,
            token_budget: 512,
            recursive_scanning: false,
            extensions: {},
            entries: characterBookEntries,
        }
        : null;

    if (form.schemaVersion === '3.0') {

        const data = {
            ...baseData,
            group_only_greetings: [],
            ...(characterBook ? { character_book: characterBook } : {}),
        };
        return {
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data,
        };
    }

    const data = {
        ...baseData,
        ...(characterBook ? { character_book: characterBook } : {}),
    };
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
    };
}

/**
 * Finds first card-like JSON object from embedded entries.
 * @param {Array<{decoded_json: string}>} entries
 */
export function findCardPayload(entries) {
    let bestCandidate = null;
    let bestScore = -1;

    debugLog('findCardPayload: checking', entries.length, 'entries');

    for (const entry of entries) {
        try {
            const parsed = JSON.parse(entry.decoded_json);
            const card = unwrapCardData(parsed);
            if (!isCardLike(card)) {
                debugLog('  Entry label:', entry.label, '-> not card-like');
                continue;
            }

            let score = 0;
            const label = String(entry.label || '').toLowerCase();
            const spec = String(parsed?.spec || '').toLowerCase();
            const specVersion = String(parsed?.spec_version || '');
            const hasCharacterBookEntries = Array.isArray(card?.character_book?.entries)
                ? card.character_book.entries.length > 0
                : Boolean(card?.character_book?.entries && typeof card.character_book.entries === 'object' && Object.keys(card.character_book.entries).length > 0);

            if (hasCharacterBookEntries) {
                score += 100;
            }
            if (spec.startsWith('chara_card_v3') || specVersion.startsWith('3')) {
                score += 30;
            } else if (spec.startsWith('chara_card_v2') || specVersion.startsWith('2')) {
                score += 20;
            }
            if (label === 'ccv3') {
                score += 15;
            }
            if (label === 'chara' || label === 'character') {
                score += 10;
            }

            debugLog('  Entry label:', entry.label, '-> score:', score, 'hasCB:', hasCharacterBookEntries, 'spec:', spec);

            if (score > bestScore) {
                bestCandidate = parsed;
                bestScore = score;
                debugLog('    -> New best candidate');
            }
        } catch (err) {
            debugLog('  Entry label:', entry.label, '-> parse error:', err.message);
        }
    }

    debugLog('findCardPayload: best score =', bestScore, 'found candidate:', !!bestCandidate);
    return bestCandidate;
}

/**
 * Converts selected image file to PNG data URL for backend write pipeline.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function convertImageToPngDataUrl(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                URL.revokeObjectURL(url);
                reject(new Error('Canvas 2D context unavailable'));
                return;
            }

            ctx.drawImage(image, 0, 0);
            const pngDataUrl = canvas.toDataURL('image/png');
            URL.revokeObjectURL(url);
            resolve(pngDataUrl);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Unsupported image format'));
        };

        image.src = url;
    });
}

/**
 * Populates card editor inputs from parsed card JSON object.
 * @param {any} parsed
 */
export function populateFromCard(parsed) {
    const card = unwrapCardData(parsed);
    const schemaVersion = detectSchemaVersion(parsed) || '2.0';

    debugLog('populateFromCard: schema =', schemaVersion);
    
    isPopulating = true;
    dom.cardSchemaVersion.value = schemaVersion;
    dom.cardNameInput.value = typeof card.name === 'string' ? card.name : '';
    dom.cardDescriptionInput.value = typeof card.description === 'string'
        ? card.description
        : (typeof card.persona === 'string' ? card.persona : '');
    dom.cardFirstMesInput.value = typeof card.first_mes === 'string' ? card.first_mes : '';
    dom.cardCreatorNotesInput.value = typeof card.creator_notes === 'string'
        ? card.creator_notes
        : (typeof card.notes === 'string'
            ? card.notes
            : (typeof card.personality === 'string' ? card.personality : ''));
    dom.cardScenarioInput.value = typeof card.scenario === 'string'
        ? card.scenario
        : (card.persona && typeof card.persona === 'object' && typeof card.persona.scenario === 'string' ? card.persona.scenario : '');
    dom.cardTagsInput.value = Array.isArray(card.tags) ? card.tags.join(', ') : '';
    
    lorebookEntries = extractLorebookEntriesFromCard(card);
    debugLog('populateFromCard: extracted entries count =', lorebookEntries.length);
    
    if (lorebookEntries.length === 0) {
        lorebookNextId = 1;
    } else {
        const maxId = Math.max(...lorebookEntries.map((entry) => Number(entry.id)).filter((id) => Number.isFinite(id)));
        lorebookNextId = Number.isFinite(maxId) ? maxId + 1 : lorebookEntries.length + 1;
    }
    debugLog('populateFromCard: lorebookNextId =', lorebookNextId);
    renderLorebookEntries();
    syncLorebookSchemaState();
    if (dom.cardVisualDescriptionInput) dom.cardVisualDescriptionInput.value = '';
    isPopulating = false;
    isFormDirty = false;
    resetGenerationHistory();
}

/**
 * Clears all editor fields.
 */
export function clearFields() {
    isPopulating = true;
    if (dom.cardNameInput) dom.cardNameInput.value = '';
    if (dom.cardDescriptionInput) dom.cardDescriptionInput.value = '';
    if (dom.cardFirstMesInput) dom.cardFirstMesInput.value = '';
    if (dom.cardCreatorNotesInput) dom.cardCreatorNotesInput.value = '';
    if (dom.cardScenarioInput) dom.cardScenarioInput.value = '';
    if (dom.cardTagsInput) dom.cardTagsInput.value = '';
    if (dom.cardVisualDescriptionInput) dom.cardVisualDescriptionInput.value = '';
    lorebookEntries = [];
    lorebookNextId = 1;
    renderLorebookEntries();
    syncLorebookSchemaState();
    isPopulating = false;
    isFormDirty = false;
    resetGenerationHistory();
}

/**
 * Sets user-facing status text for card editor actions.
 * @param {string} text
 */
export function setStatus(text) {
    if (dom.cardEditorStatus) {
        dom.cardEditorStatus.textContent = text;
    }
}

/**
 * Updates card editor mode label badge text.
 * @param {'create'|'edit'} mode
 */
export function updateModeBadge(mode) {
    if (!dom.cardEditorModeBadge) {
        return;
    }

    dom.cardEditorModeBadge.textContent = mode === 'create' ? 'Create' : 'Edit';
}

/**
 * Unwraps `data`-wrapped schemas to one normalized card object.
 * @param {any} parsed
 */
export function unwrapCardData(parsed) {
    if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
        return parsed.data;
    }
    return parsed;
}

/**
 * Determines schema version from card wrappers or version fields.
 * @param {any} parsed
 */
export function detectSchemaVersion(parsed) {
    const specVersion = parsed && typeof parsed.spec_version === 'string' ? parsed.spec_version : '';
    if (specVersion.startsWith('3')) {
        return '3.0';
    }
    if (specVersion.startsWith('2')) {
        return '2.0';
    }
    if (specVersion.startsWith('1')) {
        return '1.0';
    }

    const card = unwrapCardData(parsed);
    const version = card && typeof card.version === 'string' ? card.version : '';
    if (version.startsWith('3')) {
        return '3.0';
    }
    if (version.startsWith('2')) {
        return '2.0';
    }
    if (version.startsWith('1')) {
        return '1.0';
    }

    // v1 payloads are often plain objects without spec/version wrappers.
    // Detect that shape explicitly so they do not fall back to v2 in the UI.
    if (
        card
        && typeof card.name === 'string'
        && typeof card.description === 'string'
        && typeof card.personality === 'string'
        && typeof card.scenario === 'string'
        && typeof card.first_mes === 'string'
        && typeof card.mes_example === 'string'
    ) {
        return '1.0';
    }

    if (card && typeof card.user_name === 'string') {
        return '1.0';
    }

    return null;
}

/**
 * Checks whether object shape resembles a known character card payload.
 * @param {any} card
 */
export function isCardLike(card) {
    if (!card || typeof card !== 'object') {
        return false;
    }

    if (typeof card.name !== 'string' || card.name.trim().length === 0) {
        return false;
    }

    return typeof card.description === 'string'
        || typeof card.persona === 'string'
        || typeof card.first_mes === 'string'
        || typeof card.creator_notes === 'string';
}

/**
 * Sanitizes proposed filename stem for save dialog defaults.
 * @param {string} name
 */
export function sanitizeFilename(name) {
    const stem = (name || 'character-card')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .trim();
    return stem.length > 0 ? stem : 'character-card';
}
