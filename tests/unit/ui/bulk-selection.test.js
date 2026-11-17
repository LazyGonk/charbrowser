import { beforeEach, describe, expect, it } from 'vitest';

import { state } from '../../../src/state.js';
import {
    areAllBulkSelected,
    bulkSelectedList,
    clearBulkSelection,
    isBulkSelected,
    pruneBulkSelection,
    removeBulkSelection,
    selectAllBulkSelection,
    selectBulkRange,
    toggleAllBulkSelection,
    toggleBulkSelection,
} from '../../../src/ui/bulk-selection.js';

describe('bulk selection', () => {
    beforeEach(() => {
        state.bulkSelectedPaths = new Set();
        state.bulkSelectionAnchor = null;
        state.currentFiles = ['/a.png', '/b.png', '/c.png', '/d.png'];
    });

    it('toggles one path without touching the preview selection', () => {
        state.selectedFile = '/a.png';

        expect(toggleBulkSelection(state, '/b.png')).toBe(true);
        expect(isBulkSelected(state, '/b.png')).toBe(true);
        expect(state.selectedFile).toBe('/a.png');

        expect(toggleBulkSelection(state, '/b.png')).toBe(false);
        expect(isBulkSelected(state, '/b.png')).toBe(false);
    });

    it('survives a rerender because the set is the source of truth', () => {
        toggleBulkSelection(state, '/a.png');
        toggleBulkSelection(state, '/c.png');

        // A rerender rebuilds rows from state; nothing clears the set.
        const rebuiltRows = state.currentFiles.map((path) => isBulkSelected(state, path));

        expect(rebuiltRows).toEqual([true, false, true, false]);
        expect(bulkSelectedList(state)).toEqual(['/a.png', '/c.png']);
    });

    it('extends a range from the last toggled path', () => {
        toggleBulkSelection(state, '/b.png');
        const added = selectBulkRange(state, state.currentFiles, '/d.png');

        expect(added).toBe(2);
        expect(bulkSelectedList(state)).toEqual(['/b.png', '/c.png', '/d.png']);
        expect(state.bulkSelectionAnchor).toBe('/d.png');
    });

    it('selects only the target when the anchor is not in the current list', () => {
        state.bulkSelectionAnchor = '/gone.png';

        selectBulkRange(state, state.currentFiles, '/c.png');

        expect(bulkSelectedList(state)).toEqual(['/c.png']);
    });

    it('prunes paths that are no longer visible and reports them', () => {
        selectAllBulkSelection(state, state.currentFiles);
        expect(state.bulkSelectedPaths.size).toBe(4);

        const removed = pruneBulkSelection(state, ['/b.png', '/d.png']);

        expect(removed).toEqual(['/a.png', '/c.png']);
        expect(bulkSelectedList(state)).toEqual(['/b.png', '/d.png']);
    });

    it('clears the anchor when the anchor path is pruned', () => {
        toggleBulkSelection(state, '/a.png');
        state.bulkSelectionAnchor = '/a.png';

        pruneBulkSelection(state, ['/b.png']);

        expect(state.bulkSelectionAnchor).toBe(null);
    });

    it('removes a deleted path and updates the anchor', () => {
        selectAllBulkSelection(state, ['/a.png', '/b.png']);
        state.bulkSelectionAnchor = '/a.png';

        expect(removeBulkSelection(state, '/a.png')).toBe(true);
        expect(removeBulkSelection(state, '/a.png')).toBe(false);
        expect(state.bulkSelectionAnchor).toBe(null);
        expect(bulkSelectedList(state)).toEqual(['/b.png']);
    });

    it('clears the whole selection', () => {
        selectAllBulkSelection(state, state.currentFiles);

        expect(clearBulkSelection(state)).toBe(4);
        expect(state.bulkSelectedPaths.size).toBe(0);
        expect(state.bulkSelectionAnchor).toBe(null);
    });

    it('select-all is idempotent', () => {
        selectAllBulkSelection(state, state.currentFiles);

        expect(selectAllBulkSelection(state, state.currentFiles)).toBe(0);
        expect(state.bulkSelectedPaths.size).toBe(4);
    });

    it('reports all-selected only for a non-empty fully selected list', () => {
        expect(areAllBulkSelected(state, [])).toBe(false);
        expect(areAllBulkSelected(state, state.currentFiles)).toBe(false);

        selectAllBulkSelection(state, ['/a.png', '/b.png']);

        expect(areAllBulkSelected(state, ['/a.png'])).toBe(true);
        expect(areAllBulkSelected(state, ['/a.png', '/b.png'])).toBe(true);
        expect(areAllBulkSelected(state, state.currentFiles)).toBe(false);
        expect(areAllBulkSelected(state, null)).toBe(false);
    });

    it('select-all toggle selects every path, then deselects them all', () => {
        toggleBulkSelection(state, '/a.png');
        state.bulkSelectionAnchor = '/a.png';

        expect(toggleAllBulkSelection(state, state.currentFiles)).toBe(true);
        expect(bulkSelectedList(state)).toEqual(['/a.png', '/b.png', '/c.png', '/d.png']);

        expect(toggleAllBulkSelection(state, state.currentFiles)).toBe(false);
        expect(state.bulkSelectedPaths.size).toBe(0);
        expect(state.bulkSelectionAnchor).toBe(null);
    });

    it('select-all toggle on an empty list adds nothing', () => {
        expect(toggleAllBulkSelection(state, [])).toBe(false);
        expect(state.bulkSelectedPaths.size).toBe(0);
        expect(areAllBulkSelected(state, [])).toBe(false);
    });
});
