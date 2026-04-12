/**
 * Hides an element by setting display to none.
 * @param {HTMLElement|null|undefined} element
 */
export function hideElement(element) {
    if (element) {
        element.style.display = 'none';
    }
}

/**
 * Shows an element with optional display mode.
 * @param {HTMLElement|null|undefined} element
 * @param {string} [display='block']
 */
export function showElement(element, display = 'block') {
    if (element) {
        element.style.display = display;
    }
}
