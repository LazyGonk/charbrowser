import { dom } from '../dom.js';
import { state } from '../state.js';
import { openUrlInSystemBrowser } from '../services/tauri-api.js';

/**
 * Builds SPDX license URL from license expression.
 * @param {string} license
 * @returns {string}
 */
export function spdxLicenseUrl(license) {
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

/**
 * Renders dependency/license rows in modal table.
 * @param {Array<any>} rows
 */
export function renderLicensesTable(rows) {
    dom.licensesTableBody.innerHTML = '';

    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'licenses-empty';
        td.textContent = 'No licenses match the current filters.';
        tr.appendChild(td);
        dom.licensesTableBody.appendChild(tr);
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

    dom.licensesTableBody.appendChild(fragment);
}

/**
 * Applies search/ecosystem filters to loaded license inventory.
 */
export function applyLicensesFilters() {
    const search = (dom.licensesSearchInput?.value || '').trim().toLowerCase();
    const ecosystem = dom.licensesEcosystemFilter?.value || 'all';

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
    dom.licensesMeta.textContent = `Showing ${filtered.length} of ${state.licenseInventory.length} dependencies.`;
}

/**
 * Loads third-party license inventory JSON once per session.
 */
export async function ensureLicensesLoaded() {
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
    dom.licensesMeta.textContent = `Generated ${payload.generatedAt || 'unknown'}. Found ${state.licenseInventory.length} dependencies.`;
}

/**
 * Builds grouped notices text for the in-app doc viewer.
 * @returns {string}
 */
export function buildNoticesText() {
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

/**
 * Displays plain text content in reusable modal document viewer.
 * @param {string} title
 * @param {string} text
 */
export function showDocumentViewer(title, text) {
    if (!dom.docViewerModal || !dom.docViewerTitle || !dom.docViewerContent) {
        return;
    }

    dom.docViewerTitle.textContent = title;
    dom.docViewerContent.textContent = text;
    dom.docViewerModal.style.display = 'flex';
}

/**
 * Opens generated notices text in document viewer modal.
 */
export async function openNoticesInViewer() {
    await ensureLicensesLoaded();
    showDocumentViewer('Third-Party Notices', buildNoticesText());
}

/**
 * Opens popup links from license modal via in-app viewer or system browser.
 * @param {HTMLAnchorElement} anchor
 */
export async function openLicensePopupLink(anchor) {
    const href = anchor.getAttribute('href') || '';
    if (!href) {
        return;
    }

    if (anchor.id === 'openNoticesFileLink') {
        await openNoticesInViewer();
        return;
    }

    const absolute = new URL(href, window.location.origin).toString();
    await openUrlInSystemBrowser(absolute);
}

/**
 * Initializes all licenses modal interactions.
 */
export function initLicensesModal() {
    if (!dom.showLicensesBtn || !dom.licensesModal || !dom.closeLicensesBtn) {
        return;
    }

    dom.showLicensesBtn.addEventListener('click', async () => {
        dom.licensesModal.style.display = 'flex';
        dom.licensesMeta.textContent = 'Loading license inventory...';

        try {
            await ensureLicensesLoaded();
            applyLicensesFilters();
        } catch (error) {
            dom.licensesMeta.textContent = `Failed to load licenses: ${String(error)}`;
            renderLicensesTable([]);
        }
    });

    dom.closeLicensesBtn.addEventListener('click', () => {
        dom.licensesModal.style.display = 'none';
    });

    dom.closeDocViewerBtn?.addEventListener('click', () => {
        if (dom.docViewerModal) {
            dom.docViewerModal.style.display = 'none';
        }
    });

    dom.licensesModal.addEventListener('click', (event) => {
        if (event.target === dom.licensesModal) {
            dom.licensesModal.style.display = 'none';
            return;
        }

        const anchor = event.target.closest('a[href]');
        if (!anchor) {
            return;
        }

        event.preventDefault();
        openLicensePopupLink(anchor).catch((error) => {
            dom.licensesMeta.textContent = `Failed to open link: ${String(error)}`;
        });
    });

    dom.docViewerModal?.addEventListener('click', (event) => {
        if (event.target === dom.docViewerModal) {
            dom.docViewerModal.style.display = 'none';
        }
    });

    dom.licensesSearchInput?.addEventListener('input', () => applyLicensesFilters());
    dom.licensesEcosystemFilter?.addEventListener('change', () => applyLicensesFilters());
}
