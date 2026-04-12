import { state } from '../state.js';
import { FILTER_DEFAULT_CONCURRENCY } from '../constants.js';
import { getFileName } from '../utils/file-utils.js';

function compareByName(a, b) {
    const aName = getFileName(a).toLowerCase();
    const bName = getFileName(b).toLowerCase();
    return aName.localeCompare(bName);
}

function compareNumeric(aValue, bValue) {
    const aMissing = aValue == null;
    const bMissing = bValue == null;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return aValue - bValue;
}

/**
 * Runs an asynchronous filter with bounded concurrency and token cancellation.
 * @param {string[]} files Input file paths.
 * @param {number} token Active filter token.
 * @param {(filePath: string) => Promise<boolean>} predicate Async predicate.
 * @param {number} concurrency Worker count.
 * @returns {Promise<string[]>} Filtered file paths.
 */
export async function filterWithAsyncPredicate(files, token, predicate, concurrency = FILTER_DEFAULT_CONCURRENCY) {
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
            try {
                if (await predicate(filePath)) {
                    results.push(filePath);
                }
            } catch {
                // Predicate failures are treated as a non-match so one bad file
                // does not abort the entire filtering pass.
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
    try {
        files.sort((a, b) => {
            if (sortBy === 'name') {
                return compareByName(a, b) * direction;
            }

            const aData = metadataFilterCache.get(a);
            const bData = metadataFilterCache.get(b);

            let compared = 0;
            if (sortBy === 'size') {
                compared = compareNumeric(aData?.fileSize ?? null, bData?.fileSize ?? null);
            } else if (sortBy === 'date') {
                compared = compareNumeric(aData?.modifiedTimestamp ?? null, bData?.modifiedTimestamp ?? null);
            } else if (sortBy === 'duration') {
                compared = compareNumeric(aData?.duration ?? null, bData?.duration ?? null);
            } else if (sortBy === 'resolution') {
                compared = compareNumeric(aData?.resolution ?? null, bData?.resolution ?? null);
            }

            if (compared === 0) {
                return compareByName(a, b) * direction;
            }
            return compared * direction;
        });
    } catch {
        files.sort((a, b) => compareByName(a, b) * direction);
    }
}
