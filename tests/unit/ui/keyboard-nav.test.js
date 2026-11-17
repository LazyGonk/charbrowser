import { beforeEach, describe, expect, it, vi } from 'vitest';

const { domElements, FakeElement } = vi.hoisted(() => {
    class FakeElement {
        constructor() {
            this.style = { display: 'none' };
            this.classes = new Set();
            this.classList = {
                contains: (name) => this.classes.has(name),
            };
            this.focus = () => {};
        }
    }

    const keys = [
        'jsonDiffModal',
        'settingsModal',
        'licensesModal',
        'docViewerModal',
        'bulkEditModal',
        'surpriseOverlay',
        'loadingOverlay',
        'previewFileInfoOverlay',
        'fileList',
        'embeddedJsonTextFilter',
    ];

    const domElements = {};
    for (const key of keys) {
        domElements[key] = new FakeElement();
    }

    return { domElements, FakeElement };
});

vi.mock('../../../src/dom.js', () => ({ dom: domElements }));

vi.mock('../../../src/ui/card-editor.js', () => ({
    confirmCardEditorExit: vi.fn(),
}));

const keydownListeners = [];

globalThis.document = {
    activeElement: null,
    addEventListener: (type, listener) => {
        if (type === 'keydown') {
            keydownListeners.push(listener);
        }
    },
};

const { isModalOrOverlayOpen, initKeyboardNavigation } = await import('../../../src/ui/keyboard-nav.js');
const { state } = await import('../../../src/state.js');

const MODAL_KEYS = ['jsonDiffModal', 'settingsModal', 'licensesModal', 'docViewerModal'];

function openByDisplay(key) {
    domElements[key].style.display = 'flex';
}

function openByClass(key, className) {
    domElements[key].classes.add(className);
}

function press(key) {
    const event = { key, preventDefault: vi.fn() };
    for (const listener of keydownListeners) {
        listener(event);
    }
    return event;
}

describe('global key handler modal guard', () => {
    let callbacks;

    beforeEach(() => {
        for (const element of Object.values(domElements)) {
            element.style.display = 'none';
            element.classes.clear();
        }

        keydownListeners.length = 0;
        document.activeElement = null;

        state.currentFiles = ['a.png', 'b.png'];
        state.selectedFile = 'a.png';

        callbacks = {
            selectFileInList: vi.fn(),
            onFileSelected: vi.fn().mockResolvedValue(undefined),
            onDeleteSelected: vi.fn(),
        };
        initKeyboardNavigation(callbacks.selectFileInList, callbacks.onFileSelected, callbacks.onDeleteSelected);
    });

    it('reports no open modal or overlay when every overlay is closed', () => {
        expect(isModalOrOverlayOpen()).toBe(false);
    });

    it('blocks delete while the settings modal is open', () => {
        openByDisplay('settingsModal');

        const event = press('Delete');

        expect(isModalOrOverlayOpen()).toBe(true);
        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('blocks delete while the licenses modal is open', () => {
        openByDisplay('licensesModal');

        press('Backspace');

        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
    });

    it('blocks delete while the document viewer is open', () => {
        openByDisplay('docViewerModal');

        press('Delete');

        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
    });

    it('blocks navigation and delete while a class-toggled overlay is visible', () => {
        openByClass('surpriseOverlay', 'is-visible');

        press('ArrowDown');
        press('Delete');

        expect(callbacks.onFileSelected).not.toHaveBeenCalled();
        expect(callbacks.selectFileInList).not.toHaveBeenCalled();
        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
    });

    it('blocks delete while the loading overlay is visible', () => {
        openByClass('loadingOverlay', 'visible');

        press('Delete');

        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
    });

    it('still blocks delete while the JSON diff modal is open', () => {
        openByDisplay('jsonDiffModal');

        press('Delete');

        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
    });

    it('blocks delete while the bulk edit modal is open', () => {
        openByDisplay('bulkEditModal');

        press('Delete');
        press('ArrowDown');

        expect(isModalOrOverlayOpen()).toBe(true);
        expect(callbacks.onDeleteSelected).not.toHaveBeenCalled();
        expect(callbacks.onFileSelected).not.toHaveBeenCalled();
    });

    it('does not treat the in-preview info box as a modal', () => {
        openByDisplay('previewFileInfoOverlay');

        press('Delete');

        expect(callbacks.onDeleteSelected).toHaveBeenCalledTimes(1);
    });

    it('runs delete only when no modal or overlay is open', () => {
        const event = press('Delete');

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(callbacks.onDeleteSelected).toHaveBeenCalledTimes(1);
    });

    it('still navigates files when no modal or overlay is open', async () => {
        press('ArrowDown');
        await Promise.resolve();

        expect(callbacks.onFileSelected).toHaveBeenCalledWith('b.png');
        expect(callbacks.selectFileInList).toHaveBeenCalledWith('b.png');
    });
});
