import { performance } from 'node:perf_hooks';
import { filterWithAsyncPredicate, sortFiles } from '../src/services/filter-service.js';
import { state } from '../src/state.js';

function parsePositiveInt(raw, fallback) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}

function parseArgs(argv) {
    const args = {
        files: 1000,
        iterations: 20,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        const next = argv[i + 1];
        if (token === '--files' && next) {
            args.files = parsePositiveInt(next, args.files);
            i += 1;
        } else if (token === '--iterations' && next) {
            args.iterations = parsePositiveInt(next, args.iterations);
            i += 1;
        }
    }

    return args;
}

function createFixture(fileCount) {
    const files = [];
    const metadata = new Map();

    for (let i = 0; i < fileCount; i += 1) {
        const filePath = `C:/bench/file_${String(i).padStart(6, '0')}.png`;
        files.push(filePath);
        metadata.set(filePath, {
            fileSize: 50_000 + ((i * 149) % 6_000_000),
            modifiedTimestamp: 1_650_000_000 + ((i * 113) % 3_000_000),
            duration: i % 8 === 0 ? (30 + (i % 120)) : null,
            resolution: 512 * 512 + ((i % 240) * 1024),
            searchBlob: i % 11 === 0 ? 'portrait fantasy mage' : 'landscape neutral',
            hasExif: i % 3 === 0,
        });
    }

    return { files, metadata };
}

function elapsedMs(run) {
    const start = performance.now();
    run();
    return performance.now() - start;
}

async function elapsedAsyncMs(run) {
    const start = performance.now();
    await run();
    return performance.now() - start;
}

function printResult(label, values) {
    const total = values.reduce((sum, value) => sum + value, 0);
    const avg = total / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    console.log(`${label}: avg=${avg.toFixed(2)}ms min=${min.toFixed(2)}ms max=${max.toFixed(2)}ms`);
}

async function main() {
    const { files: fileCount, iterations } = parseArgs(process.argv.slice(2));
    const { files, metadata } = createFixture(fileCount);

    const sortByName = [];
    const sortBySize = [];
    const sortByDate = [];
    const metadataWordFilter = [];

    // Warm up JIT once for less noisy results.
    const warmup = [...files];
    sortFiles(warmup, metadata, 'name', 'asc');

    for (let i = 0; i < iterations; i += 1) {
        sortByName.push(elapsedMs(() => {
            const sample = [...files];
            sortFiles(sample, metadata, 'name', 'asc');
        }));

        sortBySize.push(elapsedMs(() => {
            const sample = [...files];
            sortFiles(sample, metadata, 'size', 'desc');
        }));

        sortByDate.push(elapsedMs(() => {
            const sample = [...files];
            sortFiles(sample, metadata, 'date', 'desc');
        }));

        state.folderFilterToken = i + 1;
        metadataWordFilter.push(await elapsedAsyncMs(async () => {
            await filterWithAsyncPredicate(
                files,
                state.folderFilterToken,
                async (filePath) => metadata.get(filePath)?.searchBlob.includes('portrait') === true,
                4
            );
        }));
    }

    console.log(`Benchmark: folder filter/sort (${fileCount} files, ${iterations} iterations)`);
    printResult('sort:name asc', sortByName);
    printResult('sort:size desc', sortBySize);
    printResult('sort:date desc', sortByDate);
    printResult('filter:metadata term', metadataWordFilter);
}

main().catch((error) => {
    console.error('Benchmark failed:', error);
    process.exitCode = 1;
});
