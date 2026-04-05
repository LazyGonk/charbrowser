import { dom } from '../dom.js';
import { state } from '../state.js';
import { formatDuration, formatFileSize, getExtension } from '../utils/file-utils.js';
import { getExifHighlights } from '../utils/metadata-utils.js';

/**
 * Renders full metadata payload in sidebar panel.
 * @param {any} metadata Backend metadata object.
 */
export function displayMetadata(metadata) {
    dom.metadataContent.innerHTML = '';
    const selectedExt = state.selectedFile ? getExtension(state.selectedFile) : '';

    addMetadataRow('File Name', metadata.file_name);
    addMetadataRow('File Path', metadata.file_path);
    addMetadataRow('File Size', formatFileSize(metadata.file_size));
    addMetadataRow('File Type', metadata.file_type);

    if (metadata.width != null && metadata.height != null) {
        addMetadataRow('Dimensions', `${metadata.width} × ${metadata.height}`);
    }

    if (metadata.duration != null) {
        addMetadataRow('Duration', formatDuration(metadata.duration));
    }

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

    if (metadata.format_specific && Object.keys(metadata.format_specific).length > 0) {
        const section = document.createElement('div');
        section.className = 'metadata-section';

        const heading = document.createElement('h3');
        heading.textContent = 'Additional Information';
        section.appendChild(heading);

        dom.metadataContent.appendChild(section);
        displayFormatSpecific(metadata.format_specific, section);
    }

    if (selectedExt === 'avi' || selectedExt === 'mkv') {
        const notice = document.createElement('div');
        notice.className = 'metadata-video-json-notice';
        notice.textContent = 'Note: AVI/MKV embedded JSON edits must keep payload length unchanged to avoid container corruption.';
        dom.metadataContent.appendChild(notice);
    }
}

/**
 * Adds one label/value row to main metadata container.
 * @param {string} label
 * @param {string|number|null|undefined} value
 */
export function addMetadataRow(label, value) {
    addMetadataRowToContainer(dom.metadataContent, label, value);
}

/**
 * Adds one label/value row to an arbitrary metadata section.
 * @param {HTMLElement} container
 * @param {string} label
 * @param {string|number|null|undefined} value
 */
export function addMetadataRowToContainer(container, label, value) {
    const row = document.createElement('div');
    row.className = 'metadata-row';

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
