/**
 * Shared frontend constants used across filtering, preview, and layout modules.
 * Keeping these centralized prevents drift between services and UI components.
 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'fits', 'fit', 'tif', 'tiff', 'nef', 'arw', 'orf', 'pef', 'rw2', 'dng']);
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);
export const JSON_EXTS = new Set(['json']);
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...JSON_EXTS]);

export const THUMBNAIL_CONCURRENCY = 4;
export const THUMBNAIL_SIZE = 64;
export const CACHE_MAX_SIZE = 500;

// Timeouts
export const VIDEO_READY_TIMEOUT_MS = 5000;
export const FOLDER_FILTER_DEBOUNCE_MS = 220;
export const COPY_STATUS_RESET_MS = 2000;
export const COMFYUI_POLL_INTERVAL_MS = 1000;
export const COMFYUI_MAX_POLL_ATTEMPTS = 300;
export const COMFYUI_TIMEOUT_MS = 300000;
export const NATIVE_DROP_DUPLICATE_WINDOW_MS = 120;
export const SURPRISE_OVERLAY_AUTO_HIDE_MS = 3200;
export const LOADING_OVERLAY_DELAY_MS = 120;

// Image sizes
export const IMAGE_MIN_DIMENSION = 32;
export const IMAGE_DEFAULT_DIMENSION = 512;
export const IMAGE_PORTRAIT_PRESETS = [
	{ width: 1000, height: 1500 },
	{ width: 800, height: 1200 },
	{ width: 400, height: 600 },
];

// ComfyUI defaults
export const COMFYUI_DEFAULT_WIDTH = 800;
export const COMFYUI_DEFAULT_HEIGHT = 1200;

// Limits
export const LLM_HISTORY_LIMIT = 8;
export const FILTER_DEFAULT_CONCURRENCY = 4;
export const JSON_PREVIEW_MAX_LENGTH = 50000;
export const THUMBNAIL_LOAD_MARGIN = '200px';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX_RATIO = 0.65;
export const METADATA_MIN = 140;
export const METADATA_MAX_RATIO = 0.8;

export const PREVIEW_IMAGE_MAX_SIZE = 1600;
export const PREVIEW_MEDIA_MAX_BYTES = 80 * 1024 * 1024;
export const AUDIO_COVER_MAX_SIZE = 1200;
