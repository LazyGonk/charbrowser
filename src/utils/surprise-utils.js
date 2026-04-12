export const SURPRISE_SEQUENCE = [
    'arrowup',
    'arrowup',
    'arrowdown',
    'arrowdown',
    'arrowleft',
    'arrowright',
    'arrowleft',
    'arrowright',
    'b',
    'a',
];

/**
 * Returns next surprise sequence index for one key press.
 * @param {number} currentIndex
 * @param {string} key
 * @returns {number}
 */
export function getNextSurpriseIndex(currentIndex, key) {
    const normalized = String(key || '').toLowerCase();
    if (normalized === SURPRISE_SEQUENCE[currentIndex]) {
        return currentIndex + 1;
    }
    if (normalized === SURPRISE_SEQUENCE[0]) {
        return 1;
    }
    return 0;
}
