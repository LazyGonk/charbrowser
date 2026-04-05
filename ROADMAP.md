# CharBrowser Roadmap

**A Tauri app for browsing/editing character card metadata embedded in files.**

---

## Format Support

| Format | Metadata Extract | JSON Edit | Tag Edit | Preview |
|--------|:----------------:|:---------:|:--------:|:--------:|
| **PNG** | ✅ Full (tEXt/iTXt/zTXt) | ✅ | ✅ | ✅ |
| JPEG/GIF/BMP | ⚠️ EXIF only | ❌ | ⚠️ Planned | ✅ |
| WebP | ⚠️ EXIF only | ❌ | ⚠️ Planned | ✅ |
| FITS/FIT | ✅ Header keywords | ❌ | ⚠️ Planned | ✅ |
| **TIFF/TIF** | ✅ EXIF + TIFF tags | ❌ | ⚠️ Planned | ✅ |
| MP3 | ✅ ID3 TXXX frames | ✅ | ⚠️ Planned | ✅+Cover |
| FLAC | ✅ Vorbis comments | ✅ | ⚠️ Planned | ✅+Cover |
| OGG | ⚠️ Limited (Vorbis) | ❌ | ⚠️ Planned | ✅+Cover |
| M4A/WAV | ❌ Not implemented | ❌ | ❌ | ✅ |
| MP4/MOV | ✅ User data atoms | ✅ | ❌ | ✅ |
| AVI/MKV | ❌ Not implemented | ❌ | ❌ | ✅ |

---

## Planned Format Extensions

| Format | Priority | Status | Notes |
|--------|----------|--------|-------|
| TIFF-based RAW (NEF/ARW/ORF/PEF/RW2/DNG) | P3 | Planned | Requires third-party libs (rawpilot); would bloat app significantly |
| Proprietary RAW (CR2/CRW/RAF) | P4 | Research | Canon/Nikon/Fuji proprietary formats need specialized decoders |
| FITS debayering | P3 | Planned | Bayer pattern demosaicing for astronomical sensor data; enables color preview from monochrome+filter or RGB channel data |

## Future Format Research

| Format | Status |
|--------|--------|
| WebM | Research |
| AAC/WMA/AIFF | Research |
| GLTF/GLB | Research |

---

## What's New

- **Copy All Metadata** - Button to copy all text fields to clipboard
- **JSON tree view** - Collapsible, inline editing (replaces dual-pane)
- **FITS format support** - Astronomy FITS header keyword extraction
- **TIFF format support** - TIFF metadata extraction with EXIF + TIFF tag support

---

## Feature Roadmap

### Character Card Features (Primary Focus)

| Feature | Priority | Status |
|---------|----------|--------|
| Character Card Diff & Merge | P1 | Proposed |
| Character Card Validation | P1 | Proposed |
| Schema Version Migration | P1 | Proposed |
| Unified Card Editor | P2 | Planned |
| Import/Export Wizard | P2 | Proposed |
| Smart Tagging System | P2 | Proposed |
| Duplicate Detection | P2 | Proposed |
| Character Gallery View | P2 | Proposed |
| Character Card Templates | P3 | Proposed |

### Format Extensions (Secondary)

| Feature | Priority | Status |
|---------|----------|--------|
| Image tag editing (EXIF/TIFF/FITS headers) | P2 | Planned |
| FITS debayering | P3 | Planned |
| Audio tag editing (ID3/Vorbis comments) | P2 | Planned |
| WebP custom text field support | P3 | Research needed |
| Cloud Storage Support (read-only) | P4 | Proposed |

---

## Open Issues

| Issue | Priority | Status |
|-------|----------|--------|
| OGG cover art for corrupted files | P0 | Won't Fix |
| `unwrap_or("Unknown")` silently hides failures | P2 | Open |

## Issue Details & Fix Plan

### 1. OGG Cover Art for Corrupted Files
**Problem**: Some OGG files have corrupted METADATA_BLOCK_PICTURE fields that can't be reliably extracted.

**Status**: WON'T FIX - Works for well-formed OGG files, corrupted files are rare edge cases
