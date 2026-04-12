import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock the tauri invoke function
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

describe('tauri-api - deleteFileToTrash', () => {
    let invokeModule;
    let invoke;

    beforeEach(async () => {
        invokeModule = await import('@tauri-apps/api/core');
        invoke = invokeModule.invoke;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('invokes delete_file_to_trash command with file path', async () => {
        const { deleteFileToTrash } = await import('../../../src/services/tauri-api.js');
        const testPath = '/tmp/test.jpg';
        invoke.mockResolvedValueOnce(undefined);

        await deleteFileToTrash(testPath);

        expect(invoke).toHaveBeenCalledWith('delete_file_to_trash', {
            filePath: testPath,
        });
    });

    it('returns undefined on successful deletion', async () => {
        const { deleteFileToTrash } = await import('../../../src/services/tauri-api.js');
        invoke.mockResolvedValueOnce(undefined);

        const result = await deleteFileToTrash('/tmp/test.jpg');

        expect(result).toBeUndefined();
    });

    it('propagates errors from backend', async () => {
        const { deleteFileToTrash } = await import('../../../src/services/tauri-api.js');
        const errorMessage = 'Permission denied';
        invoke.mockRejectedValueOnce(new Error(errorMessage));

        await expect(deleteFileToTrash('/tmp/test.jpg')).rejects.toThrow(errorMessage);
    });

    it('handles file not found errors', async () => {
        const { deleteFileToTrash } = await import('../../../src/services/tauri-api.js');
        invoke.mockRejectedValueOnce(new Error('File not found'));

        await expect(deleteFileToTrash('/tmp/missing.jpg')).rejects.toThrow('File not found');
    });
});
