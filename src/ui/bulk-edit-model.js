/**
 * Pure presentation helpers for the bulk-edit modal.
 *
 * No DOM access here: precedence rules, request payload shapes, and result
 * summaries are plain data so they can be unit-tested directly.
 */

const STATUS_RANK = {
    supported: 0,
    noop: 1,
    unsupported: 2,
    error: 3,
};

const EMPTY_VALUE = '∅';

/**
 * Ranks a capability status. Unknown statuses are treated as errors so a
 * malformed row can never look green.
 * @param {string} status
 * @returns {number}
 */
export function capabilityStatusRank(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
        ? STATUS_RANK[status]
        : STATUS_RANK.error;
}

/**
 * Picks the most severe status from a list: error > unsupported > noop > supported.
 * @param {string[]} statuses
 * @returns {string}
 */
export function combineCapabilityStatuses(statuses) {
    if (!Array.isArray(statuses) || statuses.length === 0) {
        return 'supported';
    }

    return statuses.reduce((worst, status) => (
        capabilityStatusRank(status) > capabilityStatusRank(worst) ? status : worst
    ), 'supported');
}

/**
 * Resolves the display status of one capability row.
 * A row without a known format or without a format-compatible operation is an error.
 * @param {{status?: string, operations?: string[]} | null} row
 * @returns {string}
 */
export function resolveCapabilityStatus(row) {
    if (!row) {
        return 'error';
    }
    if (typeof row.status === 'string' && row.status.length > 0) {
        return row.status;
    }
    const operations = Array.isArray(row.operations) ? row.operations : [];
    return operations.length === 0 ? 'error' : 'unsupported';
}

/**
 * Summarizes a capability response.
 * @param {{files?: Array<object>, operations?: Array<object>} | null} response
 * @returns {{total: number, supported: number, unsupported: number, noop: number, error: number, overallStatus: string, operations: Array<object>}}
 */
export function summarizeCapabilities(response) {
    const files = Array.isArray(response?.files) ? response.files : [];
    const counts = { supported: 0, unsupported: 0, noop: 0, error: 0 };
    const statuses = [];

    for (const row of files) {
        const status = resolveCapabilityStatus(row);
        statuses.push(status);
        counts[status] = (counts[status] || 0) + 1;
    }

    return {
        total: files.length,
        ...counts,
        overallStatus: combineCapabilityStatuses(statuses),
        operations: Array.isArray(response?.operations) ? response.operations : [],
    };
}

/**
 * Finds the capability entry for an operation key.
 * @param {{operations?: Array<object>} | null} capabilities
 * @param {string} key
 * @returns {object | null}
 */
export function findOperation(capabilities, key) {
    const operations = Array.isArray(capabilities?.operations) ? capabilities.operations : [];
    return operations.find((operation) => operation?.operation === key) || null;
}

/**
 * Whether the selected operation needs a "Field / keyword" input.
 * Unknown operations keep the requirement so the modal never plans blind.
 * @param {{operations?: Array<object>} | null} capabilities
 * @param {string} key
 * @returns {boolean}
 */
export function operationRequiresLocator(capabilities, key) {
    const operation = findOperation(capabilities, key);
    return operation ? operation.requires_locator !== false : true;
}

/**
 * Whether the selected operation needs a "New value" input.
 * @param {{operations?: Array<object>} | null} capabilities
 * @param {string} key
 * @returns {boolean}
 */
export function operationRequiresValue(capabilities, key) {
    const operation = findOperation(capabilities, key);
    return operation ? operation.requires_value !== false : true;
}

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function fileNameOf(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

/**
 * Flattens the `existing_fields` of every capability row into one list,
 * optionally restricted to the writer whose locator input accepts the field.
 * Malformed entries are skipped: discovery data never breaks rendering.
 * @param {{files?: Array<object>} | null} capabilities
 * @param {string} [operation] Writer key, e.g. `fits_set_keyword`; empty for all.
 * @returns {Array<{operation: string, locator: string, value: string, file: string, fileName: string, fileKey: string}>}
 */
export function collectExistingFields(capabilities, operation = '') {
    const rows = Array.isArray(capabilities?.files) ? capabilities.files : [];
    const wanted = String(operation || '');
    const fields = [];

    rows.forEach((row, index) => {
        const discovered = Array.isArray(row?.existing_fields) ? row.existing_fields : [];
        const file = String(row?.file || '');
        const fileName = String(row?.file_name || '') || fileNameOf(file);
        const fileKey = file || `row-${index}`;

        for (const field of discovered) {
            if (!field || typeof field.locator !== 'string' || field.locator.length === 0) {
                continue;
            }
            const fieldOperation = String(field.operation || '');
            if (wanted && fieldOperation !== wanted) {
                continue;
            }
            fields.push({
                operation: fieldOperation,
                locator: field.locator,
                value: String(field.value ?? ''),
                file,
                fileName,
                fileKey,
            });
        }
    });

    return fields;
}

/**
 * Groups discovered locators across the selected files: identical values
 * collapse into one entry with a file count, distinct values stay separate.
 * Locators are sorted by codepoint (then operation) so the list is stable
 * regardless of selection or locale.
 * @param {{files?: Array<object>} | null} capabilities
 * @param {string} [operation]
 * @returns {Array<{operation: string, locator: string, fileCount: number, values: Array<{value: string, count: number}>}>}
 */
export function groupExistingFields(capabilities, operation = '') {
    const groups = new Map();

    for (const field of collectExistingFields(capabilities, operation)) {
        const key = `${field.operation}\u0000${field.locator}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                operation: field.operation,
                locator: field.locator,
                counts: new Map(),
                files: new Set(),
            };
            groups.set(key, group);
        }
        group.counts.set(field.value, (group.counts.get(field.value) || 0) + 1);
        group.files.add(field.fileKey);
    }

    return Array.from(groups.values())
        .map((group) => ({
            operation: group.operation,
            locator: group.locator,
            fileCount: group.files.size,
            values: Array.from(group.counts, ([value, count]) => ({ value, count }))
                .sort((a, b) => b.count - a.count || compareText(a.value, b.value)),
        }))
        .sort((a, b) => compareText(a.locator, b.locator) || compareText(a.operation, b.operation));
}

/**
 * Formats discovered values as they appear on disk, e.g. `'M31' (2), 'M42' (1)`.
 * Counts are omitted when the locator occurs in a single file with one value.
 * @param {Array<{value: string, count: number}>} values
 * @returns {string}
 */
export function formatExistingFieldValues(values) {
    const list = Array.isArray(values) ? values : [];
    if (list.length === 0) {
        return '';
    }

    const total = list.reduce((sum, entry) => sum + (Number(entry?.count) || 0), 0);
    const withCounts = total > 1;

    return list.map((entry) => {
        const raw = String(entry?.value ?? '');
        const text = raw === '' ? EMPTY_VALUE : raw;
        return withCounts ? `${text} (${Number(entry?.count) || 0})` : text;
    }).join(', ');
}

/**
 * One-line description of a grouped locator for the picker row title.
 * @param {{locator?: string, values?: Array<{value: string, count: number}>} | null} group
 * @returns {string}
 */
export function formatExistingFieldSummary(group) {
    if (!group) {
        return '';
    }
    return `${String(group.locator || '')}: ${formatExistingFieldValues(group.values)}`;
}

/**
 * Builds the exact `plan_bulk_edit` invoke argument.
 * Paths are sorted to match the backend's deterministic plan ordering.
 * @param {Iterable<string>} paths
 * @param {{operation: string, locator: string, value: string}} params
 * @returns {{request: {paths: string[], params: {operation: string, locator: string, value: string}}}}
 */
export function buildPlanPayload(paths, params = {}) {
    const list = Array.from(paths || [], String).sort();
    return {
        request: {
            paths: list,
            params: {
                operation: String(params.operation || ''),
                locator: String(params.locator ?? '').trim(),
                value: String(params.value ?? ''),
            },
        },
    };
}

/**
 * Builds the exact `apply_bulk_edit` invoke argument.
 * The plan object is passed verbatim so apply replays what was reviewed.
 * @param {object} plan
 * @returns {{plan: object}}
 */
export function buildApplyPayload(plan) {
    return { plan };
}

/**
 * True when a plan contains at least one file that would be mutated.
 * @param {{files?: Array<{status?: string}>} | null} plan
 * @returns {boolean}
 */
export function planHasChanges(plan) {
    const files = Array.isArray(plan?.files) ? plan.files : [];
    return files.some((file) => file.status === 'changed');
}

/**
 * Formats one planned change as "old → new".
 * @param {{old_value?: string|null, new_value?: string|null}} change
 * @returns {string}
 */
export function formatChange(change) {
    if (!change) {
        return '';
    }
    const oldValue = change.old_value == null ? EMPTY_VALUE : String(change.old_value);
    const newValue = change.new_value == null ? EMPTY_VALUE : String(change.new_value);
    return `${oldValue} → ${newValue}`;
}

/**
 * Formats every change of one planned file for the review table.
 * @param {{changes?: Array<object>} | null} plannedFile
 * @returns {string}
 */
export function formatPlannedChanges(plannedFile) {
    const changes = Array.isArray(plannedFile?.changes) ? plannedFile.changes : [];
    if (changes.length === 0) {
        return '—';
    }
    return changes.map((change) => `${change.locator}: ${formatChange(change)}`).join('; ');
}

function isNoopReason(reason) {
    const text = String(reason || '').toLowerCase();
    return text.includes('noop') || text.includes('already match');
}

/**
 * Summarizes an apply result into counts, a headline, and per-file lines.
 * @param {{results?: Array<object>, applied?: number, skipped?: number, failed?: number, journal_path?: string|null, journal_degraded?: boolean} | null} result
 * @returns {{total: number, applied: number, skipped: number, failed: number, noop: number, hasFailures: boolean, summaryLine: string, lines: string[], journalPath: string|null, journalDegraded: boolean}}
 */
export function summarizeApplyResults(result) {
    const results = Array.isArray(result?.results) ? result.results : [];
    const countBy = (status) => results.filter((entry) => entry.status === status).length;

    const applied = Number.isInteger(result?.applied) ? result.applied : countBy('applied');
    const skipped = Number.isInteger(result?.skipped) ? result.skipped : countBy('skipped');
    const failed = Number.isInteger(result?.failed) ? result.failed : countBy('failed');
    const noop = results.filter((entry) => entry.status === 'skipped' && isNoopReason(entry.reason)).length;

    const lines = results.map((entry) => {
        const name = String(entry.file || '').split(/[\\/]/).pop() || String(entry.file || '');
        const reason = entry.reason ? `: ${entry.reason}` : '';
        return `${name} — ${entry.status}${reason}`;
    });

    const noopNote = noop > 0 ? ` (${noop} no-op)` : '';
    const summaryLine = `${applied} applied, ${skipped} skipped${noopNote}, ${failed} failed`;

    return {
        total: results.length,
        applied,
        skipped,
        failed,
        noop,
        hasFailures: failed > 0,
        summaryLine,
        lines,
        journalPath: result?.journal_path || null,
        journalDegraded: Boolean(result?.journal_degraded),
    };
}
