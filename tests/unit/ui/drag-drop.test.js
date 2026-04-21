import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/dom.js', () => ({
    dom: {
        dropZone: {
            classList: {
                add: vi.fn(),
                remove: vi.fn(),
            },
        },
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onDragDropEvent: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../../src/services/tauri-api.js', () => ({
    getActiveWebview: () => ({
        onDragDropEvent: vi.fn().mockResolvedValue(undefined),
    }),
    getPathInfo: vi.fn(),
}));

describe('drag-drop dropped-path routing', () => {
    let getPathInfo;
    let routeDroppedPath;
    let state;

    beforeEach(async () => {
        ({ getPathInfo } = await import('../../../src/services/tauri-api.js'));
        ({ routeDroppedPath } = await import('../../../src/ui/drag-drop.js'));
        ({ state } = await import('../../../src/state.js'));
        state.cardEditorMode = 'view';
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('routes dropped directories to folder opening flow', async () => {
        getPathInfo.mockResolvedValueOnce({ isDirectory: true, isFile: false });
        const onFileDropped = vi.fn();
        const onDirectoryDropped = vi.fn();
        const onCardEditorDrop = vi.fn();

        await routeDroppedPath('D:/media-folder', onFileDropped, onDirectoryDropped, onCardEditorDrop);

        expect(onDirectoryDropped).toHaveBeenCalledWith('D:/media-folder');
        expect(onFileDropped).not.toHaveBeenCalled();
        expect(onCardEditorDrop).not.toHaveBeenCalled();
    });

    it('routes create-mode image drops to card editor import flow', async () => {
        state.cardEditorMode = 'create';
        getPathInfo.mockResolvedValueOnce({ isDirectory: false, isFile: true });
        const onFileDropped = vi.fn();
        const onDirectoryDropped = vi.fn();
        const onCardEditorDrop = vi.fn();

        await routeDroppedPath('D:/images/card.png', onFileDropped, onDirectoryDropped, onCardEditorDrop);

        expect(onCardEditorDrop).toHaveBeenCalledWith(null, 'D:/images/card.png');
        expect(onDirectoryDropped).not.toHaveBeenCalled();
        expect(onFileDropped).not.toHaveBeenCalled();
    });

    it('routes create-mode JSON drops to card editor import flow', async () => {
        state.cardEditorMode = 'create';
        getPathInfo.mockResolvedValueOnce({ isDirectory: false, isFile: true });
        const onFileDropped = vi.fn();
        const onDirectoryDropped = vi.fn();
        const onCardEditorDrop = vi.fn();

        await routeDroppedPath('D:/cards/character.json', onFileDropped, onDirectoryDropped, onCardEditorDrop);

        expect(onCardEditorDrop).toHaveBeenCalledWith(null, 'D:/cards/character.json');
        expect(onDirectoryDropped).not.toHaveBeenCalled();
        expect(onFileDropped).not.toHaveBeenCalled();
    });

    it('falls back to regular file open for non-directory drops', async () => {
        getPathInfo.mockResolvedValueOnce({ isDirectory: false, isFile: true });
        const onFileDropped = vi.fn();
        const onDirectoryDropped = vi.fn();

        await routeDroppedPath('D:/images/card.png', onFileDropped, onDirectoryDropped);

        expect(onFileDropped).toHaveBeenCalledWith('D:/images/card.png');
        expect(onDirectoryDropped).not.toHaveBeenCalled();
    });
});