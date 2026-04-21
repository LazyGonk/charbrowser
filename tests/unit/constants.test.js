import { describe, expect, it } from 'vitest';
import {
    AUDIO_EXTS,
    IMAGE_EXTS,
    IMAGE_PORTRAIT_PRESETS,
    JSON_EXTS,
    JSON_PREVIEW_MAX_LENGTH,
    MEDIA_EXTS,
    THUMBNAIL_CONCURRENCY,
    THUMBNAIL_SIZE,
    VIDEO_EXTS,
} from '../../src/constants.js';

describe('constants', () => {
    it('contains expected image/video/audio extensions', () => {
        expect(IMAGE_EXTS.has('png')).toBe(true);
        expect(VIDEO_EXTS.has('mp4')).toBe(true);
        expect(AUDIO_EXTS.has('mp3')).toBe(true);
        expect(JSON_EXTS.has('json')).toBe(true);
    });

    it('builds media extension union', () => {
        expect(MEDIA_EXTS.has('png')).toBe(true);
        expect(MEDIA_EXTS.has('mkv')).toBe(true);
        expect(MEDIA_EXTS.has('wav')).toBe(true);
        expect(MEDIA_EXTS.has('json')).toBe(true);
    });

    it('defines expected portrait presets', () => {
        expect(IMAGE_PORTRAIT_PRESETS).toEqual([
            { width: 1000, height: 1500 },
            { width: 800, height: 1200 },
            { width: 400, height: 600 },
        ]);
    });

    it('uses optimized thumbnail settings', () => {
        expect(THUMBNAIL_CONCURRENCY).toBe(4);
        expect(THUMBNAIL_SIZE).toBe(64);
    });

    it('uses a practical JSON preview length limit', () => {
        expect(JSON_PREVIEW_MAX_LENGTH).toBe(50000);
    });
});
