import { describe, expect, it } from 'vitest';
import { hideElement, showElement } from '../../../src/utils/dom-utils.js';

describe('dom-utils', () => {
    it('hides and shows element style display', () => {
        const element = { style: { display: 'block' } };
        hideElement(element);
        expect(element.style.display).toBe('none');

        showElement(element);
        expect(element.style.display).toBe('block');

        showElement(element, 'flex');
        expect(element.style.display).toBe('flex');
    });

    it('does not throw on nullish elements', () => {
        expect(() => hideElement(null)).not.toThrow();
        expect(() => showElement(undefined)).not.toThrow();
    });
});
