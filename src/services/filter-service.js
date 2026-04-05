import { state } from '../state.js';

/**
 * Runs an asynchronous filter with bounded concurrency and token cancellation.
 * @param {string[]} files Input file paths.
 * @param {number} token Active filter token.
 * @param {(filePath: string) => Promise<boolean>} predicate Async predicate.
 * @param {number} concurrency Worker count.
 * @returns {Promise<string[]>} Filtered file paths.
 */
export async function filterWithAsyncPredicate(files, token, predicate, concurrency = 4) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < files.length) {
            if (token !== state.folderFilterToken) {
                return;
            }

            const index = nextIndex;
            nextIndex += 1;
            const filePath = files[index];
            if (await predicate(filePath)) {
                results.push(filePath);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
    return results;
}

/**
 * Sorts file paths based on selected criterion and cached metadata.
 * @param {string[]} files
 * @param {Map<string, any>} metadataFilterCache
 * @param {string} sortBy
 * @param {'asc'|'desc'} sortDirection
 */
export function sortFiles(files, metadataFilterCache, sortBy, sortDirection) {
    const direction = sortDirection === 'desc' ? -1 : 1;
    const byName = (a, b) => {
        const aName = (a.split(/[\\/]/).pop() || '').toLowerCase();
        const bName = (b.split(/[\\/]/).pop() || '').toLowerCase();
        return aName.localeCompare(bName);
    };

    const byNumeric = (aValue, bValue) => {
        const aMissing = aValue == null;
        const bMissing = bValue == null;
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return aValue - bValue;
    };

    files.sort((a, b) => {
        if (sortBy === 'name') {
            return byName(a, b) * direction;
        }

        const aData = metadataFilterCache.get(a);
        const bData = metadataFilterCache.get(b);

        let compared = 0;
        if (sortBy === 'size') {
            compared = byNumeric(aData?.fileSize ?? null, bData?.fileSize ?? null);
        } else if (sortBy === 'date') {
            compared = byNumeric(aData?.modifiedTimestamp ?? null, bData?.modifiedTimestamp ?? null);
        } else if (sortBy === 'duration') {
            compared = byNumeric(aData?.duration ?? null, bData?.duration ?? null);
        } else if (sortBy === 'resolution') {
            compared = byNumeric(aData?.resolution ?? null, bData?.resolution ?? null);
        }

        if (compared === 0) {
            return byName(a, b) * direction;
        }
        return compared * direction;
    });
}
