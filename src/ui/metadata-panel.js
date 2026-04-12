import { dom } from '../dom.js';
import { state } from '../state.js';
import { formatDuration, formatFileSize, getExtension } from '../utils/file-utils.js';
import { getExifHighlights } from '../utils/metadata-utils.js';
import { updateMetadataFieldsData } from '../services/metadata-service.js';

let metadataReviewHandlersInitialized = false;

/**
 * Renders full metadata payload in sidebar panel.
 * @param {any} metadata Backend metadata object.
 */
export function displayMetadata(metadata) {
    dom.metadataContent.innerHTML = '';
    const selectedExt = state.selectedFile ? getExtension(state.selectedFile) : '';
    const editorSpec = buildMetadataEditorSpec(selectedExt, metadata?.format_specific || {});

    ensureMetadataReviewHandlers();

    addMetadataRow('File Name', metadata.file_name, { rowGroup: 'file-info-primary', key: 'file-name' });
    addMetadataRow('File Path', metadata.file_path, { rowGroup: 'file-info-primary', key: 'file-path' });
    addMetadataRow('File Size', formatFileSize(metadata.file_size), { rowGroup: 'file-info-primary', key: 'file-size' });
    addMetadataRow('File Type', metadata.file_type, { rowGroup: 'file-info-primary', key: 'file-type' });

    // Dimensions and duration are shown in the preview overlay info panel, not duplicated here.

    if (metadata.sample_rate != null) {
        addMetadataRow('Sample Rate', `${metadata.sample_rate} Hz`);
    }
    if (metadata.channels != null) {
        addMetadataRow('Channels', metadata.channels);
    }
    if (metadata.bit_rate != null) {
        addMetadataRow('Bit Rate', `${metadata.bit_rate} kbps`);
    }

    const exifHighlights = getExifHighlights(metadata.format_specific);
    if (exifHighlights.length > 0) {
        const section = document.createElement('div');
        section.className = 'metadata-section';

        const heading = document.createElement('h3');
        heading.textContent = 'EXIF Highlights';
        section.appendChild(heading);

        dom.metadataContent.appendChild(section);

        for (const [label, value] of exifHighlights) {
            addMetadataRowToContainer(section, label, value);
        }
    }

    let additionalInfoSection = null;
    if (!editorSpec.editable && metadata.format_specific && Object.keys(metadata.format_specific).length > 0) {
        const section = document.createElement('div');
        section.className = 'metadata-section metadata-section-additional-info';

        const heading = document.createElement('h3');
        heading.textContent = 'Additional Information';
        section.appendChild(heading);

        // Filter out redundant keys when embedded JSON exists
        let displayData = metadata.format_specific;
        const hasEmbeddedJson = state.embeddedJsonEntries && state.embeddedJsonEntries.length > 0;
        if (hasEmbeddedJson) {
            const embeddedJsonLabels = state.embeddedJsonEntries
                .map(e => e.label?.toLowerCase())
                .filter(Boolean);
            const keysToHide = ['txxx', 'prompt', 'workflow'];
            displayData = Object.fromEntries(
                Object.entries(metadata.format_specific).filter(([k]) => {
                    const lowerKey = k.toLowerCase();
                    return !keysToHide.includes(lowerKey) &&
                           !embeddedJsonLabels.some(label => lowerKey === label.toLowerCase());
                })
            );
        }

        displayFormatSpecific(displayData, section);
        additionalInfoSection = section;
    }

    if (selectedExt === 'avi' || selectedExt === 'mkv') {
        const notice = document.createElement('div');
        notice.className = 'metadata-video-json-notice';
        notice.textContent = 'Note: AVI/MKV embedded JSON edits must keep payload length unchanged to avoid container corruption.';
        dom.metadataContent.appendChild(notice);
    }

    // Keep Additional Information at the bottom of the metadata panel for better scanability.
    if (additionalInfoSection) {
        dom.metadataContent.appendChild(additionalInfoSection);
    }

    renderMetadataEditorSection(editorSpec, metadata);

    // File info details are now controlled by the preview overlay info toggle.
    setFileInfoVisibility(false);
}

/**
 * Registers shared review-modal handlers for metadata save confirmations.
 */
function ensureMetadataReviewHandlers() {
    if (metadataReviewHandlersInitialized) {
        return;
    }
    metadataReviewHandlersInitialized = true;

    dom.confirmJsonSaveBtn?.addEventListener('click', async () => {
        if (!state.pendingMetadataSave) {
            return;
        }

        const payload = state.pendingMetadataSave;
        state.pendingMetadataSave = null;
        dom.jsonDiffModal.style.display = 'none';

        try {
            await updateMetadataFieldsData(payload.filePath, payload.updates);
            window.dispatchEvent(new CustomEvent('charbrowser:metadata-edited'));
        } catch (error) {
            if (payload.statusElement) {
                payload.statusElement.textContent = `Metadata save failed: ${String(error)}`;
            }
        }
    });

    dom.cancelJsonSaveBtn?.addEventListener('click', () => {
        if (!state.pendingMetadataSave) {
            return;
        }

        const payload = state.pendingMetadataSave;
        state.pendingMetadataSave = null;
        dom.jsonDiffModal.style.display = 'none';
        if (payload.statusElement) {
            payload.statusElement.textContent = 'Metadata save canceled.';
        }
    });
}

/**
 * Renders format-aware metadata editor controls when backend write support exists.
 * @param {{editable: boolean, reason?: string, fields?: Array<{key: string, label: string, value: string}>, originals?: Record<string, string>}} editorSpec
 * @param {any} metadata
 */
function renderMetadataEditorSection(editorSpec, metadata) {
    const section = document.createElement('div');
    section.className = 'metadata-section metadata-editor-section';

    const heading = document.createElement('h3');
    heading.textContent = 'Metadata Editor';
    section.appendChild(heading);

    const status = document.createElement('div');
    status.className = 'embedded-json-status';

    if (!editorSpec.editable) {
        const notice = document.createElement('div');
        notice.className = 'metadata-video-json-notice';
        notice.textContent = editorSpec.reason;
        section.appendChild(notice);
        dom.metadataContent.appendChild(section);
        return;
    }

    const editorGrid = document.createElement('div');
    editorGrid.className = 'metadata-editor-grid';

    const inputs = new Map();
    for (const field of editorSpec.fields) {
        const row = document.createElement('div');
        row.className = 'metadata-editor-row';

        const label = document.createElement('label');
        label.className = 'metadata-label';
        label.textContent = field.label;
        label.htmlFor = `metadataEdit_${field.key}`;

        const input = document.createElement('input');
        input.className = 'embedded-json-text-filter';
        input.id = `metadataEdit_${field.key}`;
        input.type = 'text';
        input.value = field.value;

        row.appendChild(label);
        row.appendChild(input);
        editorGrid.appendChild(row);
        inputs.set(field.key, input);
    }

    const actions = document.createElement('div');
    actions.className = 'embedded-json-actions';

    const saveButton = document.createElement('button');
    saveButton.className = 'btn';
    saveButton.textContent = '💾 Save Metadata Changes';

    saveButton.addEventListener('click', async () => {
        if (!state.selectedFile) {
            status.textContent = 'No file selected.';
            return;
        }

        const changed = {};
        for (const field of editorSpec.fields) {
            const input = inputs.get(field.key);
            const nextValue = String(input?.value || '').trim();
            if (nextValue !== field.value) {
                changed[field.key] = nextValue;
            }
        }

        const changedEntries = Object.entries(changed);
        if (changedEntries.length === 0) {
            status.textContent = 'No metadata changes to save.';
            return;
        }

        const originalText = changedEntries
            .map(([key]) => `${key}: ${editorSpec.originals[key] || ''}`)
            .join('\n');
        const editedText = changedEntries
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');

        state.pendingMetadataSave = {
            filePath: state.selectedFile,
            updates: changed,
            statusElement: status,
        };

        if (dom.jsonDiffTitle) dom.jsonDiffTitle.textContent = 'Review Metadata Changes';
        if (dom.jsonDiffOriginalLabel) dom.jsonDiffOriginalLabel.textContent = 'Current';
        if (dom.jsonDiffEditedLabel) dom.jsonDiffEditedLabel.textContent = 'Updated';
        dom.jsonDiffOriginal.textContent = originalText;
        dom.jsonDiffEdited.textContent = editedText;
        dom.jsonDiffSummary.textContent = `${changedEntries.length} metadata field${changedEntries.length === 1 ? '' : 's'} will be updated.`;
        dom.jsonDiffModal.style.display = 'flex';
    });

    actions.appendChild(saveButton);
    actions.appendChild(status);

    section.appendChild(editorGrid);
    section.appendChild(actions);
    dom.metadataContent.appendChild(section);
}

/**
 * Builds editable field list per format and returns user-facing support messaging.
 * @param {string} ext
 * @param {Record<string, unknown>} formatSpecific
 */
function buildMetadataEditorSpec(ext, formatSpecific) {
    const extension = String(ext || '').toLowerCase();

    if (extension === 'mp3') {
        return buildFixedFieldEditorSpec(formatSpecific, [
            'title',
            'artist',
            'album',
            'album_artist',
            'year',
            'track',
            'genre',
            'comment',
        ]);
    }

    if (extension === 'flac') {
        return buildCaseAwareFieldEditorSpec(formatSpecific, [
            'TITLE',
            'ARTIST',
            'ALBUM',
            'DATE',
            'GENRE',
            'TRACKNUMBER',
            'COMMENT',
        ]);
    }

    if (extension === 'fits' || extension === 'fit') {
        const readOnly = new Set(['simple', 'bitpix', 'naxis', 'naxis1', 'naxis2', 'naxis3', 'extend', 'gcount', 'pcount', 'format']);
        const fields = [];
        const originals = {};

        for (const [key, value] of Object.entries(formatSpecific || {})) {
            if (readOnly.has(String(key).toLowerCase())) {
                continue;
            }

            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                fields.push({ key: String(key), label: String(key).toUpperCase(), value: String(value) });
                originals[String(key)] = String(value);
            }
        }

        return fields.length > 0
            ? { editable: true, fields, originals }
            : { editable: false, reason: 'No editable FITS header fields were detected for this file.' };
    }

    if (extension === 'ogg') {
        return { editable: false, reason: 'OGG metadata writing is deferred to avoid risky page-level container rewrites.' };
    }

    if (extension === 'jpg' || extension === 'jpeg' || extension === 'tif' || extension === 'tiff' || extension === 'webp') {
        return { editable: false, reason: 'EXIF editing for this format is deferred because the current EXIF dependency is read-only.' };
    }

    return { editable: false, reason: 'Metadata editing is currently available for MP3, FLAC, and FITS files.' };
}

/**
 * Builds field specs for case-sensitive direct key lookup.
 * @param {Record<string, unknown>} formatSpecific
 * @param {string[]} keys
 */
function buildFixedFieldEditorSpec(formatSpecific, keys) {
    const fields = [];
    const originals = {};

    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(formatSpecific, key)) {
            continue;
        }

        const value = formatSpecific[key];
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            continue;
        }

        fields.push({ key, label: key.toUpperCase(), value: String(value) });
        originals[key] = String(value);
    }

    if (fields.length === 0) {
        return { editable: false, reason: 'No editable metadata fields were found for this file.' };
    }

    return { editable: true, fields, originals };
}

/**
 * Builds field specs by resolving desired keys against existing keys case-insensitively.
 * @param {Record<string, unknown>} formatSpecific
 * @param {string[]} desiredKeys
 */
function buildCaseAwareFieldEditorSpec(formatSpecific, desiredKeys) {
    const keyMap = new Map(Object.keys(formatSpecific || {}).map((k) => [k.toUpperCase(), k]));
    const fields = [];
    const originals = {};

    for (const desired of desiredKeys) {
        const actualKey = keyMap.get(desired);
        if (!actualKey) {
            continue;
        }

        const value = formatSpecific[actualKey];
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            continue;
        }

        fields.push({ key: actualKey, label: desired, value: String(value) });
        originals[actualKey] = String(value);
    }

    if (fields.length === 0) {
        return { editable: false, reason: 'No editable FLAC metadata fields were found for this file.' };
    }

    return { editable: true, fields, originals };
}

/**
 * Adds one label/value row to main metadata container.
 * @param {string} label
 * @param {string|number|null|undefined} value
 * @param {{rowGroup?: string, key?: string}} [options]
 */
export function addMetadataRow(label, value, options = {}) {
    addMetadataRowToContainer(dom.metadataContent, label, value, options);
}

/**
 * Adds one label/value row to an arbitrary metadata section.
 * @param {HTMLElement} container
 * @param {string} label
 * @param {string|number|null|undefined} value
 * @param {{rowGroup?: string, key?: string}} [options]
 */
export function addMetadataRowToContainer(container, label, value, options = {}) {
    const row = document.createElement('div');
    row.className = 'metadata-row';
    if (options.rowGroup) {
        row.dataset.rowGroup = options.rowGroup;
    }
    if (options.key) {
        row.dataset.metadataKey = options.key;
    }

    const labelDiv = document.createElement('div');
    labelDiv.className = 'metadata-label';
    labelDiv.textContent = label;

    const valueDiv = document.createElement('div');
    valueDiv.className = 'metadata-value';
    valueDiv.textContent = value || 'N/A';

    row.appendChild(labelDiv);
    row.appendChild(valueDiv);
    container.appendChild(row);
}

/**
 * Shows or hides primary file-info rows and section heading.
 * @param {boolean} visible
 */
export function setFileInfoVisibility(visible) {
    if (dom.fileInfoHeader) {
        dom.fileInfoHeader.style.display = visible ? 'block' : 'none';
    }

    const rows = dom.metadataContent?.querySelectorAll('[data-row-group="file-info-primary"]') || [];
    for (const row of rows) {
        row.style.display = visible ? '' : 'none';
    }
}

/**
 * Shows or hides the Additional Information metadata section.
 * @param {boolean} visible
 */
export function setAdditionalInfoVisibility(visible) {
    const section = dom.metadataContent?.querySelector('.metadata-section-additional-info');
    if (section) {
        section.style.display = visible ? '' : 'none';
    }
}

/**
 * Recursively renders nested format-specific metadata structures.
 * @param {Record<string, unknown>} obj
 * @param {HTMLElement} container
 */
export function displayFormatSpecific(obj, container) {
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const subSection = document.createElement('div');
            subSection.className = 'metadata-section';
            const heading = document.createElement('h3');
            heading.textContent = key;
            subSection.appendChild(heading);
            container.appendChild(subSection);
            displayFormatSpecific(value, subSection);
        } else {
            const row = document.createElement('div');
            row.className = 'metadata-row';

            const labelDiv = document.createElement('div');
            labelDiv.className = 'metadata-label';
            labelDiv.textContent = key;

            const valueDiv = document.createElement('div');
            valueDiv.className = 'metadata-value';
            valueDiv.textContent = String(value);

            row.appendChild(labelDiv);
            row.appendChild(valueDiv);
            container.appendChild(row);
        }
    }
}
