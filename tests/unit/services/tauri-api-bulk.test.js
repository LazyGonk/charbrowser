import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

describe('tauri-api - bulk edit commands', () => {
    let invoke;

    beforeEach(async () => {
        const invokeModule = await import('@tauri-apps/api/core');
        invoke = invokeModule.invoke;
        invoke.mockReset();
    });

    it('requests the capability matrix for the given paths', async () => {
        const { getBulkEditCapabilities } = await import('../../../src/services/tauri-api.js');
        invoke.mockResolvedValueOnce({ operations: [], files: [] });

        await getBulkEditCapabilities(['/data/a.jpg', '/data/b.fits']);

        expect(invoke).toHaveBeenCalledWith('get_bulk_edit_capabilities', {
            paths: ['/data/a.jpg', '/data/b.fits'],
        });
    });

    it('sends the plan request payload verbatim', async () => {
        const { planBulkEdit } = await import('../../../src/services/tauri-api.js');
        invoke.mockResolvedValueOnce({ schema_version: 1, id: 'plan', params: {}, files: [] });

        const payload = {
            request: {
                paths: ['/data/a.jpg'],
                params: { operation: 'exif_set_tag', locator: 'Artist', value: 'New' },
            },
        };
        await planBulkEdit(payload);

        expect(invoke).toHaveBeenCalledWith('plan_bulk_edit', payload);
    });

    it('sends the reviewed plan verbatim on apply', async () => {
        const { applyBulkEdit } = await import('../../../src/services/tauri-api.js');
        invoke.mockResolvedValueOnce({ plan_id: 'plan', results: [], applied: 0, skipped: 0, failed: 0 });

        const payload = { plan: { schema_version: 1, id: 'plan', params: {}, files: [] } };
        await applyBulkEdit(payload);

        expect(invoke).toHaveBeenCalledWith('apply_bulk_edit', payload);
    });
});
