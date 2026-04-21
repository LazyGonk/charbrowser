import { describe, expect, it } from 'vitest';
import {
    buildJsonDiffSummary,
    flattenJson,
    formatJsonPreviewText,
    formatJsonValue,
    normalizeJsonText,
    tryFormatJsonPretty,
} from '../../../src/utils/json-utils.js';

describe('json-utils', () => {
    it('pretty-formats valid JSON and preserves invalid text', () => {
        expect(tryFormatJsonPretty('{"a":1}')).toBe('{\n  "a": 1\n}');
        expect(tryFormatJsonPretty('{bad')).toBe('{bad');
        expect(tryFormatJsonPretty('')).toBe('');
    });

    it('normalizes JSON text and throws on invalid input', () => {
        expect(normalizeJsonText('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}');
        expect(() => normalizeJsonText('{')).toThrow();
    });

    it('flattens nested objects and arrays', () => {
        const out = flattenJson({ a: { b: [1, 2] }, c: true });
        expect(out.get('a.b[0]')).toBe('1');
        expect(out.get('a.b[1]')).toBe('2');
        expect(out.get('c')).toBe('true');
    });

    it('builds diff summary for added/changed/removed keys', () => {
        const summary = buildJsonDiffSummary(
            '{"a":1,"obj":{"x":1}}',
            '{"a":2,"obj":{"x":1},"new":true}'
        );

        expect(summary).toContain('Added keys: 1');
        expect(summary).toContain('Removed keys: 0');
        expect(summary).toContain('Changed values: 1');
        expect(summary).toContain('new');
        expect(summary).toContain('a');
    });

    it('formats scalar values for UI editing', () => {
        expect(formatJsonValue('abc')).toBe('abc');
        expect(formatJsonValue(12)).toBe('12');
        expect(formatJsonValue(false)).toBe('false');
        expect(formatJsonValue(null)).toBe('null');
    });

    it('formats JSON preview text and reports valid JSON', () => {
        const result = formatJsonPreviewText('{"a":1}', 100);
        expect(result.formattedText).toBe('{\n  "a": 1\n}');
        expect(result.isJson).toBe(true);
        expect(result.isTruncated).toBe(false);
    });

    it('keeps raw text for invalid JSON preview content', () => {
        const result = formatJsonPreviewText('{bad', 100);
        expect(result.formattedText).toBe('{bad');
        expect(result.isJson).toBe(false);
        expect(result.isTruncated).toBe(false);
    });

    it('truncates formatted preview text when over limit', () => {
        const result = formatJsonPreviewText('{"a":"1234567890"}', 12);
        expect(result.isTruncated).toBe(true);
        expect(result.formattedText.endsWith('... (truncated)')).toBe(true);
    });
});
