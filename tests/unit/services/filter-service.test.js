import { describe, expect, it } from 'vitest';
import { filterWithAsyncPredicate, sortFiles } from '../../../src/services/filter-service.js';
import { state } from '../../../src/state.js';

describe('filter-service', () => {
    it('filters with async predicate and bounded concurrency', async () => {
        const files = ['a.png', 'b.jpg', 'c.txt', 'd.webp', 'e.mp4'];
        state.folderFilterToken = 42;

        let running = 0;
        let maxRunning = 0;

        const result = await filterWithAsyncPredicate(
            files,
            42,
            async (filePath) => {
                running += 1;
                maxRunning = Math.max(maxRunning, running);
                await new Promise((resolve) => setTimeout(resolve, 5));
                running -= 1;
                return filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.webp');
            },
            2
        );

        expect(maxRunning).toBeLessThanOrEqual(2);
        expect(result.slice().sort()).toEqual(['a.png', 'b.jpg', 'd.webp']);
    });

    it('stops processing when token changes', async () => {
        const files = ['1', '2', '3', '4', '5', '6'];
        state.folderFilterToken = 100;

        let calls = 0;
        const resultPromise = filterWithAsyncPredicate(
            files,
            100,
            async () => {
                calls += 1;
                if (calls === 2) {
                    state.folderFilterToken = 999;
                }
                await new Promise((resolve) => setTimeout(resolve, 1));
                return true;
            },
            3
        );

        const result = await resultPromise;
        expect(calls).toBeLessThan(files.length);
        expect(result.length).toBeLessThan(files.length);
    });

    it('sorts by name in both directions', () => {
        const files = ['zeta.png', 'alpha.png', 'gamma.png'];
        const cache = new Map();

        sortFiles(files, cache, 'name', 'asc');
        expect(files).toEqual(['alpha.png', 'gamma.png', 'zeta.png']);

        sortFiles(files, cache, 'name', 'desc');
        expect(files).toEqual(['zeta.png', 'gamma.png', 'alpha.png']);
    });

    it('sorts by numeric metadata with fallback name ordering', () => {
        const files = ['b.png', 'a.png', 'c.png'];
        const cache = new Map([
            ['a.png', { fileSize: 20, duration: 5, modifiedTimestamp: 2, resolution: 720 }],
            ['b.png', { fileSize: 20, duration: 10, modifiedTimestamp: 1, resolution: 1080 }],
            ['c.png', { fileSize: null, duration: null, modifiedTimestamp: null, resolution: null }],
        ]);

        sortFiles(files, cache, 'size', 'asc');
        expect(files).toEqual(['a.png', 'b.png', 'c.png']);

        sortFiles(files, cache, 'duration', 'desc');
        expect(files).toEqual(['c.png', 'b.png', 'a.png']);

        sortFiles(files, cache, 'date', 'asc');
        expect(files).toEqual(['b.png', 'a.png', 'c.png']);

        sortFiles(files, cache, 'resolution', 'desc');
        expect(files).toEqual(['c.png', 'b.png', 'a.png']);
    });
});
