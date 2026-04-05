/**
 * Pulls a concise EXIF highlight list for human-readable metadata presentation.
 * @param {Record<string, unknown>|null|undefined} formatSpecific Nested format metadata.
 * @returns {Array<[string, string]>} Label/value tuples to render in metadata panel.
 */
export function getExifHighlights(formatSpecific) {
    if (!formatSpecific || typeof formatSpecific !== 'object') {
        return [];
    }

    const exif = formatSpecific.exif;
    if (!exif || typeof exif !== 'object') {
        return [];
    }

    const preferred = [
        ['Captured', ['datetimeoriginal', 'datetime']],
        ['Camera Make', ['make']],
        ['Camera Model', ['model']],
        ['Lens', ['lensmodel', 'lensmake']],
        ['Focal Length', ['focallength']],
        ['F-Number', ['fnumber']],
        ['Exposure', ['exposuretime']],
        ['ISO', ['photographicsensitivity', 'isospeedratings']],
        ['GPS', ['gpslatitude', 'gpslongitude']],
    ];

    const allEntries = Object.entries(exif)
        .map(([key, value]) => [String(key), String(value)])
        .filter(([, value]) => value.trim().length > 0);

    const used = new Set();
    const result = [];

    for (const [label, needles] of preferred) {
        const match = allEntries.find(([key]) => {
            const lower = key.toLowerCase();
            if (used.has(key)) {
                return false;
            }
            return needles.some((needle) => lower.includes(needle));
        });

        if (match) {
            used.add(match[0]);
            result.push([label, match[1]]);
        }
    }

    return result;
}

/**
 * Normalizes JSON field names for robust narrative field discovery.
 * @param {string} key Field name.
 * @returns {string} Sanitized lowercase key.
 */
export function normalizeFieldKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Recursively collects known narrative fields from arbitrary JSON objects.
 * @param {unknown} value Parsed JSON value.
 * @param {{description: string|null, firstMes: string|null}} out Accumulator.
 */
export function collectNarrativeFields(value, out) {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectNarrativeFields(item, out);
        }
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeFieldKey(key);
        if (typeof child === 'string') {
            const text = child.trim();
            if (text.length > 0) {
                if (!out.description && normalized === 'description') {
                    out.description = text;
                }
                if (!out.firstMes && normalized === 'firstmes') {
                    out.firstMes = text;
                }
            }
        } else {
            collectNarrativeFields(child, out);
        }
    }
}

/**
 * Extracts top-level character narrative fields from embedded JSON entries.
 * @param {Array<{decoded_json: string}>} entries Embedded JSON entries from backend.
 * @returns {{description: string|null, firstMes: string|null}} Narrative text values.
 */
export function extractNarrativeFieldsFromEntries(entries) {
    const out = {
        description: null,
        firstMes: null,
    };

    for (const entry of entries) {
        if (out.description && out.firstMes) {
            break;
        }

        try {
            const parsed = JSON.parse(entry.decoded_json);
            collectNarrativeFields(parsed, out);
        } catch {
            // Ignore non-JSON decoded payloads.
        }
    }

    return out;
}

/**
 * Converts rendered metadata rows into clipboard-friendly key/value lines.
 * @param {HTMLElement|null} metadataEl Metadata root container.
 * @returns {string} Newline-delimited metadata entries.
 */
export function collectCopyableMetadataPairs(metadataEl) {
    if (!metadataEl) {
        return '';
    }

    const info = [];
    const seen = new Set();
    const skipFields = new Set([
        'File Type', 'File Path', 'File Name', 'File Size',
        'Dimensions', 'Duration', 'Sample Rate', 'Channels', 'Bit Rate',
        'Format'
    ]);

    const allRows = metadataEl.querySelectorAll('.metadata-row');
    for (const row of allRows) {
        const labelDiv = row.querySelector('.metadata-label');
        const valueDiv = row.querySelector('.metadata-value');
        if (!labelDiv || !valueDiv) {
            continue;
        }

        const key = labelDiv.textContent.trim();
        const val = valueDiv.textContent.trim();
        if (skipFields.has(key) || val === 'N/A' || val === 'Unknown' || !val) {
            continue;
        }

        const fullPair = `${key}: ${val}`;
        if (!seen.has(fullPair)) {
            seen.add(fullPair);
            info.push(fullPair);
        }
    }

    return info.join('\n');
}
