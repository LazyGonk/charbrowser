/**
 * Safely extracts trimmed value from a DOM input element.
 * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|null} element
 * @returns {string}
 */
export function getInputValue(element) {
    return String(element?.value || '').trim();
}

/**
 * Escapes HTML special characters for safe text interpolation into innerHTML.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
