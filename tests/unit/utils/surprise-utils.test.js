import { describe, expect, it } from 'vitest';
import { SURPRISE_SEQUENCE, getNextSurpriseIndex } from '../../../src/utils/surprise-utils.js';

describe('surprise-utils', () => {
    it('advances through complete surprise sequence', () => {
        let index = 0;
        for (const key of SURPRISE_SEQUENCE) {
            index = getNextSurpriseIndex(index, key);
        }
        expect(index).toBe(SURPRISE_SEQUENCE.length);
    });

    it('resets sequence index on wrong key', () => {
        let index = 0;
        index = getNextSurpriseIndex(index, 'ArrowUp');
        index = getNextSurpriseIndex(index, 'x');
        expect(index).toBe(0);
    });

    it('supports restart when first key is pressed mid-sequence', () => {
        let index = 3;
        index = getNextSurpriseIndex(index, 'ArrowUp');
        expect(index).toBe(1);
    });
});
