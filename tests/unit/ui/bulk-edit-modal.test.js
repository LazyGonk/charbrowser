import { beforeEach, describe, expect, it, vi } from 'vitest';

const { domElements, FakeElement } = vi.hoisted(() => {
    class FakeElement {
        constructor(tag = 'div') {
            this.tagName = String(tag).toUpperCase();
            this.style = { display: '' };
            this.listeners = new Map();
            this.children = [];
            this.value = '';
            this.disabled = false;
            this.textContent = '';
            this.className = '';
            this.title = '';
            this.dataset = {};
            this.classes = new Set();
            this.classList = {
                add: (...names) => names.forEach((name) => this.classes.add(name)),
                remove: (...names) => names.forEach((name) => this.classes.delete(name)),
                contains: (name) => this.classes.has(name),
            };
            this._html = '';
        }

        get innerHTML() {
            return this._html;
        }

        set innerHTML(value) {
            this._html = String(value);
            this.children = [];
        }

        addEventListener(type, listener) {
            if (!this.listeners.has(type)) {
                this.listeners.set(type, []);
            }
            this.listeners.get(type).push(listener);
        }

        dispatch(type, event = {}) {
            for (const listener of this.listeners.get(type) || []) {
                listener({ target: this, ...event });
            }
        }

        appendChild(child) {
            this.children.push(child);
            return child;
        }

        append(...children) {
            this.children.push(...children);
        }

        setAttribute(name, value) {
            this[name] = value;
        }

        querySelector() {
            return null;
        }

        querySelectorAll() {
            return [];
        }

        closest() {
            return null;
        }

        contains() {
            return false;
        }

        focus() {}
    }

    const keys = [
        'bulkEditBtn',
        'bulkEditModal',
        'bulkEditOperation',
        'bulkEditLocator',
        'bulkEditValue',
        'bulkEditDiscovery',
        'bulkEditDiscoverySummary',
        'bulkEditPlanBtn',
        'bulkEditApplyBtn',
        'bulkEditCloseBtn',
        'bulkEditClearSelectionBtn',
        'bulkEditSelectAllBtn',
        'bulkEditSummary',
        'bulkEditTableBody',
        'bulkEditStatus',
        'bulkEditResults',
        'bulkEditJournalPath',
        'bulkEditConfirm',
        'bulkEditConfirmMessage',
        'bulkEditConfirmApplyBtn',
        'bulkEditCancelApplyBtn',
        'fileList',
    ];

    const domElements = {};
    for (const key of keys) {
        domElements[key] = new FakeElement();
    }

    return { domElements, FakeElement };
});

vi.mock('../../../src/dom.js', () => ({ dom: domElements }));

vi.mock('../../../src/services/tauri-api.js', () => ({
    getBulkEditCapabilities: vi.fn(),
    planBulkEdit: vi.fn(),
    applyBulkEdit: vi.fn(),
}));

globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
};

const { getBulkEditCapabilities, planBulkEdit, applyBulkEdit } = await import('../../../src/services/tauri-api.js');
const { initBulkEditModal, openBulkEditModal, closeBulkEditModal } = await import('../../../src/ui/bulk-edit-modal.js');
const { state } = await import('../../../src/state.js');

const OPERATIONS = [
    {
        operation: 'json_set',
        label: 'Set JSON value',
        requires_locator: true,
        requires_value: true,
        ready: true,
    },
    {
        operation: 'strip_all',
        label: 'Strip all metadata',
        requires_locator: false,
        requires_value: false,
        ready: true,
    },
];

const CAPABILITIES = {
    files: [
        { file: '/tmp/a.json', file_name: 'a.json', status: 'supported', operations: ['json_set'] },
        { file: '/tmp/b.json', file_name: 'b.json', status: 'supported', operations: ['json_set'] },
    ],
    operations: OPERATIONS,
};

function makePlan(statuses = ['changed', 'noop']) {
    return {
        id: 'plan-0123456789abcdef',
        files: statuses.map((status, index) => ({
            file: index === 0 ? '/tmp/a.json' : '/tmp/b.json',
            status,
            changes: status === 'changed'
                ? [{ locator: 'Artist', old_value: 'old', new_value: 'new' }]
                : [],
            reason: status === 'changed' ? null : 'already up to date',
        })),
    };
}

const PLAN_CHANGED = makePlan(['changed', 'noop']);

const APPLY_RESULT = {
    plan_id: PLAN_CHANGED.id,
    results: [
        { file: '/tmp/a.json', status: 'applied', changes: 1, reason: null, journaled: true },
        { file: '/tmp/b.json', status: 'skipped', changes: 0, reason: 'already up to date' },
    ],
    applied: 1,
    skipped: 1,
    failed: 0,
    journal_path: '/tmp/journal.ndjson',
    journal_degraded: false,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openModal() {
    await openBulkEditModal();
    await flush();
}

function chooseOperation(value = 'json_set') {
    domElements.bulkEditOperation.value = value;
    domElements.bulkEditOperation.dispatch('change');
    domElements.bulkEditLocator.value = value === 'strip_all' ? '' : 'Artist';
    domElements.bulkEditValue.value = value === 'strip_all' ? '' : 'new';
}

async function planWith(plan) {
    planBulkEdit.mockResolvedValueOnce(plan);
    domElements.bulkEditPlanBtn.dispatch('click');
    await flush();
}

beforeEach(() => {
    vi.resetAllMocks();
    for (const key of Object.keys(domElements)) {
        domElements[key] = new FakeElement(key === 'fileList' ? 'ul' : 'div');
    }
    state.bulkSelectedPaths = new Set(['/tmp/a.json', '/tmp/b.json']);
    state.currentFiles = [];
    getBulkEditCapabilities.mockResolvedValue(CAPABILITIES);
    initBulkEditModal();
});

describe('bulk edit modal action gating', () => {
    it('keeps Plan and Apply disabled until an operation is selected', async () => {
        await openModal();

        expect(domElements.bulkEditPlanBtn.disabled).toBe(true);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);

        chooseOperation();

        expect(domElements.bulkEditPlanBtn.disabled).toBe(false);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);
    });

    it('keeps Apply disabled when the plan has no changed files', async () => {
        await openModal();
        chooseOperation();
        await planWith(makePlan(['noop', 'unsupported']));

        expect(planBulkEdit).toHaveBeenCalledTimes(1);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);
        expect(domElements.bulkEditStatus.textContent).toContain('has no files to change');
    });

    it('enables Apply once a plan changes at least one file', async () => {
        await openModal();
        chooseOperation();
        await planWith(PLAN_CHANGED);

        expect(domElements.bulkEditApplyBtn.disabled).toBe(false);
    });

    it('disables Plan and Apply while a plan is in flight', async () => {
        await openModal();
        chooseOperation();

        let resolvePlan;
        planBulkEdit.mockReturnValueOnce(new Promise((resolve) => {
            resolvePlan = resolve;
        }));
        domElements.bulkEditPlanBtn.dispatch('click');
        await flush();

        expect(domElements.bulkEditPlanBtn.disabled).toBe(true);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);

        resolvePlan(PLAN_CHANGED);
        await flush();

        expect(domElements.bulkEditPlanBtn.disabled).toBe(false);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(false);
    });

    it('disables Apply while an apply is in flight', async () => {
        await openModal();
        chooseOperation();
        await planWith(PLAN_CHANGED);

        let resolveApply;
        applyBulkEdit.mockReturnValueOnce(new Promise((resolve) => {
            resolveApply = resolve;
        }));

        domElements.bulkEditApplyBtn.dispatch('click');
        domElements.bulkEditConfirmApplyBtn.dispatch('click');
        await flush();

        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);

        resolveApply(APPLY_RESULT);
        await flush();

        // The applied plan is spent, so Apply stays disabled until a new plan.
        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);
    });
});

describe('bulk edit plan invalidation', () => {
    it.each([
        ['bulkEditOperation', ''],
        ['bulkEditLocator', 'Album'],
        ['bulkEditValue', 'different value'],
    ])('clears the reviewed plan when %s changes', async (key, value) => {
        await openModal();
        chooseOperation();
        domElements.bulkEditValue.value = 'new';
        domElements.bulkEditLocator.value = 'Artist';
        await planWith(PLAN_CHANGED);
        expect(domElements.bulkEditApplyBtn.disabled).toBe(false);

        domElements[key].value = value;
        domElements[key].dispatch('input');

        expect(domElements.bulkEditApplyBtn.disabled).toBe(true);
        expect(domElements.bulkEditConfirm.style.display).toBe('none');
        expect(domElements.bulkEditStatus.textContent).toContain('Operation inputs changed');
        if (key === 'bulkEditOperation') {
            expect(domElements.bulkEditPlanBtn.disabled).toBe(true);
        }
    });
});

describe('bulk edit apply confirmation', () => {
    async function readyToApply() {
        await openModal();
        chooseOperation();
        domElements.bulkEditLocator.value = 'Artist';
        domElements.bulkEditValue.value = 'new';
        await planWith(PLAN_CHANGED);
    }

    it('shows an in-modal confirmation instead of applying immediately', async () => {
        await readyToApply();

        domElements.bulkEditApplyBtn.dispatch('click');
        await flush();

        expect(domElements.bulkEditConfirm.style.display).toBe('flex');
        expect(domElements.bulkEditConfirmMessage.textContent).toContain('1 file(s)');
        expect(applyBulkEdit).not.toHaveBeenCalled();
    });

    it('cancelling leaves the plan untouched and applies nothing', async () => {
        await readyToApply();

        domElements.bulkEditApplyBtn.dispatch('click');
        await flush();
        domElements.bulkEditCancelApplyBtn.dispatch('click');
        await flush();

        expect(domElements.bulkEditConfirm.style.display).toBe('none');
        expect(applyBulkEdit).not.toHaveBeenCalled();
        expect(domElements.bulkEditApplyBtn.disabled).toBe(false);
    });

    it('confirming applies the reviewed plan verbatim and reports success', async () => {
        await readyToApply();
        applyBulkEdit.mockResolvedValueOnce(APPLY_RESULT);

        domElements.bulkEditApplyBtn.dispatch('click');
        await flush();
        domElements.bulkEditConfirmApplyBtn.dispatch('click');
        await flush();

        expect(applyBulkEdit).toHaveBeenCalledWith({ plan: PLAN_CHANGED });
        expect(domElements.bulkEditConfirm.style.display).toBe('none');
        expect(domElements.bulkEditStatus.textContent)
            .toBe('Applied to 1 file(s) (1 skipped, 0 failed).');
        expect(domElements.bulkEditStatus.className).toContain('bulk-edit-status-success');
        expect(domElements.bulkEditResults.children[0].textContent)
            .toBe('1 applied, 1 skipped, 0 failed');

        const rows = domElements.bulkEditTableBody.children;
        expect(rows).toHaveLength(2);
        expect(rows[0].children.map((cell) => cell.textContent))
            .toEqual(['a.json', 'applied', '1 change(s)', '']);
        expect(rows[1].children.map((cell) => cell.textContent))
            .toEqual(['b.json', 'skipped', '—', 'already up to date']);
    });

    it('reports failures explicitly instead of a bare finished line', async () => {
        await readyToApply();
        applyBulkEdit.mockResolvedValueOnce({
            plan_id: PLAN_CHANGED.id,
            results: [
                { file: '/tmp/a.json', status: 'failed', changes: 0, reason: 'file changed on disk' },
                { file: '/tmp/b.json', status: 'skipped', changes: 0, reason: 'already up to date' },
            ],
            applied: 0,
            skipped: 1,
            failed: 1,
            journal_path: null,
            journal_degraded: false,
        });

        domElements.bulkEditApplyBtn.dispatch('click');
        await flush();
        domElements.bulkEditConfirmApplyBtn.dispatch('click');
        await flush();

        expect(domElements.bulkEditStatus.textContent).toContain('1 failure(s)');
        expect(domElements.bulkEditStatus.textContent).toContain('0 applied, 1 skipped, 1 failed');
        expect(domElements.bulkEditStatus.className).toContain('bulk-edit-status-error');
        expect(domElements.bulkEditTableBody.children).toHaveLength(2);
    });

    it('cancels a pending confirmation when the modal closes', async () => {
        await readyToApply();

        domElements.bulkEditApplyBtn.dispatch('click');
        await flush();
        closeBulkEditModal();
        await flush();

        expect(domElements.bulkEditConfirm.style.display).toBe('none');
        expect(applyBulkEdit).not.toHaveBeenCalled();

        // A late click on the hidden confirm button must not apply anything.
        domElements.bulkEditConfirmApplyBtn.dispatch('click');
        await flush();
        expect(applyBulkEdit).not.toHaveBeenCalled();
    });
});
