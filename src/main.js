import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { state, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, MEDIA_EXTS, THUMBNAIL_CONCURRENCY, evictCacheIfNeeded } from './state.js';

const metadataFilterCache = state.metadataFilterCache;
const embeddedJsonPresenceCache = state.embeddedJsonPresenceCache;

// DOM Elements
const openFolderBtn = document.getElementById('openFolderBtn');
const showLicensesBtn = document.getElementById('showLicensesBtn');
const dropZone = document.getElementById('dropZone');
const metadataView = document.getElementById('metadataView');
const fileList = document.getElementById('fileList');
const folderPath = document.getElementById('folderPath');
const fileNameFilter = document.getElementById('fileNameFilter');
const fileTypeFilter = document.getElementById('fileTypeFilter');
const mediaOnlyToggle = document.getElementById('mediaOnlyToggle');
const metadataWordFilter = document.getElementById('metadataWordFilter');
const hasEmbeddedJsonOnly = document.getElementById('hasEmbeddedJsonOnly');
const hasExifOnly = document.getElementById('hasExifOnly');
const sortByFilter = document.getElementById('sortByFilter');
const sortDirectionFilter = document.getElementById('sortDirectionFilter');
const folderFilterStatus = document.getElementById('folderFilterStatus');
const preview = document.getElementById('preview');
const videoPreview = document.getElementById('videoPreview');
const audioPreview = document.getElementById('audioPreview');
const noPreview = document.getElementById('noPreview');
const characterTextPanel = document.getElementById('characterTextPanel');
const characterDescription = document.getElementById('characterDescription');
const characterFirstMes = document.getElementById('characterFirstMes');
const metadataContent = document.getElementById('metadataContent');
const sidebarSplitter = document.getElementById('sidebarSplitter');
const metadataSplitter = document.getElementById('metadataSplitter');
const embeddedJsonSection = document.getElementById('embeddedJsonSection');
const embeddedJsonFormatFilter = document.getElementById('embeddedJsonFormatFilter');
const embeddedJsonTextFilter = document.getElementById('embeddedJsonTextFilter');
const embeddedJsonSelect = document.getElementById('embeddedJsonSelect');
const embeddedJsonPayloadLabel = document.getElementById('embeddedJsonPayloadLabel');
const embeddedJsonPayloadPreview = document.getElementById('embeddedJsonPayloadPreview');
const embeddedJsonTree = document.getElementById('embeddedJsonTree');
const saveEmbeddedJsonBtn = document.getElementById('saveEmbeddedJsonBtn');
const embeddedJsonStatus = document.getElementById('embeddedJsonStatus');
const jsonDiffModal = document.getElementById('jsonDiffModal');
const jsonDiffSummary = document.getElementById('jsonDiffSummary');
const jsonDiffOriginal = document.getElementById('jsonDiffOriginal');
const jsonDiffEdited = document.getElementById('jsonDiffEdited');
const confirmJsonSaveBtn = document.getElementById('confirmJsonSaveBtn');
const cancelJsonSaveBtn = document.getElementById('cancelJsonSaveBtn');
const licensesModal = document.getElementById('licensesModal');
const licensesMeta = document.getElementById('licensesMeta');
const licensesSearchInput = document.getElementById('licensesSearchInput');
const licensesEcosystemFilter = document.getElementById('licensesEcosystemFilter');
const licensesTableBody = document.getElementById('licensesTableBody');
const closeLicensesBtn = document.getElementById('closeLicensesBtn');
const openNoticesFileLink = document.getElementById('openNoticesFileLink');
const docViewerModal = document.getElementById('docViewerModal');
const docViewerTitle = document.getElementById('docViewerTitle');
const docViewerContent = document.getElementById('docViewerContent');
const closeDocViewerBtn = document.getElementById('closeDocViewerBtn');

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX_RATIO = 0.65;
const METADATA_MIN = 140;
const METADATA_MAX_RATIO = 0.8;

const thumbnailObserver = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }

            const item = entry.target;
            const path = item.dataset.path;
            thumbnailObserver.unobserve(item);
            if (path) {
                enqueueThumbnailLoad(item, path, state.folderLoadToken);
            }
        }
    },
    {
        root: fileList,
        rootMargin: '200px'
    }
);

function getExtension(filePath) {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    const idx = fileName.lastIndexOf('.');
    if (idx === -1) {
        return '';
    }
    return fileName.slice(idx + 1).toLowerCase();
}

function fileKindByPath(filePath) {
    const ext = getExtension(filePath);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return 'other';
}

// Open folder dialog
openFolderBtn.addEventListener('click', async () => {
    try {
        const directory = await open({
            directory: true,
            multiple: false,
        });

        if (typeof directory === 'string') {
            await loadDirectory(directory);
        } else if (Array.isArray(directory) && directory.length > 0) {
            await loadDirectory(directory[0]);
        }
    } catch (error) {
        console.error('Error opening folder:', error);
        folderPath.textContent = `Open folder failed: ${String(error)}`;
    }
});

// Load directory files
async function loadDirectory(dirPath) {
    try {
        state.folderLoadToken += 1;
        state.thumbnailQueue = [];
        metadataFilterCache.clear();
        embeddedJsonPresenceCache.clear();

        const files = await invoke('list_directory_files', { dirPath });
        state.allFolderFiles = files;
        folderPath.textContent = dirPath;

        await applyFolderFilters();
    } catch (error) {
        console.error('Error loading directory:', error);
        folderPath.textContent = 'Error loading directory';
    }
}

function renderFileList(files) {
    fileList.innerHTML = '';

    if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'file-list-empty';
        empty.textContent = 'No files match the current filters.';
        fileList.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of files) {
        addFileToList(file, fragment);
    }
    fileList.appendChild(fragment);
}

// Add file to list with thumbnail
function addFileToList(filePath, parent = fileList) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = filePath;
    
    const fileName = filePath.split(/[\\/]/).pop();
    const ext = getExtension(filePath);
    
    if (IMAGE_EXTS.has(ext)) {
        const img = document.createElement('img');
        img.className = 'file-thumbnail';
        img.alt = fileName;
        item.appendChild(img);
        thumbnailObserver.observe(item);
    } else {
        item.appendChild(createFileIcon(ext));
    }
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'file-name';
    nameDiv.textContent = fileName;
    nameDiv.title = fileName;
    item.appendChild(nameDiv);
    
    item.addEventListener('click', () => {
        selectFileInList(filePath);
        loadFileMetadata(filePath);
    });
    
    parent.appendChild(item);
}

async function loadImageThumbnail(item, filePath) {
    try {
        const img = item.querySelector('.file-thumbnail');
        if (!img) {
            return;
        }

        const thumbnailData = await invoke('get_thumbnail', {
            filePath,
            maxSize: 64
        });
        img.src = thumbnailData;
    } catch (error) {
        const ext = getExtension(filePath);
        const img = item.querySelector('.file-thumbnail');
        if (img) {
            img.remove();
        }
        item.prepend(createFileIcon(ext));
        console.error('Error generating thumbnail:', error);
    }
}

function enqueueThumbnailLoad(item, filePath, token) {
    state.thumbnailQueue.push({ item, filePath, token });
    drainThumbnailQueue();
}

function drainThumbnailQueue() {
    while (state.thumbnailActiveCount < THUMBNAIL_CONCURRENCY && state.thumbnailQueue.length > 0) {
        const job = state.thumbnailQueue.shift();
        if (!job) {
            return;
        }

        // Skip stale jobs created for an older folder listing.
        if (job.token !== state.folderLoadToken || !job.item.isConnected) {
            continue;
        }

        state.thumbnailActiveCount += 1;
        loadImageThumbnail(job.item, job.filePath)
            .finally(() => {
                state.thumbnailActiveCount -= 1;
                drainThumbnailQueue();
            });
    }
}

function selectFileInList(filePath) {
    document.querySelectorAll('.file-item').forEach((i) => i.classList.remove('selected'));
    const item = fileList.querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
    if (item) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
    }
}

async function getMetadataFilterData(filePath, options = {}) {
    const includeExif = Boolean(options.includeExif);
    const cached = metadataFilterCache.get(filePath);
    if (cached && (!includeExif || cached.hasExif != null)) {
        return cached;
    }

    try {
        const info = await invoke('get_file_filter_info', { filePath, includeExif });
        const data = {
            searchBlob: String(info.search_text || '').toLowerCase(),
            hasExif: info.has_exif == null ? null : Boolean(info.has_exif),
            fileSize: Number(info.file_size || 0),
            modifiedTimestamp: info.modified_timestamp == null ? null : Number(info.modified_timestamp),
            duration: info.duration == null ? null : Number(info.duration),
            resolution: info.width != null && info.height != null
                ? Number(info.width) * Number(info.height)
                : null,
        };

        metadataFilterCache.set(filePath, data);
        evictCacheIfNeeded(metadataFilterCache);
        return data;
    } catch (_error) {
        const fallback = cached || {
            searchBlob: '',
            hasExif: null,
            fileSize: 0,
            modifiedTimestamp: null,
            duration: null,
            resolution: null,
        };
        metadataFilterCache.set(filePath, fallback);
        evictCacheIfNeeded(metadataFilterCache);
        return fallback;
    }
}

async function hasEmbeddedJsonEntries(filePath) {
    if (embeddedJsonPresenceCache.has(filePath)) {
        return embeddedJsonPresenceCache.get(filePath);
    }

    const ext = getExtension(filePath);
    if (ext !== 'png' && ext !== 'mp3' && ext !== 'flac' && !VIDEO_EXTS.has(ext)) {
        embeddedJsonPresenceCache.set(filePath, false);
        evictCacheIfNeeded(embeddedJsonPresenceCache);
        return false;
    }

    try {
        const hasAny = Boolean(await invoke('has_embedded_json', { filePath }));
        embeddedJsonPresenceCache.set(filePath, hasAny);
        evictCacheIfNeeded(embeddedJsonPresenceCache);
        return hasAny;
    } catch (_error) {
        embeddedJsonPresenceCache.set(filePath, false);
        evictCacheIfNeeded(embeddedJsonPresenceCache);
        return false;
    }
}

async function filterWithAsyncPredicate(files, token, predicate, concurrency = 4) {
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

function sortFiles(files, sortBy, sortDirection) {
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

async function applyFolderFilters() {
    const token = ++state.folderFilterToken;
    const previousSelected = state.selectedFile;

    let filtered = [...state.allFolderFiles];
    const nameTerm = (fileNameFilter.value || '').trim().toLowerCase();
    const metadataTerm = (metadataWordFilter.value || '').trim().toLowerCase();
    const typeFilter = fileTypeFilter.value || 'all';
    const mediaOnly = mediaOnlyToggle.checked;
    const embeddedOnly = Boolean(hasEmbeddedJsonOnly?.checked);
    const exifOnly = Boolean(hasExifOnly?.checked);
    const sortBy = sortByFilter?.value || 'name';
    const sortDirection = sortDirectionFilter?.value || 'asc';

    if (nameTerm) {
        filtered = filtered.filter((filePath) => {
            const fileName = filePath.split(/[\\/]/).pop() || '';
            return fileName.toLowerCase().includes(nameTerm);
        });
    }

    if (typeFilter !== 'all') {
        filtered = filtered.filter((filePath) => fileKindByPath(filePath) === typeFilter);
    }

    if (mediaOnly) {
        filtered = filtered.filter((filePath) => MEDIA_EXTS.has(getExtension(filePath)));
    }

    const checkToken = () => {
        if (token !== state.folderFilterToken) {
            return true;
        }
        return false;
    };

    const needsMetadata = metadataTerm.length > 0 || exifOnly || sortBy !== 'name';

    if (needsMetadata) {
        folderFilterStatus.textContent = 'Loading metadata...';
        await filterWithAsyncPredicate(
            filtered,
            token,
            async (filePath) => {
                await getMetadataFilterData(filePath, { includeExif: exifOnly });
                return true;
            },
            5
        );
        if (checkToken()) {
            return;
        }
    }

    if (metadataTerm) {
        folderFilterStatus.textContent = 'Scanning metadata...';
        filtered = await filterWithAsyncPredicate(filtered, token, async (filePath) => {
            const data = await getMetadataFilterData(filePath, { includeExif: exifOnly });
            return data.searchBlob.includes(metadataTerm);
        });
        if (checkToken()) {
            return;
        }
    }

    if (exifOnly) {
        filtered = filtered.filter((filePath) => metadataFilterCache.get(filePath)?.hasExif === true);
    }

    if (embeddedOnly) {
        folderFilterStatus.textContent = 'Scanning embedded JSON...';
        filtered = await filterWithAsyncPredicate(filtered, token, async (filePath) => {
            return hasEmbeddedJsonEntries(filePath);
        });
        if (checkToken()) {
            return;
        }
    }

    sortFiles(filtered, sortBy, sortDirection);

    state.currentFiles = filtered;
    renderFileList(filtered);

    if (state.allFolderFiles.length === 0) {
        folderFilterStatus.textContent = '';
    } else {
        folderFilterStatus.textContent = `Showing ${filtered.length} of ${state.allFolderFiles.length} files`;
    }

    if (filtered.length === 0) {
        state.selectedFile = null;
        return;
    }

    const nextFile = filtered.includes(previousSelected) ? previousSelected : filtered[0];
    selectFileInList(nextFile);
    if (nextFile !== previousSelected) {
        await loadFileMetadata(nextFile);
    }
}

function scheduleFolderFilterApply() {
    if (state.folderFilterDebounceTimer !== null) {
        clearTimeout(state.folderFilterDebounceTimer);
    }

    state.folderFilterDebounceTimer = window.setTimeout(() => {
        applyFolderFilters();
    }, 220);
}

function spdxLicenseUrl(license) {
    if (!license || license === 'UNKNOWN') {
        return '';
    }
    const first = String(license)
        .split(/\s+OR\s+|\s+AND\s+|\//i)[0]
        .replace(/[()]/g, '')
        .trim();
    if (!first) {
        return '';
    }
    return `https://spdx.org/licenses/${encodeURIComponent(first)}.html`;
}

function renderLicensesTable(rows) {
    licensesTableBody.innerHTML = '';

    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'licenses-empty';
        td.textContent = 'No licenses match the current filters.';
        tr.appendChild(td);
        licensesTableBody.appendChild(tr);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of rows) {
        const tr = document.createElement('tr');

        const libCell = document.createElement('td');
        libCell.textContent = `${item.name} (${item.ecosystem})`;

        const versionCell = document.createElement('td');
        versionCell.textContent = item.version || '';

        const licenseCell = document.createElement('td');
        const licenseText = item.license || 'UNKNOWN';
        const spdxUrl = spdxLicenseUrl(licenseText);
        if (spdxUrl) {
            const link = document.createElement('a');
            link.href = spdxUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.textContent = licenseText;
            licenseCell.appendChild(link);
        } else {
            licenseCell.textContent = licenseText;
        }

        const authorCell = document.createElement('td');
        authorCell.textContent = item.author || '';

        const linksCell = document.createElement('td');
        const linksWrap = document.createElement('span');
        linksWrap.className = 'licenses-link-list';

        if (item.homepage) {
            const homepage = document.createElement('a');
            homepage.href = item.homepage;
            homepage.target = '_blank';
            homepage.rel = 'noreferrer';
            homepage.textContent = 'Homepage';
            linksWrap.appendChild(homepage);
        }

        linksCell.appendChild(linksWrap);

        tr.appendChild(libCell);
        tr.appendChild(versionCell);
        tr.appendChild(licenseCell);
        tr.appendChild(authorCell);
        tr.appendChild(linksCell);
        fragment.appendChild(tr);
    }

    licensesTableBody.appendChild(fragment);
}

function applyLicensesFilters() {
    const search = (licensesSearchInput?.value || '').trim().toLowerCase();
    const ecosystem = licensesEcosystemFilter?.value || 'all';

    const filtered = state.licenseInventory.filter((item) => {
        if (ecosystem !== 'all' && item.ecosystem !== ecosystem) {
            return false;
        }

        if (!search) {
            return true;
        }

        const haystack = `${item.name} ${item.version} ${item.license} ${item.author} ${item.homepage}`.toLowerCase();
        return haystack.includes(search);
    });

    renderLicensesTable(filtered);
    licensesMeta.textContent = `Showing ${filtered.length} of ${state.licenseInventory.length} dependencies.`;
}

async function ensureLicensesLoaded() {
    if (state.licensesLoaded) {
        return;
    }

    const response = await fetch('/third-party-licenses.json');
    if (!response.ok) {
        throw new Error(`Failed to load license data (${response.status})`);
    }

    const payload = await response.json();
    state.licenseInventory = Array.isArray(payload.items) ? payload.items : [];
    state.licensesGeneratedAt = payload.generatedAt || 'unknown';
    state.licensesLoaded = true;
    licensesMeta.textContent = `Generated ${payload.generatedAt || 'unknown'}. Found ${state.licenseInventory.length} dependencies.`;
}

function buildNoticesText() {
    const ecosystemCounts = new Map();
    const grouped = new Map();

    for (const item of state.licenseInventory) {
        const ecosystem = item.ecosystem || 'unknown';
        const license = item.license || 'UNKNOWN';
        const key = `${ecosystem}::${license}`;

        ecosystemCounts.set(ecosystem, (ecosystemCounts.get(ecosystem) || 0) + 1);

        if (!grouped.has(key)) {
            grouped.set(key, { ecosystem, license, items: [] });
        }

        grouped.get(key).items.push(item);
    }

    const lines = [];
    lines.push('CharBrowser Third-Party Notices');
    lines.push('=================================');
    lines.push('');
    lines.push(`Generated: ${state.licensesGeneratedAt}`);
    lines.push(`Total dependencies: ${state.licenseInventory.length}`);
    lines.push('');

    const ecosystems = [...ecosystemCounts.keys()].sort((a, b) => a.localeCompare(b));
    lines.push('By ecosystem:');
    for (const ecosystem of ecosystems) {
        lines.push(`- ${ecosystem}: ${ecosystemCounts.get(ecosystem)}`);
    }
    lines.push('');

    const groups = [...grouped.values()].sort((a, b) => {
        if (a.ecosystem !== b.ecosystem) {
            return a.ecosystem.localeCompare(b.ecosystem);
        }
        return a.license.localeCompare(b.license);
    });

    for (const group of groups) {
        lines.push(`[${group.ecosystem}] License: ${group.license} (${group.items.length})`);

        group.items.sort((a, b) => a.name.localeCompare(b.name));
        for (const dep of group.items) {
            const version = dep.version ? ` v${dep.version}` : '';
            const author = dep.author ? ` | ${dep.author}` : '';
            lines.push(`  - ${dep.name}${version}${author}`);
        }

        lines.push('');
    }

    return lines.join('\n');
}

function initFolderFilters() {
    if (
        !fileNameFilter
        || !fileTypeFilter
        || !mediaOnlyToggle
        || !metadataWordFilter
        || !hasEmbeddedJsonOnly
        || !hasExifOnly
        || !sortByFilter
        || !sortDirectionFilter
    ) {
        return;
    }

    fileNameFilter.addEventListener('input', scheduleFolderFilterApply);
    metadataWordFilter.addEventListener('input', scheduleFolderFilterApply);
    fileTypeFilter.addEventListener('change', () => applyFolderFilters());
    mediaOnlyToggle.addEventListener('change', () => applyFolderFilters());
    hasEmbeddedJsonOnly.addEventListener('change', () => applyFolderFilters());
    hasExifOnly.addEventListener('change', () => applyFolderFilters());
    sortByFilter.addEventListener('change', () => applyFolderFilters());
    sortDirectionFilter.addEventListener('change', () => applyFolderFilters());
}

async function openNoticesInViewer() {
    await ensureLicensesLoaded(licensesMeta);
    showDocumentViewer('Third-Party Notices', buildNoticesText());
}

function showDocumentViewer(title, text) {
    if (!docViewerModal || !docViewerTitle || !docViewerContent) {
        return;
    }

    docViewerTitle.textContent = title;
    docViewerContent.textContent = text;
    docViewerModal.style.display = 'flex';
}

async function openBundledTextDocument(path, title) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`Failed to open ${title.toLowerCase()} (${response.status})`);
    }

    const text = await response.text();
    showDocumentViewer(title, text);
}

async function openLicensePopupLink(anchor) {
    const href = anchor.getAttribute('href') || '';
    if (!href) {
        return;
    }

    if (anchor.id === 'openNoticesFileLink') {
        await openNoticesInViewer();
        return;
    }

    const absolute = new URL(href, window.location.origin).toString();
    await invoke('open_url_in_system_browser', { url: absolute });
}

function initLicensesModal() {
    if (!showLicensesBtn || !licensesModal || !closeLicensesBtn) {
        return;
    }

    showLicensesBtn.addEventListener('click', async () => {
        licensesModal.style.display = 'flex';
        licensesMeta.textContent = 'Loading license inventory...';

        try {
            await ensureLicensesLoaded(licensesMeta);
            applyLicensesFilters(licensesSearchInput, licensesEcosystemFilter, licensesMeta, licensesTableBody);
        } catch (error) {
            licensesMeta.textContent = `Failed to load licenses: ${String(error)}`;
            renderLicensesTable([]);
        }
    });

    closeLicensesBtn.addEventListener('click', () => {
        licensesModal.style.display = 'none';
    });

    closeDocViewerBtn?.addEventListener('click', () => {
        if (docViewerModal) {
            docViewerModal.style.display = 'none';
        }
    });

    licensesModal.addEventListener('click', (event) => {
        if (event.target === licensesModal) {
            licensesModal.style.display = 'none';
            return;
        }

        const anchor = event.target.closest('a[href]');
        if (!anchor) {
            return;
        }

        event.preventDefault();
        openLicensePopupLink(anchor).catch((error) => {
            licensesMeta.textContent = `Failed to open link: ${String(error)}`;
        });
    });

    docViewerModal?.addEventListener('click', (event) => {
        if (event.target === docViewerModal) {
            docViewerModal.style.display = 'none';
        }
    });

    licensesSearchInput?.addEventListener('input', () => applyLicensesFilters(licensesSearchInput, licensesEcosystemFilter, licensesMeta, licensesTableBody));
    licensesEcosystemFilter?.addEventListener('change', () => applyLicensesFilters(licensesSearchInput, licensesEcosystemFilter, licensesMeta, licensesTableBody));
}

function isTextEditingContext() {
    const active = document.activeElement;
    if (!active) {
        return false;
    }

    if (active === embeddedJsonTextFilter) {
        return true;
    }

    if (active.isContentEditable) {
        return true;
    }

    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function selectFileByOffset(offset) {
    if (!Array.isArray(state.currentFiles) || state.currentFiles.length === 0) {
        return;
    }

    let index = state.currentFiles.indexOf(state.selectedFile);
    if (index === -1) {
        index = offset > 0 ? -1 : 0;
    }

    const nextIndex = Math.min(state.currentFiles.length - 1, Math.max(0, index + offset));
    const nextFile = state.currentFiles[nextIndex];
    if (!nextFile || nextFile === state.selectedFile) {
        return;
    }

    selectFileInList(nextFile);
    fileList.focus();
    loadFileMetadata(nextFile);
}

function initKeyboardNavigation() {
    document.addEventListener('keydown', (event) => {
        if (jsonDiffModal.style.display === 'flex') {
            return;
        }

        if (isTextEditingContext()) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectFileByOffset(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectFileByOffset(-1);
        }
    });
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function initResizableLayout() {
    const root = document.documentElement;
    const mainContainer = document.querySelector('.main-container');
    const metadataViewElement = metadataView;

    if (!sidebarSplitter || !metadataSplitter || !mainContainer || !metadataViewElement) {
        return;
    }

    sidebarSplitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        sidebarSplitter.classList.add('dragging');
        document.body.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        sidebarSplitter.setPointerCapture(event.pointerId);

        const containerRect = mainContainer.getBoundingClientRect();
        const maxWidth = Math.floor(containerRect.width * SIDEBAR_MAX_RATIO);
        const next = clamp(event.clientX - containerRect.left, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, maxWidth));
        root.style.setProperty('--sidebar-width', `${next}px`);
    });

    sidebarSplitter.addEventListener('pointermove', (event) => {
        if (!sidebarSplitter.classList.contains('dragging')) {
            return;
        }

        const containerRect = mainContainer.getBoundingClientRect();
        const maxWidth = Math.floor(containerRect.width * SIDEBAR_MAX_RATIO);
        const next = clamp(event.clientX - containerRect.left, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, maxWidth));
        root.style.setProperty('--sidebar-width', `${next}px`);
    });

    const stopSidebarDrag = () => {
        sidebarSplitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
    };

    sidebarSplitter.addEventListener('pointerup', stopSidebarDrag);
    sidebarSplitter.addEventListener('pointercancel', stopSidebarDrag);

    metadataSplitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        metadataSplitter.classList.add('dragging');
        document.body.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        metadataSplitter.setPointerCapture(event.pointerId);

        const viewRect = metadataViewElement.getBoundingClientRect();
        const bottomDistance = viewRect.bottom - event.clientY;
        const maxHeight = Math.floor(viewRect.height * METADATA_MAX_RATIO);
        const next = clamp(bottomDistance, METADATA_MIN, Math.max(METADATA_MIN, maxHeight));
        root.style.setProperty('--metadata-height', `${next}px`);
    });

    metadataSplitter.addEventListener('pointermove', (event) => {
        if (!metadataSplitter.classList.contains('dragging')) {
            return;
        }

        const viewRect = metadataViewElement.getBoundingClientRect();
        const bottomDistance = viewRect.bottom - event.clientY;
        const maxHeight = Math.floor(viewRect.height * METADATA_MAX_RATIO);
        const next = clamp(bottomDistance, METADATA_MIN, Math.max(METADATA_MIN, maxHeight));
        root.style.setProperty('--metadata-height', `${next}px`);
    });

    const stopMetadataDrag = () => {
        metadataSplitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
    };

    metadataSplitter.addEventListener('pointerup', stopMetadataDrag);
    metadataSplitter.addEventListener('pointercancel', stopMetadataDrag);
}

// Create file icon based on extension
function createFileIcon(ext) {
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    
    const icons = {
        'mp4': '🎬',
        'mov': '🎬',
        'avi': '🎬',
        'mkv': '🎬',
        'mp3': '🎵',
        'wav': '🎵',
        'flac': '🎵',
        'ogg': '🎵',
        'm4a': '🎵',
    };
    
    icon.textContent = icons[ext] || '📄';
    return icon;
}

// Load and display file metadata
async function loadFileMetadata(filePath) {
    const requestToken = ++state.metadataLoadToken;
    try {
        state.selectedFile = filePath;
        const metadata = await invoke('get_file_metadata', { filePath });
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }

        const ext = getExtension(filePath);
        
        // Hide drop zone, show metadata view
        dropZone.style.display = 'none';
        metadataView.style.display = 'flex';

        await updatePreview(filePath, ext, requestToken);
        if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
            return;
        }
        
        // Display metadata
        displayMetadata(metadata);
        await loadEmbeddedBase64Json(filePath, ext);
    } catch (error) {
        console.error('Error loading metadata:', error);
    }
}

async function loadEmbeddedBase64Json(filePath, ext) {
    state.embeddedJsonEntries = [];
    state.filteredEmbeddedJsonEntries = [];
    embeddedJsonSection.style.display = 'none';
    embeddedJsonSelect.innerHTML = '';
    embeddedJsonPayloadLabel.textContent = 'Payload';
    embeddedJsonPayloadPreview.textContent = '';
    embeddedJsonTree.innerHTML = '';
    currentEditableJson = null;
    embeddedJsonStatus.textContent = '';
    embeddedJsonFormatFilter.value = 'all';
    embeddedJsonTextFilter.value = '';
    updateCharacterTextPanel(null, null);

    if (ext !== 'png' && ext !== 'mp3' && ext !== 'flac' && !VIDEO_EXTS.has(ext)) {
        return;
    }

    try {
        const entries = await invoke('get_embedded_base64_json_entries', { filePath });
        if (state.selectedFile !== filePath) {
            return;
        }

        if (!entries || entries.length === 0) {
            embeddedJsonStatus.textContent = 'No embedded base64 JSON entries found.';
            embeddedJsonSection.style.display = 'flex';
            return;
        }

        state.embeddedJsonEntries = entries;
        const narrative = extractNarrativeFieldsFromEntries(entries);
        updateCharacterTextPanel(narrative.description, narrative.firstMes);
        embeddedJsonSection.style.display = 'flex';
        applyEmbeddedJsonFilters();
    } catch (error) {
        embeddedJsonSection.style.display = 'flex';
        embeddedJsonStatus.textContent = `Error reading embedded JSON: ${String(error)}`;
    }
}

function applyEmbeddedJsonFilters() {
    const formatFilter = embeddedJsonFormatFilter.value || 'all';
    const textFilter = (embeddedJsonTextFilter.value || '').trim().toLowerCase();

    state.filteredEmbeddedJsonEntries = state.embeddedJsonEntries.filter((entry) => {
        if (formatFilter !== 'all' && (entry.payload_format || 'base64') !== formatFilter) {
            return false;
        }

        if (!textFilter) {
            return true;
        }

        const haystack = `${entry.chunk_type} ${entry.label}`.toLowerCase();
        return haystack.includes(textFilter);
    });

    const previouslySelected = Number(embeddedJsonSelect.value);
    embeddedJsonSelect.innerHTML = '';

    for (const entry of state.filteredEmbeddedJsonEntries) {
        const option = document.createElement('option');
        option.value = String(entry.id);
        option.textContent = `${entry.chunk_type} - ${entry.label} [${entry.payload_format || 'base64'}]`;
        embeddedJsonSelect.appendChild(option);
    }

    if (state.filteredEmbeddedJsonEntries.length === 0) {
        embeddedJsonPayloadLabel.textContent = 'Payload';
        embeddedJsonPayloadPreview.textContent = '';
        embeddedJsonTree.innerHTML = '';
        currentEditableJson = null;
        embeddedJsonStatus.textContent = 'No embedded JSON entries match the current filters.';
        return;
    }

    const selectedStillVisible = state.filteredEmbeddedJsonEntries.some((e) => e.id === previouslySelected);
    const selectedId = selectedStillVisible ? previouslySelected : state.filteredEmbeddedJsonEntries[0].id;
    embeddedJsonSelect.value = String(selectedId);
    renderEmbeddedJsonEntry(selectedId);
    embeddedJsonStatus.textContent = '';
}

let currentEditableJson = null;

function renderEmbeddedJsonEntry(entryIdRaw) {
    const entryId = Number(entryIdRaw);
    const entry = state.embeddedJsonEntries.find((item) => item.id === entryId);
    if (!entry) {
        embeddedJsonPayloadPreview.textContent = '';
        embeddedJsonTree.innerHTML = '';
        currentEditableJson = null;
        return;
    }

    const payloadText = entry.payload ?? entry.base64;
    embeddedJsonPayloadPreview.textContent = payloadText.slice(0, 200) + (payloadText.length > 200 ? '...' : '');
    embeddedJsonPayloadLabel.textContent = `Payload (${entry.payload_format || 'base64'}) - ${payloadText.length} chars`;

    try {
        currentEditableJson = JSON.parse(entry.decoded_json);
        embeddedJsonTree.innerHTML = '';
        const treeNode = buildJsonTreeNode(currentEditableJson, null);
        embeddedJsonTree.appendChild(treeNode);
    } catch (e) {
        embeddedJsonTree.innerHTML = `<div style="color: #ff6b6b;">Invalid JSON: ${e.message}</div>`;
        currentEditableJson = null;
    }
}

function buildJsonTreeNode(value, key) {
    const node = document.createElement('div');
    node.className = 'json-tree-node';

    const row = document.createElement('div');
    row.className = 'json-tree-row';

    if (key !== null) {
        const toggle = document.createElement('span');
        toggle.className = 'json-tree-toggle';

        const keySpan = document.createElement('span');
        keySpan.className = 'json-tree-key';
        keySpan.textContent = typeof key === 'number' ? `[${key}]` : `"${key}"`;

        const colon = document.createElement('span');
        colon.className = 'json-tree-colon';
        colon.textContent = ': ';

        if (value !== null && typeof value === 'object') {
            const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
            toggle.textContent = isEmpty ? (Array.isArray(value) ? '[]' : '{}') : (Array.isArray(value) ? '▼' : '▼');
            toggle.addEventListener('click', () => {
                const children = node.querySelector(':scope > .json-tree-children');
                if (children) {
                    children.classList.toggle('expanded');
                    toggle.textContent = children.classList.contains('expanded')
                        ? (Array.isArray(value) ? '▼' : '▼')
                        : (Array.isArray(value) ? '▶' : '▶');
                }
            });
            row.appendChild(toggle);
            row.appendChild(keySpan);
            row.appendChild(colon);

            const valueSpan = document.createElement('span');
            valueSpan.className = `json-tree-value ${Array.isArray(value) ? 'array' : 'object'}`;
            valueSpan.textContent = Array.isArray(value)
                ? `[${value.length}]`
                : `{${Object.keys(value).length}}`;
            row.appendChild(valueSpan);
        } else {
            toggle.textContent = ' ';
            row.appendChild(toggle);
            row.appendChild(keySpan);
            row.appendChild(colon);

            const valueSpan = document.createElement('span');
            const isEditable = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
            valueSpan.className = `json-tree-value ${typeof value}`;
            if (isEditable) {
                valueSpan.classList.add('editable');
                valueSpan.contentEditable = 'true';
                valueSpan.textContent = formatJsonValue(value);
                valueSpan.spellcheck = false;

                valueSpan.addEventListener('blur', () => syncTreeToJson(node, key, valueSpan));
                valueSpan.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        valueSpan.blur();
                    }
                    if (e.key === 'Escape') {
                        valueSpan.textContent = formatJsonValue(value);
                        valueSpan.blur();
                    }
                });
            } else if (value === null) {
                valueSpan.textContent = 'null';
            }
            row.appendChild(valueSpan);
        }
    } else {
        row.appendChild(document.createTextNode(''));
    }

    node.appendChild(row);

    if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
        const children = document.createElement('div');
        children.className = 'json-tree-children expanded';

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                children.appendChild(buildJsonTreeNode(item, index));
            });
        } else {
            Object.entries(value).forEach(([k, v]) => {
                children.appendChild(buildJsonTreeNode(v, k));
            });
        }

        const lastRow = children.lastElementChild;
        if (lastRow) {
            const comma = document.createElement('span');
            comma.className = 'json-tree-comma';
            comma.textContent = ',';
            lastRow.querySelector('.json-tree-row').appendChild(comma);
        }

        node.appendChild(children);
    }

    return node;
}

function formatJsonValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === null) {
        return 'null';
    }
    return String(value);
}

function syncTreeToJson(node, key, valueSpan) {
    if (!currentEditableJson) return;

    try {
        let parsedValue = valueSpan.textContent;
        if (parsedValue === 'null') {
            parsedValue = null;
        } else if (parsedValue === 'true') {
            parsedValue = true;
        } else if (parsedValue === 'false') {
            parsedValue = false;
        } else if (!isNaN(parsedValue) && parsedValue.trim() !== '') {
            parsedValue = Number(parsedValue);
        }

        setNestedValue(currentEditableJson, node, key, parsedValue);
        valueSpan.classList.remove('error');
        embeddedJsonStatus.textContent = '';
    } catch (e) {
        valueSpan.classList.add('error');
        embeddedJsonStatus.textContent = `Parse error: ${e.message}`;
    }
}

function setNestedValue(obj, node, key, value) {
    const path = [];
    let current = node;

    while (current && current.classList.contains('json-tree-node')) {
        const row = current.querySelector(':scope > .json-tree-row');
        if (!row) break;

        const keyEl = row.querySelector('.json-tree-key');
        if (keyEl) {
            const keyText = keyEl.textContent;
            if (keyText.startsWith('[')) {
                path.unshift(parseInt(keyText.slice(1, -1), 10));
            } else {
                path.unshift(keyText.slice(1, -1));
            }
        }

        current = current.parentElement?.closest('.json-tree-node');
    }

    let target = obj;
    for (let i = 0; i < path.length - 1; i++) {
        target = target[path[i]];
    }
    target[path.length > 0 ? path[path.length - 1] : key] = value;
}

function getJsonFromTree() {
    return currentEditableJson;
}

embeddedJsonSelect.addEventListener('change', () => {
    renderEmbeddedJsonEntry(embeddedJsonSelect.value);
    embeddedJsonStatus.textContent = '';
});

embeddedJsonFormatFilter.addEventListener('change', () => {
    applyEmbeddedJsonFilters();
});

embeddedJsonTextFilter.addEventListener('input', () => {
    applyEmbeddedJsonFilters();
});

saveEmbeddedJsonBtn.addEventListener('click', async () => {
    if (!state.selectedFile || state.embeddedJsonEntries.length === 0) {
        return;
    }

    const entryId = Number(embeddedJsonSelect.value);
    const jsonObj = getJsonFromTree();
    embeddedJsonStatus.textContent = '';

    if (!jsonObj) {
        embeddedJsonStatus.textContent = 'Cannot save: invalid JSON in tree view.';
        return;
    }

    const jsonText = JSON.stringify(jsonObj, null, 2);

    try {
        const entry = state.embeddedJsonEntries.find((item) => item.id === entryId);
        if (!entry) {
            embeddedJsonStatus.textContent = 'Selected entry not found.';
            return;
        }

        const prettyOriginal = normalizeJsonText(entry.decoded_json);
        const prettyEdited = jsonText;
        const summary = buildJsonDiffSummary(prettyOriginal, prettyEdited);

        state.pendingEmbeddedJsonSave = {
            filePath: state.selectedFile,
            entryId,
            jsonText: prettyEdited,
        };

        jsonDiffOriginal.textContent = prettyOriginal;
        jsonDiffEdited.textContent = prettyEdited;
        jsonDiffSummary.textContent = summary;
        jsonDiffModal.style.display = 'flex';
    } catch (error) {
        embeddedJsonStatus.textContent = `Diff preparation failed: ${String(error)}`;
    }
});

confirmJsonSaveBtn.addEventListener('click', async () => {
    if (!state.pendingEmbeddedJsonSave) {
        jsonDiffModal.style.display = 'none';
        return;
    }

    const payload = state.pendingEmbeddedJsonSave;
    state.pendingEmbeddedJsonSave = null;
    jsonDiffModal.style.display = 'none';

    try {
        await invoke('update_embedded_base64_json', payload);
        embeddedJsonStatus.textContent = 'Saved successfully.';
        await loadFileMetadata(payload.filePath);
    } catch (error) {
        embeddedJsonStatus.textContent = `Save failed: ${String(error)}`;
    }
});

cancelJsonSaveBtn.addEventListener('click', () => {
    state.pendingEmbeddedJsonSave = null;
    jsonDiffModal.style.display = 'none';
    embeddedJsonStatus.textContent = 'Save canceled.';
});

function normalizeJsonText(text) {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
}

function buildJsonDiffSummary(originalText, editedText) {
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

function flattenJson(value, prefix = '', out = new Map()) {
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

function updateCharacterTextPanel(description, firstMes) {
    const hasDescription = typeof description === 'string' && description.trim().length > 0;
    const hasFirstMes = typeof firstMes === 'string' && firstMes.trim().length > 0;

    if (!hasDescription && !hasFirstMes) {
        characterTextPanel.style.display = 'none';
        characterDescription.textContent = '';
        characterFirstMes.textContent = '';
        return;
    }

    characterTextPanel.style.display = 'flex';
    characterDescription.textContent = hasDescription ? description.trim() : 'Not available';
    characterFirstMes.textContent = hasFirstMes ? firstMes.trim() : 'Not available';
}

function normalizeFieldKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectNarrativeFields(value, out) {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectNarrativeFields(item, out);
        }
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeFieldKey(key);
        if (typeof child === 'string') {
            const text = child.trim();
            if (text.length > 0) {
                if (!out.description && normalized === 'description') {
                    out.description = text;
                }
                if (!out.firstMes && normalized === 'firstmes') {
                    out.firstMes = text;
                }
            }
        } else {
            collectNarrativeFields(child, out);
        }
    }
}

function extractNarrativeFieldsFromEntries(entries) {
    const out = {
        description: null,
        firstMes: null,
    };

    for (const entry of entries) {
        if (out.description && out.firstMes) {
            break;
        }

        try {
            const parsed = JSON.parse(entry.decoded_json);
            collectNarrativeFields(parsed, out);
        } catch {
            // Ignore non-JSON decoded payloads.
        }
    }

    return out;
}

function waitForVideoReady(videoElement, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let settled = false;

        const finalize = (ok) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(ok);
        };

        const onLoadedMetadata = () => finalize(true);
        const onError = () => finalize(false);
        const cleanup = () => {
            videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
            videoElement.removeEventListener('error', onError);
            clearTimeout(timer);
        };

        const timer = setTimeout(() => {
            // If metadata arrived before timeout, readyState will be at least HAVE_METADATA.
            finalize(videoElement.readyState >= HTMLMediaElement.HAVE_METADATA);
        }, timeoutMs);

        videoElement.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        videoElement.addEventListener('error', onError, { once: true });
    });
}

async function updatePreview(filePath, ext, requestToken) {
    if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
        return;
    }

    preview.style.display = 'none';
    preview.removeAttribute('src');
    videoPreview.style.display = 'none';
    videoPreview.pause();
    videoPreview.removeAttribute('src');
    videoPreview.load();
    audioPreview.style.display = 'none';
    audioPreview.pause();
    audioPreview.removeAttribute('src');
    noPreview.textContent = 'No preview available';
    noPreview.style.display = 'none';

    if (IMAGE_EXTS.has(ext)) {
        try {
            const largePreview = await invoke('get_thumbnail', {
                filePath,
                maxSize: 1600
            });
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            preview.src = largePreview;
            preview.style.display = 'block';
            return;
        } catch (error) {
            console.error('Failed to load image preview:', error);
        }
    }

    if (VIDEO_EXTS.has(ext)) {
        try {
            const videoSrc = await invoke('get_video_data_url', {
                filePath,
                maxBytes: 80 * 1024 * 1024,
            });
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            videoPreview.src = videoSrc;
            videoPreview.style.display = 'block';
            videoPreview.load();

            const isReady = await waitForVideoReady(videoPreview, 5000);
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            if (!isReady) {
                videoPreview.pause();
                videoPreview.style.display = 'none';
                noPreview.textContent = 'Video preview unavailable for this file (unsupported codec/container).';
                noPreview.style.display = 'block';
            }
        } catch (error) {
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }

            videoPreview.pause();
            videoPreview.style.display = 'none';
            noPreview.textContent = `Video preview unavailable: ${String(error)}`;
            noPreview.style.display = 'block';
        }
        return;
    }

    if (AUDIO_EXTS.has(ext)) {
        let audioLoaded = false;

        try {
            const audioSrc = await invoke('get_audio_data_url', {
                filePath,
                maxBytes: 80 * 1024 * 1024,
            });
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            audioPreview.src = audioSrc;
            audioPreview.style.display = 'block';
            audioPreview.load();
            audioLoaded = true;
        } catch (error) {
            audioPreview.style.display = 'none';
            audioPreview.removeAttribute('src');
        }

        try {
            const cover = await invoke('get_audio_cover', {
                filePath,
                maxSize: 1200
            });
            if (requestToken !== state.metadataLoadToken || state.selectedFile !== filePath) {
                return;
            }
            preview.src = cover;
            preview.style.display = 'block';
        } catch (error) {
            preview.style.display = 'none';
            preview.removeAttribute('src');
        }

        if (!audioLoaded) {
            noPreview.textContent = 'No audio preview available';
            noPreview.style.display = 'block';
        }
        return;
    }

    noPreview.style.display = 'block';
}

// Display metadata in the panel
function displayMetadata(metadata) {
    metadataContent.innerHTML = '';
    const selectedExt = state.selectedFile ? getExtension(state.selectedFile) : '';
    
    // Basic information
    addMetadataRow('File Name', metadata.file_name);
    addMetadataRow('File Path', metadata.file_path);
    addMetadataRow('File Size', formatFileSize(metadata.file_size));
    addMetadataRow('File Type', metadata.file_type);
    
    // Dimensions
    if (metadata.width != null && metadata.height != null) {
        addMetadataRow('Dimensions', `${metadata.width} × ${metadata.height}`);
    }
    
    // Duration
    if (metadata.duration != null) {
        addMetadataRow('Duration', formatDuration(metadata.duration));
    }
    
    // Audio properties
    if (metadata.sample_rate != null) {
        addMetadataRow('Sample Rate', `${metadata.sample_rate} Hz`);
    }
    if (metadata.channels != null) {
        addMetadataRow('Channels', metadata.channels);
    }
    if (metadata.bit_rate != null) {
        addMetadataRow('Bit Rate', `${metadata.bit_rate} kbps`);
    }

    const exifHighlights = getExifHighlights(metadata.format_specific);
    if (exifHighlights.length > 0) {
        const section = document.createElement('div');
        section.className = 'metadata-section';

        const heading = document.createElement('h3');
        heading.textContent = 'EXIF Highlights';
        section.appendChild(heading);

        metadataContent.appendChild(section);

        for (const [label, value] of exifHighlights) {
            addMetadataRowToContainer(section, label, value);
        }
    }
    
    // Format specific metadata
    if (metadata.format_specific && Object.keys(metadata.format_specific).length > 0) {
        const section = document.createElement('div');
        section.className = 'metadata-section';
        
        const heading = document.createElement('h3');
        heading.textContent = 'Additional Information';
        section.appendChild(heading);
        
        metadataContent.appendChild(section);
        
        displayFormatSpecific(metadata.format_specific, section);
    }

    if (selectedExt === 'avi' || selectedExt === 'mkv') {
        const notice = document.createElement('div');
        notice.className = 'metadata-video-json-notice';
        notice.textContent = 'Note: AVI/MKV embedded JSON edits must keep payload length unchanged to avoid container corruption.';
        metadataContent.appendChild(notice);
    }
}

// Add metadata row
function addMetadataRow(label, value) {
    const row = document.createElement('div');
    row.className = 'metadata-row';
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'metadata-label';
    labelDiv.textContent = label;
    
    const valueDiv = document.createElement('div');
    valueDiv.className = 'metadata-value';
    valueDiv.textContent = value || 'N/A';
    
    row.appendChild(labelDiv);
    row.appendChild(valueDiv);
    metadataContent.appendChild(row);
}

function addMetadataRowToContainer(container, label, value) {
    const row = document.createElement('div');
    row.className = 'metadata-row';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'metadata-label';
    labelDiv.textContent = label;

    const valueDiv = document.createElement('div');
    valueDiv.className = 'metadata-value';
    valueDiv.textContent = value || 'N/A';

    row.appendChild(labelDiv);
    row.appendChild(valueDiv);
    container.appendChild(row);
}

function getExifHighlights(formatSpecific) {
    if (!formatSpecific || typeof formatSpecific !== 'object') {
        return [];
    }

    const exif = formatSpecific.exif;
    if (!exif || typeof exif !== 'object') {
        return [];
    }

    const preferred = [
        ['Captured', ['datetimeoriginal', 'datetime']],
        ['Camera Make', ['make']],
        ['Camera Model', ['model']],
        ['Lens', ['lensmodel', 'lensmake']],
        ['Focal Length', ['focallength']],
        ['F-Number', ['fnumber']],
        ['Exposure', ['exposuretime']],
        ['ISO', ['photographicsensitivity', 'isospeedratings']],
        ['GPS', ['gpslatitude', 'gpslongitude']],
    ];

    const allEntries = Object.entries(exif)
        .map(([key, value]) => [String(key), String(value)])
        .filter(([, value]) => value.trim().length > 0);

    const used = new Set();
    const result = [];

    for (const [label, needles] of preferred) {
        const match = allEntries.find(([key]) => {
            const lower = key.toLowerCase();
            if (used.has(key)) {
                return false;
            }
            return needles.some((needle) => lower.includes(needle));
        });

        if (match) {
            used.add(match[0]);
            result.push([label, match[1]]);
        }
    }

    return result;
}

// Display format-specific metadata recursively
function displayFormatSpecific(obj, container) {
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const subSection = document.createElement('div');
            subSection.className = 'metadata-section';
            const heading = document.createElement('h3');
            heading.textContent = key;
            subSection.appendChild(heading);
            container.appendChild(subSection);
            displayFormatSpecific(value, subSection);
        } else {
            const row = document.createElement('div');
            row.className = 'metadata-row';
            
            const labelDiv = document.createElement('div');
            labelDiv.className = 'metadata-label';
            labelDiv.textContent = key;
            
            const valueDiv = document.createElement('div');
            valueDiv.className = 'metadata-value';
            valueDiv.textContent = String(value);
            
            row.appendChild(labelDiv);
            row.appendChild(valueDiv);
            container.appendChild(row);
        }
    }
}

// Format file size
function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// Format duration
function formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Handle drag and drop
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        dropZone.classList.remove('drag-over');
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-over');
});

// Listen for drag/drop events from the current webview.
getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type === 'over' || event.payload.type === 'enter') {
        dropZone.classList.add('drag-over');
        return;
    }

    if (event.payload.type === 'leave') {
        dropZone.classList.remove('drag-over');
        return;
    }

    if (event.payload.type === 'drop') {
        dropZone.classList.remove('drag-over');
        const files = event.payload.paths;
        if (files && files.length > 0) {
            await loadFileMetadata(files[0]);
        }
    }
}).catch((error) => {
    console.error('Failed to register drag-drop listener:', error);
});

initKeyboardNavigation();
initResizableLayout();
initFolderFilters();
initLicensesModal();

console.log('CharBrowser initialized');
