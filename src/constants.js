/**
 * Shared frontend constants used across filtering, preview, and layout modules.
 * Keeping these centralized prevents drift between services and UI components.
 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'fits', 'fit', 'tif', 'tiff', 'nef', 'arw', 'orf', 'pef', 'rw2', 'dng']);
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);

export const THUMBNAIL_CONCURRENCY = 2;
export const CACHE_MAX_SIZE = 500;

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX_RATIO = 0.65;
export const METADATA_MIN = 140;
export const METADATA_MAX_RATIO = 0.8;

export const PREVIEW_IMAGE_MAX_SIZE = 1600;
export const PREVIEW_MEDIA_MAX_BYTES = 80 * 1024 * 1024;
export const AUDIO_COVER_MAX_SIZE = 1200;
