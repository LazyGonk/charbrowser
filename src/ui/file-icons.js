/**
 * Creates a simple fallback file icon for non-thumbnail list items.
 * This keeps folder rendering consistent for media and unsupported formats.
 * @param {string} ext File extension.
 * @returns {HTMLDivElement} Icon element.
 */
export function createFileIcon(ext) {
    const icon = document.createElement('div');
    icon.className = 'file-icon';

    const icons = {
        mp4: '🎬',
        mov: '🎬',
        avi: '🎬',
        mkv: '🎬',
        mp3: '🎵',
        wav: '🎵',
        flac: '🎵',
        ogg: '🎵',
        m4a: '🎵',
    };

    icon.textContent = icons[ext] || '📄';
    return icon;
}
