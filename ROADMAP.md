# CharBrowser Roadmap

**A Tauri app for browsing/editing character card metadata in images, audio, and video.**

---

## Format Support

| Format | Metadata | JSON Edit | Preview |
|--------|:--------:|:---------:|:--------:|
| PNG | ✅+Text | ✅ | ✅ |
| JPEG/GIF/BMP | ✅+EXIF | ❌ | ✅ |
| WebP | ✅+EXIF | ❌ | ✅ |
| FITS/FIT | ✅ | ❌ | ⚠️ |
| MP3 | ✅ ID3 | ✅ | ✅+Cover |
| FLAC | ✅ Vorbis | ✅ | ✅+Cover |
| OGG | ✅ Vorbis | ❌ | ✅+Cover |
| M4A/WAV | ⚠️ | ❌ | ✅ |
| MP4/MOV | ✅ | ✅ | ✅ |
| AVI/MKV | ✅ | ❌ | ✅ |

---

## Future Format Research

| Format | Status |
|--------|--------|
| TIFF/TIF | Research |
| WebM | Research |
| AAC/WMA/AIFF | Research |
| RAW (CR2/NEF/ARW/DNG) | Research |
| GLTF/GLB | Research |

---

## What's New

- **Copy All Metadata** - Button to copy all metadata to clipboard
- **JSON tree view** - Collapsible, inline editing (replaces dual-pane)
- **FITS format support** - Astronomy FITS image metadata extraction
- **FLAC cover art** and audio playback for all formats

---

## Feature Roadmap

| Feature | Priority | Status |
|---------|----------|--------|
| Character Card Diff & Merge | P1 | Proposed |
| Character Card Validation | P1 | Proposed |
| Schema Version Migration | P1 | Proposed |
| Character Card Creator (LLM) | P2 | Proposed |
| Import/Export Wizard | P2 | Proposed |
| Smart Tagging System | P2 | Proposed |
| Duplicate Detection | P2 | Proposed |
| Character Gallery View | P2 | Proposed |
| WebP embedded JSON support | P3 | Research needed |
| WAV Metadata Parsing | P3 | Pending |
| Character Card Templates | P3 | Proposed |
| Video codec extraction | P4 | Open |
| Cloud Storage Support (read-only) | P4 | Proposed |

---

## Open Issues

| Issue | Priority | Status |
|-------|----------|--------|
| OGG cover art for corrupted files | P0 | Won't Fix |
| `unwrap_or("Unknown")` silently hides failures | P2 | Open |
| Duration not extracted for M4A/FLAC | P2 | Open |

## Issue Details & Fix Plan

### 1. OGG Cover Art for Corrupted Files
**Problem**: Some OGG files have corrupted METADATA_BLOCK_PICTURE fields that can't be reliably extracted.

**Status**: WON'T FIX - Works for well-formed OGG files, corrupted files are rare edge cases

### 2. FITS preview limitations
**Problem**: FITS metadata extraction now works reliably, but visual preview remains limited in the current image pipeline.

**Status**: TRACKED (non-blocking)
