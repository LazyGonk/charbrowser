import { describe, expect, it } from 'vitest';
import { escapeHtml, getInputValue } from '../../../src/utils/string-utils.js';

describe('string-utils', () => {
    it('extracts trimmed input values safely', () => {
        expect(getInputValue({ value: '  hello  ' })).toBe('hello');
        expect(getInputValue(null)).toBe('');
        expect(getInputValue(undefined)).toBe('');
    });

    it('escapes HTML special characters', () => {
        expect(escapeHtml('<div class="x">A&B\'s</div>')).toBe(
            '&lt;div class=&quot;x&quot;&gt;A&amp;B&#39;s&lt;/div&gt;'
        );
    });
});
