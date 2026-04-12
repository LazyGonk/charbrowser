import { describe, expect, it } from 'vitest';
import {
    fileKindByPath,
    formatDuration,
    formatFileSize,
    getExtension,
    getFileName,
} from '../../../src/utils/file-utils.js';

describe('file-utils', () => {
    it('extracts extension from mixed-case paths', () => {
        expect(getExtension('C:/media/Portrait.PNG')).toBe('png');
    });

    it('returns empty extension when none exists', () => {
        expect(getExtension('/tmp/readme')).toBe('');
    });

    it('extracts file name from windows and unix paths', () => {
        expect(getFileName('C:\\tmp\\a\\image.jpg')).toBe('image.jpg');
        expect(getFileName('/tmp/a/image.jpg')).toBe('image.jpg');
    });

    it('classifies media kind from extension', () => {
        expect(fileKindByPath('x/photo.webp')).toBe('image');
        expect(fileKindByPath('x/clip.mkv')).toBe('video');
        expect(fileKindByPath('x/song.flac')).toBe('audio');
        expect(fileKindByPath('x/archive.zip')).toBe('other');
    });

    it('formats file size across units', () => {
        expect(formatFileSize(0)).toBe('0.00 B');
        expect(formatFileSize(1024)).toBe('1.00 KB');
        expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
    });

    it('formats duration for mm:ss and hh:mm:ss', () => {
        expect(formatDuration(65)).toBe('1:05');
        expect(formatDuration(3605)).toBe('1:00:05');
        expect(formatDuration(-10)).toBe('0:00');
    });
});
