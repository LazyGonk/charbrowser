/**
 * Creates a loading-overlay controller with delayed show and reference counting.
 * This avoids flicker on quick operations and keeps nested async flows consistent.
 * @param {{
 *   setVisible: (visible: boolean) => void,
 *   setText?: (text: string) => void,
 *   showDelayMs?: number,
 * }} options
 */
export function createLoadingOverlayController(options) {
    const setVisible = typeof options?.setVisible === 'function' ? options.setVisible : () => {};
    const setText = typeof options?.setText === 'function' ? options.setText : () => {};
    const showDelayMs = Number.isFinite(options?.showDelayMs) ? Number(options.showDelayMs) : 120;

    let activeCount = 0;
    let isVisible = false;
    /** @type {number | null} */
    let showTimer = null;

    function begin(text) {
        activeCount += 1;

        if (typeof text === 'string' && text.trim().length > 0) {
            setText(text);
        }

        if (isVisible || showTimer !== null) {
            return;
        }

        showTimer = globalThis.setTimeout(() => {
            showTimer = null;
            if (activeCount > 0 && !isVisible) {
                isVisible = true;
                setVisible(true);
            }
        }, Math.max(0, showDelayMs));
    }

    function setMessage(text) {
        if (typeof text === 'string' && text.trim().length > 0) {
            setText(text);
        }
    }

    function end() {
        if (activeCount > 0) {
            activeCount -= 1;
        }

        if (activeCount > 0) {
            return;
        }

        if (showTimer !== null) {
            globalThis.clearTimeout(showTimer);
            showTimer = null;
        }

        if (isVisible) {
            isVisible = false;
            setVisible(false);
        }
    }

    function reset() {
        activeCount = 0;

        if (showTimer !== null) {
            globalThis.clearTimeout(showTimer);
            showTimer = null;
        }

        if (isVisible) {
            isVisible = false;
            setVisible(false);
        }
    }

    return {
        begin,
        setMessage,
        end,
        reset,
    };
}