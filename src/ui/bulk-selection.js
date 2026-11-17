/**
 * Bulk file selection helpers.
 *
 * Bulk selection is deliberately separate from `state.selectedFile` (the preview
 * selection): browsing a file and marking files for a batch are different
 * intents. The selected paths live in `state.bulkSelectedPaths`, so they survive
 * list rerenders; callers prune them when their backing files disappear.
 */

/**
 * Returns true when the path is part of the bulk selection.
 * @param {{bulkSelectedPaths: Set<string>}} state
 * @param {string} filePath
 * @returns {boolean}
 */
export function isBulkSelected(state, filePath) {
    return Boolean(filePath) && state.bulkSelectedPaths.has(filePath);
}

/**
 * Toggles one path and makes it the range anchor.
 * @param {object} state
 * @param {string} filePath
 * @returns {boolean} Whether the path is now selected.
 */
export function toggleBulkSelection(state, filePath) {
    if (!filePath) {
        return false;
    }

    state.bulkSelectionAnchor = filePath;
    if (state.bulkSelectedPaths.has(filePath)) {
        state.bulkSelectedPaths.delete(filePath);
        return false;
    }

    state.bulkSelectedPaths.add(filePath);
    return true;
}

/**
 * Adds every path between the anchor and `filePath` (inclusive) to the
 * selection. Falls back to selecting just `filePath` when no valid anchor exists.
 * @param {object} state
 * @param {string[]} orderedPaths Paths in list order.
 * @param {string} filePath
 * @returns {number} Number of paths added.
 */
export function selectBulkRange(state, orderedPaths, filePath) {
    const paths = Array.isArray(orderedPaths) ? orderedPaths : [];
    const anchorIndex = state.bulkSelectionAnchor ? paths.indexOf(state.bulkSelectionAnchor) : -1;
    const targetIndex = paths.indexOf(filePath);

    if (targetIndex === -1) {
        return 0;
    }

    const start = anchorIndex === -1 ? targetIndex : Math.min(anchorIndex, targetIndex);
    const end = anchorIndex === -1 ? targetIndex : Math.max(anchorIndex, targetIndex);

    let added = 0;
    for (let index = start; index <= end; index += 1) {
        const path = paths[index];
        if (!state.bulkSelectedPaths.has(path)) {
            state.bulkSelectedPaths.add(path);
            added += 1;
        }
    }
    state.bulkSelectionAnchor = filePath;
    return added;
}

/**
 * Removes one path from the bulk selection.
 * @param {object} state
 * @param {string} filePath
 * @returns {boolean} Whether the path was selected.
 */
export function removeBulkSelection(state, filePath) {
    const removed = state.bulkSelectedPaths.delete(filePath);
    if (removed && state.bulkSelectionAnchor === filePath) {
        state.bulkSelectionAnchor = null;
    }
    return removed;
}

/**
 * Returns true when the list is non-empty and every path is selected.
 * @param {object} state
 * @param {string[]} paths
 * @returns {boolean}
 */
export function areAllBulkSelected(state, paths) {
    const list = Array.isArray(paths) ? paths : [];
    return list.length > 0 && list.every((filePath) => state.bulkSelectedPaths.has(filePath));
}

/**
 * Selects every given path, or deselects them when they are all selected.
 * Mirrors the state a select-all checkbox drives.
 * @param {object} state
 * @param {string[]} paths
 * @returns {boolean} Whether every given path is selected afterwards.
 */
export function toggleAllBulkSelection(state, paths) {
    const list = Array.isArray(paths) ? paths : [];

    if (areAllBulkSelected(state, list)) {
        list.forEach((filePath) => state.bulkSelectedPaths.delete(filePath));
        if (list.includes(state.bulkSelectionAnchor)) {
            state.bulkSelectionAnchor = null;
        }
        return false;
    }

    selectAllBulkSelection(state, list);
    return areAllBulkSelected(state, list);
}

/**
 * Adds every given path to the selection.
 * @param {object} state
 * @param {string[]} paths
 * @returns {number} Number of paths added.
 */
export function selectAllBulkSelection(state, paths) {
    let added = 0;
    for (const filePath of Array.isArray(paths) ? paths : []) {
        if (!state.bulkSelectedPaths.has(filePath)) {
            state.bulkSelectedPaths.add(filePath);
            added += 1;
        }
    }
    return added;
}

/**
 * Clears the whole bulk selection.
 * @param {object} state
 * @returns {number} Number of paths that were selected.
 */
export function clearBulkSelection(state) {
    const count = state.bulkSelectedPaths.size;
    state.bulkSelectedPaths.clear();
    state.bulkSelectionAnchor = null;
    return count;
}

/**
 * Drops selections whose paths are no longer visible in the list.
 * @param {object} state
 * @param {string[]} allowedPaths
 * @returns {string[]} Removed paths.
 */
export function pruneBulkSelection(state, allowedPaths) {
    const allowed = new Set(Array.isArray(allowedPaths) ? allowedPaths : []);
    const removed = [];
    for (const filePath of state.bulkSelectedPaths) {
        if (!allowed.has(filePath)) {
            removed.push(filePath);
        }
    }
    removed.forEach((filePath) => state.bulkSelectedPaths.delete(filePath));

    if (state.bulkSelectionAnchor && !allowed.has(state.bulkSelectionAnchor)) {
        state.bulkSelectionAnchor = null;
    }
    return removed;
}

/**
 * Returns the bulk selection as a sorted array.
 * @param {object} state
 * @returns {string[]}
 */
export function bulkSelectedList(state) {
    return Array.from(state.bulkSelectedPaths).sort();
}
