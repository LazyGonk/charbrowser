/**
 * Bulk-edit modal: capability matrix, plan review, apply confirmation, results.
 *
 * The modal is the only place a bulk plan is created or applied. It holds the
 * backend-returned plan object and sends it back verbatim, so what Apply sends
 * is exactly what the user reviewed.
 */

import { dom } from '../dom.js';
import { state } from '../state.js';
import { applyBulkEdit, getBulkEditCapabilities, planBulkEdit } from '../services/tauri-api.js';
import {
    buildApplyPayload,
    buildPlanPayload,
    findOperation,
    formatExistingFieldSummary,
    formatExistingFieldValues,
    formatPlannedChanges,
    groupExistingFields,
    operationRequiresLocator,
    operationRequiresValue,
    planHasChanges,
    resolveCapabilityStatus,
    summarizeApplyResults,
    summarizeCapabilities,
} from './bulk-edit-model.js';
import {
    bulkSelectedList,
    clearBulkSelection,
    selectAllBulkSelection,
} from './bulk-selection.js';

const modalState = {
    paths: [],
    capabilities: null,
    plan: null,
    results: null,
    busy: false,
    picked: null,
    capabilitiesError: null,
};

let onAppliedHandler = () => {};

/**
 * Resolver of the in-modal apply confirmation currently waiting for a click.
 * Only one prompt can be open: requesting another cancels the previous one.
 * @type {((confirmed: boolean) => void) | null}
 */
let pendingApplyResolver = null;

/**
 * Wires the bulk-edit toolbar button and modal controls.
 * @param {{onApplied?: () => void}} [hooks]
 */
export function initBulkEditModal(hooks = {}) {
    onAppliedHandler = typeof hooks.onApplied === 'function' ? hooks.onApplied : () => {};

    dom.bulkEditBtn?.addEventListener('click', () => {
        void openBulkEditModal();
    });
    dom.bulkEditCloseBtn?.addEventListener('click', closeBulkEditModal);
    dom.bulkEditPlanBtn?.addEventListener('click', () => {
        void handlePlan();
    });
    dom.bulkEditApplyBtn?.addEventListener('click', () => {
        void handleApply();
    });
    dom.bulkEditConfirmApplyBtn?.addEventListener('click', () => {
        settleApplyConfirmation(true);
    });
    dom.bulkEditCancelApplyBtn?.addEventListener('click', () => {
        settleApplyConfirmation(false);
    });
    dom.bulkEditClearSelectionBtn?.addEventListener('click', () => {
        clearBulkSelection(state);
        refreshBulkEditButton();
        closeBulkEditModal();
    });
    dom.bulkEditSelectAllBtn?.addEventListener('click', () => {
        selectAllBulkSelection(state, state.currentFiles);
        refreshBulkEditButton();
        void openBulkEditModal();
    });

    [dom.bulkEditOperation, dom.bulkEditLocator, dom.bulkEditValue].forEach((element) => {
        element?.addEventListener('input', invalidatePlan);
        element?.addEventListener('change', invalidatePlan);
    });
    dom.bulkEditOperation?.addEventListener('change', syncParamInputs);
    dom.bulkEditOperation?.addEventListener('change', renderExistingFields);
    dom.bulkEditDiscovery?.addEventListener('click', handleDiscoveryClick);

    refreshBulkEditButton();
}

/**
 * Refreshes the toolbar button label and enabled state, and syncs the
 * sidebar's select-all and row checkboxes with the shared selection set.
 */
export function refreshBulkEditButton() {
    if (!dom.bulkEditBtn) {
        return;
    }
    const count = state.bulkSelectedPaths.size;
    dom.bulkEditBtn.textContent = `🧺 Bulk Edit (${count})`;
    dom.bulkEditBtn.disabled = count === 0;
    syncFileSelectionControls();
}

function syncFileSelectionControls() {
    const list = dom.fileList;
    if (!list) {
        return;
    }

    const visible = Array.isArray(state.currentFiles) ? state.currentFiles : [];
    const selectedVisible = visible.filter((filePath) => state.bulkSelectedPaths.has(filePath)).length;

    const selectAll = list.querySelector('.file-select-all-checkbox');
    if (selectAll) {
        selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
        selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
        selectAll.disabled = visible.length === 0;
    }

    list.querySelectorAll('.file-select-checkbox').forEach((checkbox) => {
        const filePath = checkbox.closest('.file-item')?.dataset.path;
        if (filePath) {
            checkbox.checked = state.bulkSelectedPaths.has(filePath);
        }
    });
}

/**
 * Opens the modal for the current bulk selection.
 */
export async function openBulkEditModal() {
    const paths = bulkSelectedList(state);
    if (paths.length === 0 || !dom.bulkEditModal) {
        return;
    }

    modalState.paths = paths;
    modalState.capabilities = null;
    modalState.plan = null;
    modalState.results = null;
    modalState.busy = false;
    modalState.picked = null;
    modalState.capabilitiesError = null;

    resetControls();
    hideApplyConfirmation();
    dom.bulkEditModal.style.display = 'flex';
    dom.bulkEditModal.setAttribute('aria-hidden', 'false');
    renderStatus(`Checking capabilities for ${paths.length} file(s)...`);
    renderSummary('');
    renderResults(null);
    renderTableRows([]);
    renderExistingFields();

    try {
        const response = await getBulkEditCapabilities(paths);
        modalState.capabilities = response;
        populateOperations(response?.operations || []);
        renderCapabilities();
    } catch (error) {
        modalState.capabilitiesError = errorMessage(error);
        renderStatus(`Capability check failed: ${modalState.capabilitiesError}`);
    } finally {
        renderExistingFields();
        updateControlState();
    }
}

/**
 * Closes the modal without discarding the selection.
 */
export function closeBulkEditModal() {
    if (!dom.bulkEditModal) {
        return;
    }
    hideApplyConfirmation();
    dom.bulkEditModal.style.display = 'none';
    dom.bulkEditModal.setAttribute('aria-hidden', 'true');
}

/**
 * Shows the apply confirmation bar inside the bulk-edit modal and resolves
 * once the user confirms or cancels. Requesting a new prompt cancels the
 * previous one so no resolver is left dangling.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function requestApplyConfirmation(message) {
    settleApplyConfirmation(false);
    if (!dom.bulkEditConfirm) {
        return Promise.resolve(false);
    }
    if (dom.bulkEditConfirmMessage) {
        dom.bulkEditConfirmMessage.textContent = message;
    }
    dom.bulkEditConfirm.style.display = 'flex';
    return new Promise((resolve) => {
        pendingApplyResolver = resolve;
    });
}

/**
 * Hides the confirmation bar and resolves the pending prompt with `confirmed`.
 * @param {boolean} confirmed
 */
function settleApplyConfirmation(confirmed) {
    const resolve = pendingApplyResolver;
    pendingApplyResolver = null;
    if (dom.bulkEditConfirm) {
        dom.bulkEditConfirm.style.display = 'none';
    }
    if (resolve) {
        resolve(Boolean(confirmed));
    }
}

/**
 * Cancels a pending confirmation without applying anything.
 */
function hideApplyConfirmation() {
    settleApplyConfirmation(false);
}

async function handlePlan() {
    if (modalState.busy) {
        return;
    }

    const params = readParams();
    if (!params.operation) {
        renderStatus('Choose an operation first.');
        return;
    }
    if (operationRequiresLocator(modalState.capabilities, params.operation) && !params.locator) {
        renderStatus('Enter the field, JSON path, or keyword to change.');
        return;
    }

    modalState.busy = true;
    modalState.plan = null;
    modalState.results = null;
    hideApplyConfirmation();
    renderResults(null);
    updateControlState();
    renderStatus('Planning...');

    try {
        const plan = await planBulkEdit(buildPlanPayload(modalState.paths, params));
        modalState.plan = plan;
        renderPlan(plan);
        const usable = planHasChanges(plan);
        renderStatus(usable
            ? `Plan ${shortPlanId(plan)} ready. Apply revalidates every file first.`
            : `Plan ${shortPlanId(plan)} has no files to change.`);
    } catch (error) {
        renderStatus(`Planning failed: ${errorMessage(error)}`);
    } finally {
        modalState.busy = false;
        updateControlState();
    }
}

async function handleApply() {
    const plan = modalState.plan;
    if (!plan || modalState.busy || !planHasChanges(plan)) {
        return;
    }

    const changed = (plan.files || []).filter((file) => file.status === 'changed').length;
    const confirmed = await requestApplyConfirmation(
        `Apply the reviewed plan to ${changed} file(s)? Files edited since planning are rejected, not overwritten.`
    );
    if (!confirmed) {
        return;
    }

    modalState.busy = true;
    updateControlState();
    renderStatus('Applying...');

    try {
        const result = await applyBulkEdit(buildApplyPayload(plan));
        // The plan is spent: keep the results, but require a fresh plan before
        // another apply so the reviewed object cannot be replayed blindly.
        modalState.plan = null;
        modalState.results = result;
        renderResults(result);
        if (Number(result?.applied) > 0) {
            onAppliedHandler();
        }
    } catch (error) {
        renderStatus(`Apply rejected: ${errorMessage(error)}`);
    } finally {
        modalState.busy = false;
        updateControlState();
    }
}

function invalidatePlan() {
    hideApplyConfirmation();
    const hadPlan = Boolean(modalState.plan || modalState.results);
    modalState.plan = null;
    modalState.results = null;
    if (hadPlan) {
        renderResults(null);
        renderStatus('Operation inputs changed. Plan again to review the new batch.');
    }
    updateControlState();
}

function readParams() {
    return {
        operation: dom.bulkEditOperation?.value || '',
        locator: dom.bulkEditLocator?.value || '',
        value: dom.bulkEditValue?.value || '',
    };
}

function resetControls() {
    if (dom.bulkEditOperation) {
        dom.bulkEditOperation.value = '';
    }
    if (dom.bulkEditLocator) {
        dom.bulkEditLocator.value = '';
    }
    if (dom.bulkEditValue) {
        dom.bulkEditValue.value = '';
    }
    updateControlState();
}

function populateOperations(operations) {
    if (!dom.bulkEditOperation) {
        return;
    }
    dom.bulkEditOperation.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = operations.length > 0
        ? 'Choose an operation...'
        : 'No operations available';
    dom.bulkEditOperation.appendChild(placeholder);

    for (const operation of operations) {
        const option = document.createElement('option');
        option.value = operation.operation;
        const stateLabel = operation.ready ? 'ready' : `deferred to stage ${operation.stage}`;
        option.textContent = `${operation.label} (${stateLabel})`;
        option.title = operation.reason || '';
        dom.bulkEditOperation.appendChild(option);
    }
}

function renderCapabilities() {
    const capabilities = modalState.capabilities;
    const summary = summarizeCapabilities(capabilities);
    renderSummary(
        `${summary.total} file(s): ${summary.supported} supported, `
        + `${summary.unsupported} unsupported, ${summary.error} error`
    );

    const rows = (capabilities?.files || []).map((row) => [
        row.file_name || row.file,
        resolveCapabilityStatus(row),
        '—',
        row.reason || '',
    ]);
    renderTableRows(rows);
    renderExistingFields();
    renderStatus('Pick an operation, then plan to see old and new values.');
}

/**
 * Renders the read-only discovery list: every existing locator in the
 * selection, its value(s), and how many files carry them. A clicked row
 * switches to its writer and fills the locator input.
 *
 * When an operation is selected but has no discovered fields (exif tags are
 * not discovered yet), the full list stays visible so the picker can still
 * switch writers instead of going blank.
 */
function renderExistingFields() {
    const container = dom.bulkEditDiscovery;
    if (!container) {
        return;
    }
    container.innerHTML = '';

    if (!modalState.capabilities) {
        renderDiscoverySummary('');
        const message = modalState.capabilitiesError
            ? `Existing fields unavailable: ${modalState.capabilitiesError}`
            : 'Discovering existing fields...';
        appendDiscoveryMessage(container, message);
        return;
    }

    const allGroups = groupExistingFields(modalState.capabilities);
    const selected = dom.bulkEditOperation?.value || '';
    const matching = selected
        ? allGroups.filter((group) => group.operation === selected)
        : [];
    const groups = matching.length > 0 ? matching : allGroups;

    if (groups.length === 0) {
        renderDiscoverySummary('');
        appendDiscoveryMessage(
            container,
            'No existing fields were found in the selected files.'
        );
        return;
    }

    for (const group of groups) {
        container.appendChild(buildDiscoveryRow(group));
    }
    renderDiscoverySummary(
        `${groups.length} field(s) in ${modalState.paths.length} selected file(s)`
    );
}

function appendDiscoveryMessage(container, text) {
    const message = document.createElement('div');
    message.className = 'bulk-edit-discovery-empty';
    message.textContent = text;
    container.appendChild(message);
}

function buildDiscoveryRow(group) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bulk-edit-discovery-row';
    if (modalState.picked
        && modalState.picked.operation === group.operation
        && modalState.picked.locator === group.locator) {
        row.classList.add('is-active');
    }
    row.dataset.operation = group.operation;
    row.dataset.locator = group.locator;
    row.title = formatExistingFieldSummary(group);

    const locator = document.createElement('span');
    locator.className = 'bulk-edit-discovery-locator';
    locator.textContent = group.locator;

    const values = document.createElement('span');
    values.className = 'bulk-edit-discovery-values';
    values.textContent = formatExistingFieldValues(group.values);

    const meta = document.createElement('span');
    meta.className = 'bulk-edit-discovery-meta';
    const files = `${group.fileCount} file${group.fileCount === 1 ? '' : 's'}`;
    meta.textContent = `${operationLabel(group.operation)} · ${files}`;

    row.setAttribute(
        'aria-label',
        `${formatExistingFieldSummary(group)} — ${operationLabel(group.operation)}, ${files}`
    );
    row.append(locator, values, meta);
    return row;
}

function handleDiscoveryClick(event) {
    const row = event.target?.closest?.('.bulk-edit-discovery-row');
    if (!row || !dom.bulkEditDiscovery?.contains(row)) {
        return;
    }
    activateExistingField(row.dataset.operation || '', row.dataset.locator || '');
}

/**
 * Applies a discovered row to the operation and locator inputs. Changing the
 * writer goes through the same sync path as a manual dropdown change, and any
 * reviewed plan is discarded because its params no longer match the inputs.
 */
function activateExistingField(operation, locator) {
    if (!locator) {
        return;
    }

    const hadPlan = Boolean(modalState.plan || modalState.results);
    if (dom.bulkEditOperation
        && operation
        && findOperation(modalState.capabilities, operation)
        && dom.bulkEditOperation.value !== operation) {
        dom.bulkEditOperation.value = operation;
    }
    syncParamInputs();

    if (dom.bulkEditLocator) {
        dom.bulkEditLocator.value = locator;
    }
    modalState.picked = { operation, locator };

    invalidatePlan();
    renderExistingFields();

    if (!hadPlan) {
        renderStatus(`Selected ${locator}. Enter a new value, then plan.`);
    }
}

function operationLabel(key) {
    return findOperation(modalState.capabilities, key)?.label || String(key || '');
}

function renderDiscoverySummary(text) {
    if (dom.bulkEditDiscoverySummary) {
        dom.bulkEditDiscoverySummary.textContent = text;
    }
}

function renderPlan(plan) {
    const files = Array.isArray(plan?.files) ? plan.files : [];
    const counts = { changed: 0, noop: 0, unsupported: 0, skipped: 0, error: 0 };
    for (const file of files) {
        counts[file.status] = (counts[file.status] || 0) + 1;
    }

    renderSummary(
        `${files.length} file(s): ${counts.changed} to change, ${counts.noop} no-op, `
        + `${counts.unsupported + counts.skipped} unsupported/skipped, ${counts.error} error`
    );

    const rows = files.map((file) => [
        fileName(file.file),
        file.status,
        formatPlannedChanges(file),
        file.reason || '',
    ]);
    renderTableRows(rows);
}

function renderResults(result) {
    if (!dom.bulkEditResults) {
        return;
    }
    dom.bulkEditResults.innerHTML = '';

    if (!result) {
        if (dom.bulkEditJournalPath) {
            dom.bulkEditJournalPath.textContent = '';
        }
        renderTableRows([]);
        return;
    }

    const summary = summarizeApplyResults(result);
    const headline = document.createElement('div');
    headline.className = 'bulk-edit-result-headline';
    headline.textContent = summary.summaryLine;
    dom.bulkEditResults.appendChild(headline);

    for (const line of summary.lines) {
        const row = document.createElement('div');
        row.className = 'bulk-edit-result-line';
        row.textContent = line;
        dom.bulkEditResults.appendChild(row);
    }

    if (summary.journalDegraded) {
        const warning = document.createElement('div');
        warning.className = 'bulk-edit-result-warning';
        warning.textContent = 'Journal could not be written; applied changes are still on disk.';
        dom.bulkEditResults.appendChild(warning);
    }

    if (dom.bulkEditJournalPath) {
        dom.bulkEditJournalPath.textContent = summary.journalPath
            ? `Journal: ${summary.journalPath}`
            : '';
    }

    const entries = Array.isArray(result?.results) ? result.results : [];
    renderTableRows(entries.map((entry) => [
        fileName(entry.file),
        entry.status,
        Number(entry.changes) > 0 ? `${entry.changes} change(s)` : '—',
        entry.reason || '',
    ]));

    renderStatus(
        summary.hasFailures
            ? `Finished with ${summary.failed} failure(s): ${summary.applied} applied, `
                + `${summary.skipped} skipped, ${summary.failed} failed. `
                + 'Nothing was rolled back automatically.'
            : `Applied to ${summary.applied} file(s) (${summary.skipped} skipped, ${summary.failed} failed).`,
        summary.hasFailures ? 'error' : 'success'
    );
}

function renderTableRows(rows) {
    if (!dom.bulkEditTableBody) {
        return;
    }
    dom.bulkEditTableBody.innerHTML = '';

    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'bulk-edit-empty';
        td.textContent = 'No files selected.';
        tr.appendChild(td);
        dom.bulkEditTableBody.appendChild(tr);
        return;
    }

    for (const [file, status, change, reason] of rows) {
        const tr = document.createElement('tr');
        tr.className = `bulk-edit-row bulk-edit-row-${status}`;
        for (const value of [file, status, change, reason]) {
            const td = document.createElement('td');
            td.textContent = value;
            tr.appendChild(td);
        }
        dom.bulkEditTableBody.appendChild(tr);
    }
}

function renderSummary(text) {
    if (dom.bulkEditSummary) {
        dom.bulkEditSummary.textContent = text;
    }
}

/**
 * Renders the modal status line.
 * @param {string} text
 * @param {''|'success'|'error'} [tone] Optional emphasis class.
 */
function renderStatus(text, tone = '') {
    if (!dom.bulkEditStatus) {
        return;
    }
    dom.bulkEditStatus.textContent = text;
    dom.bulkEditStatus.className = tone
        ? `folder-filter-status bulk-edit-status-${tone}`
        : 'folder-filter-status';
}

function selectedRequiresLocator() {
    return operationRequiresLocator(modalState.capabilities, dom.bulkEditOperation?.value || '');
}

function selectedRequiresValue() {
    return operationRequiresValue(modalState.capabilities, dom.bulkEditOperation?.value || '');
}

/**
 * Clears and disables the inputs an operation does not take, so a strip-only
 * batch cannot carry a stale field name into its plan.
 */
function syncParamInputs() {
    if (!selectedRequiresLocator() && dom.bulkEditLocator) {
        dom.bulkEditLocator.value = '';
    }
    if (!selectedRequiresValue() && dom.bulkEditValue) {
        dom.bulkEditValue.value = '';
    }
    updateControlState();
}

function updateControlState() {
    const busy = modalState.busy;
    const hasOperation = Boolean(dom.bulkEditOperation?.value);
    const hasPlan = Boolean(modalState.plan);
    const locatorRequired = selectedRequiresLocator();
    const valueRequired = selectedRequiresValue();

    if (dom.bulkEditOperation) {
        dom.bulkEditOperation.disabled = busy;
    }
    if (dom.bulkEditLocator) {
        dom.bulkEditLocator.disabled = busy || !locatorRequired;
    }
    if (dom.bulkEditValue) {
        dom.bulkEditValue.disabled = busy || !valueRequired;
    }
    if (dom.bulkEditPlanBtn) {
        dom.bulkEditPlanBtn.disabled = busy || !hasOperation;
    }
    if (dom.bulkEditApplyBtn) {
        dom.bulkEditApplyBtn.disabled = busy
            || !hasOperation
            || !hasPlan
            || !planHasChanges(modalState.plan);
    }
    if (dom.bulkEditClearSelectionBtn) {
        dom.bulkEditClearSelectionBtn.disabled = busy;
    }
}

function fileName(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function shortPlanId(plan) {
    const id = String(plan?.id || '');
    return id.slice(0, 12) || 'unknown';
}

function errorMessage(error) {
    return String(error?.message || error || 'unknown error');
}
