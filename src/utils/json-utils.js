/**
 * Pretty-formats JSON text when possible, otherwise returns the original text.
 * Used by embedded JSON rendering and diff display preparation.
 * @param {string} text JSON string.
 * @returns {string} Formatted JSON or original text.
 */
export function tryFormatJsonPretty(text) {
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, 2);
    } catch {
        return text;
    }
}

/**
 * Formats JSON preview text and truncates very large payloads for UI rendering.
 * @param {string} text Raw JSON or text input.
 * @param {number} maxLength Maximum output characters before truncation.
 * @returns {{formattedText: string, isJson: boolean, isTruncated: boolean}}
 */
export function formatJsonPreviewText(text, maxLength) {
    const raw = typeof text === 'string' ? text : '';
    const safeMaxLength = Number.isFinite(Number(maxLength))
        ? Math.max(0, Number(maxLength))
        : raw.length;

    let formatted = raw;
    let isJson = false;
    try {
        const parsed = JSON.parse(raw);
        formatted = JSON.stringify(parsed, null, 2);
        isJson = true;
    } catch {
        // Keep raw text for invalid JSON payloads.
    }

    if (formatted.length <= safeMaxLength) {
        return {
            formattedText: formatted,
            isJson,
            isTruncated: false,
        };
    }

    const suffix = '\n... (truncated)';
    const keepLength = Math.max(0, safeMaxLength - suffix.length);
    return {
        formattedText: `${formatted.slice(0, keepLength)}${suffix}`,
        isJson,
        isTruncated: true,
    };
}

/**
 * Normalizes JSON text into deterministic pretty format.
 * @param {string} text JSON string.
 * @returns {string} Pretty-printed JSON string.
 */
export function normalizeJsonText(text) {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
}

/**
 * Flattens nested JSON into a path->value map for structural diffing.
 * @param {unknown} value Parsed JSON value.
 * @param {string} prefix Current object path.
 * @param {Map<string, string>} out Output map.
 * @returns {Map<string, string>} Flattened map.
 */
export function flattenJson(value, prefix = '', out = new Map()) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            out.set(prefix || '[]', '[]');
            return out;
        }

        value.forEach((item, index) => {
            const next = prefix ? `${prefix}[${index}]` : `[${index}]`;
            flattenJson(item, next, out);
        });
        return out;
    }

    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            out.set(prefix || '{}', '{}');
            return out;
        }

        for (const key of keys) {
            const next = prefix ? `${prefix}.${key}` : key;
            flattenJson(value[key], next, out);
        }
        return out;
    }

    out.set(prefix || 'value', JSON.stringify(value));
    return out;
}

/**
 * Summarizes JSON differences between original and edited text.
 * @param {string} originalText Original JSON text.
 * @param {string} editedText Edited JSON text.
 * @returns {string} Multi-line summary of added/removed/changed keys.
 */
export function buildJsonDiffSummary(originalText, editedText) {
    const original = JSON.parse(originalText);
    const edited = JSON.parse(editedText);

    const originalMap = flattenJson(original);
    const editedMap = flattenJson(edited);

    const added = [];
    const removed = [];
    const changed = [];

    for (const key of editedMap.keys()) {
        if (!originalMap.has(key)) {
            added.push(key);
            continue;
        }
        if (originalMap.get(key) !== editedMap.get(key)) {
            changed.push(key);
        }
    }

    for (const key of originalMap.keys()) {
        if (!editedMap.has(key)) {
            removed.push(key);
        }
    }

    const lines = [
        `Added keys: ${added.length}`,
        `Removed keys: ${removed.length}`,
        `Changed values: ${changed.length}`,
    ];

    if (added.length > 0) {
        lines.push(`Added: ${added.slice(0, 10).join(', ')}`);
    }
    if (removed.length > 0) {
        lines.push(`Removed: ${removed.slice(0, 10).join(', ')}`);
    }
    if (changed.length > 0) {
        lines.push(`Changed: ${changed.slice(0, 10).join(', ')}`);
    }

    return lines.join('\n');
}

/**
 * Formats scalar JSON values for tree editing UI.
 * @param {unknown} value Scalar JSON value.
 * @returns {string} String representation for editable node text.
 */
export function formatJsonValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === null) {
        return 'null';
    }
    return String(value);
}
