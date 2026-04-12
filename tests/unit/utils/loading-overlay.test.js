import { describe, expect, it, vi } from 'vitest';
import { createLoadingOverlayController } from '../../../src/utils/loading-overlay.js';

describe('loading-overlay controller', () => {
    it('shows after delay when operation is still active', () => {
        vi.useFakeTimers();
        const setVisible = vi.fn();
        const setText = vi.fn();

        const overlay = createLoadingOverlayController({
            setVisible,
            setText,
            showDelayMs: 120,
        });

        overlay.begin('Loading folder...');
        expect(setVisible).not.toHaveBeenCalled();

        vi.advanceTimersByTime(120);
        expect(setVisible).toHaveBeenCalledWith(true);

        overlay.end();
        expect(setVisible).toHaveBeenLastCalledWith(false);

        vi.useRealTimers();
    });

    it('does not show if operation ends before delay', () => {
        vi.useFakeTimers();
        const setVisible = vi.fn();

        const overlay = createLoadingOverlayController({
            setVisible,
            showDelayMs: 120,
        });

        overlay.begin('Quick op');
        overlay.end();
        vi.advanceTimersByTime(120);

        expect(setVisible).not.toHaveBeenCalledWith(true);
        expect(setVisible).not.toHaveBeenCalledWith(false);

        vi.useRealTimers();
    });

    it('keeps overlay visible until all nested operations finish', () => {
        vi.useFakeTimers();
        const setVisible = vi.fn();

        const overlay = createLoadingOverlayController({
            setVisible,
            showDelayMs: 0,
        });

        overlay.begin('A');
        overlay.begin('B');
        vi.advanceTimersByTime(0);
        expect(setVisible).toHaveBeenCalledWith(true);

        overlay.end();
        expect(setVisible).not.toHaveBeenLastCalledWith(false);

        overlay.end();
        expect(setVisible).toHaveBeenLastCalledWith(false);

        vi.useRealTimers();
    });
});