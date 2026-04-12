import { describe, expect, it } from 'vitest';
import {
    collectNarrativeFields,
    extractNarrativeFieldsFromEntries,
    getExifHighlights,
    normalizeFieldKey,
} from '../../../src/utils/metadata-utils.js';

describe('metadata-utils', () => {
    it('normalizes field keys consistently', () => {
        expect(normalizeFieldKey('First Mes')).toBe('firstmes');
        expect(normalizeFieldKey('Description!')).toBe('description');
    });

    it('extracts exif highlights from preferred fields', () => {
        const highlights = getExifHighlights({
            exif: {
                DateTimeOriginal: '2024:01:01 10:00:00',
                Make: 'Canon',
                Model: 'EOS R6',
                ISOSpeedRatings: '200',
            },
        });

        expect(highlights).toContainEqual(['Captured', '2024:01:01 10:00:00']);
        expect(highlights).toContainEqual(['Camera Make', 'Canon']);
        expect(highlights).toContainEqual(['Camera Model', 'EOS R6']);
        expect(highlights).toContainEqual(['ISO', '200']);
    });

    it('collects nested narrative fields recursively', () => {
        const out = { description: null, firstMes: null };
        collectNarrativeFields(
            {
                data: {
                    Description: 'Character bio',
                    nested: {
                        first_mes: 'Hello there',
                    },
                },
            },
            out
        );

        expect(out).toEqual({ description: 'Character bio', firstMes: 'Hello there' });
    });

    it('extracts narrative fields from entry array and ignores bad json', () => {
        const result = extractNarrativeFieldsFromEntries([
            { decoded_json: 'not-json' },
            { decoded_json: '{"char":{"description":"Bio","first_mes":"Hi"}}' },
        ]);

        expect(result).toEqual({ description: 'Bio', firstMes: 'Hi' });
    });
});
