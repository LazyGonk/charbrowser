# CharBrowser Roadmap

**A Tauri app for browsing and editing metadata from images, videos, and audio files.**

---

## Format Support

| Format | Metadata Extract | JSON Edit | Tag Edit | Preview |
|--------|:----------------:|:---------:|:--------:|:--------:|
| **PNG** | ✅ Full (tEXt/iTXt/zTXt) | ✅ | ✅ | ✅ |
| JPEG/GIF/BMP | ⚠️ EXIF only | ❌ | ⚠️ Deferred | ✅ |
| WebP | ⚠️ EXIF only | ❌ | ⚠️ Deferred | ✅ |
| FITS/FIT | ✅ Header keywords + debayering | ❌ | ✅ | ✅ |
| TIFF/TIF | ✅ EXIF + TIFF tags | ❌ | ⚠️ Deferred | ✅ |
| MP3 | ✅ ID3 TXXX frames | ✅ | ✅ Partial | ✅+Cover |
| FLAC | ✅ Vorbis comments | ✅ | ✅ Partial | ✅+Cover |
| OGG | ⚠️ Limited (Vorbis) | ❌ | ⚠️ Deferred | ✅+Cover |
| M4A/WAV | ❌ Not implemented | ❌ | ❌ | ✅ |
| MP4/MOV | ✅ User data atoms | ✅ | ❌ | ✅ |
| AVI/MKV | ❌ Not implemented | ❌ | ❌ | ✅ |
| **JSON** | ✅ Card fields (character card schema) | ✅ Import to card editor | ❌ | ✅ Pretty-print |

---

## What's New

- **JSON file support** - Browse `.json` files in the folder view; card-schema JSON opens Card Editor with all fields populated; non-card JSON shows formatted preview; `.json` can also be opened via drag-drop or file picker
- **LLM-assisted field generation** - Per-field AI generation with regenerate/revert,
  generate all button, editable prompt templates, model discovery, and enforced
  `{{char}}`/`{{user}}` placeholders in first-message/scenario generation
- **ComfyUI image generation** - Generate character images via ComfyUI workflow with
  progress polling, connection test, workflow validation, backend-proxied networking,
  workflow template placeholders (`%prompt%`, `%negative_prompt%`, `%width%`, `%height%`),
  and a dedicated Visual Description prompt source (LLM-extracted from Description + First Message)
- **Settings dirty state tracking** - Unsaved changes confirmation bar on close
- **Inline card confirmation UX** - Card editor confirmations now use in-page bars with auto-scroll and a one-time flash cue
- **Copy All Metadata** - Button to copy all text fields to clipboard
- **JSON tree view** - Collapsible, inline editing (replaces dual-pane)
- **FITS format support** - Astronomy FITS header keyword extraction with debayering (Bayer pattern demosaicing for color previews from sensor data)
- **TIFF format support** - TIFF metadata extraction with EXIF + TIFF tag support
- **Card Editor MVP** - Create new PNG character cards, edit embedded card JSON, and resize/crop imported card art from Metadata View
- **Tabbed Settings UI** - General, LLM, ComfyUI, and About settings shells are now available from the toolbar
- **Metadata editor UX polish** - Editable formats now use the shared review dialog before save and hide redundant Additional Information rows
- **Delete to trash (Delete/Backspace)** - Move files to system trash with optional undo and one-time confirmation disable
- **Song lyrics display** - Shows embedded lyrics in preview panel for MP3/FLAC/OGG files

---

## Supported Remote Endpoints

### LLM Providers

| Provider | Endpoint | Auth Required | Status |
|----------|----------|:------------:|:--------:|
| Ollama | `http://localhost:11434/v1` | Optional | ✅ Tested |
| LMStudio | `http://localhost:1234/v1` | Optional | ✅ Tested |
| OpenRouter.ai | `https://openrouter.ai/api/v1` | ✅ API Key | ✅ Tested |
| Custom | User-defined | Optional | ✅ Tested |
| OpenAI | `https://api.openai.com/v1` | ✅ API Key | ⚠️ Untested |
| Groq | `https://api.groq.com/openai/v1` | ✅ API Key | ⚠️ Untested |
| DeepSeek | `https://api.deepseek.com/v1` | ✅ API Key | ⚠️ Untested |
| NanoGPT | `https://nano-gpt.com/api/v1` | ✅ API Key | ⚠️ Untested |

### Image Generation

| Service | Type | Auth Required | Status |
|---------|------|---------------|--------|
| ComfyUI (Local) | Self-hosted | ❌ | ✅ Tested |
| RunPod | Cloud GPU | ✅ API Key + Endpoint ID | ⚠️ Untested |

---

## Open Issues

| Issue | Priority | Status |
|-------|----------|--------|
| OGG cover art for corrupted files | P0 | Won't Fix |

## Feature Roadmap

### Character Card Features (Primary Focus)

| Feature | Priority | Status |
|---------|----------|--------|
| Character Card Diff & Merge | P1 | Proposed |
| Character Card Validation | P1 | Proposed |
| Schema Version Migration | P1 | Proposed |
| Import/Export Wizard | P2 | Proposed |
| Smart Tagging System | P2 | Proposed |
| Duplicate Detection | P2 | Proposed |
| Character Gallery View | P2 | Proposed |
| Character Card Templates | P3 | Proposed |

### Format Extensions (Secondary)

| Feature | Priority | Status |
|---------|----------|--------|
| Image tag editing (EXIF/TIFF headers) | P2 | In Progress |
| Audio tag editing (ID3/Vorbis comments) | P2 | In Progress |
| WebP custom text field support | P3 | Research needed |
| Cloud Storage Support (read-only) | P4 | Proposed |

## Issue Details & Fix Plan

### 1. OGG Cover Art for Corrupted Files
**Problem**: Some OGG files have corrupted METADATA_BLOCK_PICTURE fields that can't be reliably extracted.

**Status**: WON'T FIX - Works for well-formed OGG files, corrupted files are rare edge cases

---

## Planned Format Extensions

| Format | Priority | Status | Notes |
|--------|----------|--------|-------|
| TIFF-based RAW (NEF/ARW/ORF/PEF/RW2/DNG) | P3 | Planned | Requires third-party libs (rawpilot); would bloat app significantly |
| Proprietary RAW (CR2/CRW/RAF) | P4 | Research | Canon/Nikon/Fuji proprietary formats need specialized decoders |

## Future Format Research

| Format | Status |
|--------|--------|
| WebM | Research |
| AAC/WMA/AIFF | Research |
| GLTF/GLB | Research |