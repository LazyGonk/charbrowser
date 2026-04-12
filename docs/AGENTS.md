# Agent Configuration

## Role
General-purpose - handles development, code review, and maintenance tasks.

---

## Project Overview

**CharBrowser** is a cross-platform desktop application built with the Tauri framework that browses folders for media files (images, videos, audio) and extracts/displays their metadata. A key feature is support for embedded JSON data stored within media file containers.

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    CHARBROWSER APP                          │
├───────────────────────────┬─────────────────────────────────┤
│    FRONTEND (JavaScript)  │     BACKEND (Rust/Tauri)        │
│    src/main.js (entry)    │     src-tauri/src/              │
│    src/init.js            │                                 │
│    src/ui/, src/services/ │                                 │
│    src/utils/, src/state.js                                 │
├──────────┬────────────────┼─────────────────────────────────┤
│  File    │◄── Tauri Invoke►│  main.rs (Tauri Commands)      │
│  Browser │                 │  ├─────────────────────────────┤
│  Card   │◄────────────��─►│  │ llm_history (LLM history)   │
│  Editor │                 │  ├─────────────────────────────┤
│          │                 │  │ metadata/                   │
│  Preview │◄────────────────┼─►│ mod.rs    (Orchestrator)    │
│  Panel   │                 │  ├────┬──────┬──────┬─────────┤
│          │                 │  │    │      │      │         │
│  Metadata│◄────────────────┼─►│image.rs video.rs audio.rs fits.rs│
│  Panel   │                 │  └────┴──────┴──────┴─────────┘│
│          │                 │       ▲                         │
│          │◄────────────────┼─►     │                         │
│  Embedded│◄────────────────┼─►embedded.rs                   │
│  JSON    │                 │                                 │
└──────────┴─────────────────┴─────────────────────────────────┘
          ▲                                    ▲
          │                                    │
        User                              File System

LLM Service (src/services/llm-service.js) - OpenAI-compatible API
ComfyUI Service (src/services/comfyui-service.js) - Workflow execution
```

### Module Organization

| Layer | Module | Purpose |
|-------|--------|----------|
| Frontend | `src/main.js` | Minimal entrypoint that boots the app |
| Frontend | `src/init.js` | App orchestration: wiring services, UI modules, and startup |
| Frontend | `src/ui/card-editor.js` | Character card creation/editing with LLM generation |
| Frontend | `src/ui/folder-view.js` | File browser and list management |
| Frontend | `src/ui/drag-drop.js` | Native/browser drag-drop routing for files, images, JSON, and folders |
| Frontend | `src/ui/preview.js` | Media preview panel |
| Frontend | `src/ui/metadata-panel.js` | Metadata display panel |
| Frontend | `src/ui/settings-modal.js` | Settings configuration modal |
| Frontend | `src/services/llm-service.js` | OpenAI-compatible LLM API communication |
| Frontend | `src/services/comfyui-service.js` | ComfyUI workflow execution |
| Frontend | `src/services/tauri-api.js` | Tauri invoke wrappers plus native path inspection helpers |
| Frontend | `src/services/settings-service.js` | Settings persistence |
| Frontend | `src/services/*` | Backend invoke wrappers and frontend business logic services |
| Frontend | `src/utils/*` | Pure utility helpers for file, JSON, and metadata operations |
| Frontend | `src/state.js` | Centralized application state and cache management |
| Backend | `src-tauri/src/main.rs` | Tauri entry point, command definitions |
| Backend | `src-tauri/src/llm_history.rs` | LLM iteration history persisted during runtime and cleared on app exit |
| Backend | `src-tauri/src/metadata/mod.rs` | Metadata extraction orchestration by file type |
| Backend | `src-tauri/src/metadata/types.rs` | Struct definitions for metadata serialization |
| Backend | `src-tauri/src/metadata/embedded.rs` | Embedded JSON detection, editing, PNG card creation |
| Backend | `src-tauri/src/metadata/image.rs` | Image metadata, PNG chunks, EXIF, thumbnails |
| Backend | `src-tauri/src/metadata/audio.rs` | MP3/FLAC/OGG/WAV metadata extraction |
| Backend | `src-tauri/src/metadata/video.rs` | MP4/MOV/AVI/MKV metadata extraction |
| Backend | `src-tauri/src/metadata/fits.rs` | FITS astronomical image format support |

### Supported File Formats

- **Images**: PNG, JPEG, GIF, BMP, WebP, FITS, TIFF
- **Video**: MP4, MOV, AVI, MKV
- **Audio**: MP3, WAV, FLAC, OGG, M4A

---

## Working Directory
All file operations MUST be confined to the project root directory. Never modify, create, or delete files outside the project without explicit approval.

## External Commands
Ask for approval before running any shell command that affects files outside the project directory.

## Web Resources
Ask for approval before fetching or searching web resources (webfetch, websearch, codesearch).

---

## Build & Test Commands
```bash
# Development
npm run tauri dev

# Verify changes (run before submitting PRs)
npm run build
cd src-tauri && cargo check

# Production builds
npm run tauri build           # installer
npm run tauri build:portable # portable exe

# Regenerate licenses after dependency changes
npm run licenses:generate
```

---

## Code Style

### General Principles
- **Vanilla JavaScript only** - no frameworks (React, Vue, etc.)
- **Follow existing patterns** in `src/init.js`, `src/ui/*`, `src/services/*`, and `src/state.js`
- **Use the `state` module** for shared application state
- **Keep functions focused and small** - single responsibility principle

### Documentation Requirements
- **Add brief comments to every function explaining its purpose and architectural context.** Keep comments accurate by updating them when code changes.
- Use Rust doc comments (`///`) for backend, JSDoc (`/** */`) for frontend.
- Document: Purpose, Parameters (with constraints), Returns (including errors), and Architectural Context.

### Modularity as Design Principle
**Modularity is essential to avoid extensive core code edits when adding new features.**

- Prioritize modularity in specs/plans; discuss how components can be separated into modular chunks.
- Examine existing architecture for opportunities to break monoliths into cleaner, more understandable modules.
- Prefer composition over inheritance; define clear module boundaries and interfaces.
- Minimize cross-module dependencies; consider future extensibility when designing new features.

**Note**: Frontend modularization is complete. `src/main.js` serves as a thin entrypoint; feature logic lives in `src/init.js`, `src/ui/*`, `src/services/*`, and `src/utils/*`. LLM integration (llm-service.js) and ComfyUI integration (comfyui-service.js) are now available.

---

## Security
- Follow `SECURITY.md` guidelines for vulnerability reporting
- Validate file paths before processing
- Never expose or log secrets/keys

---

## Documentation
- Update `README.md` for user-facing changes
- Update `CONTRIBUTING.md` for development workflow changes
- Update `docs/MAINTAINING.md` for release/maintenance changes
- Regenerate licenses: `npm run licenses:generate`
- See [`plans/developer-documentation.md`](plans/developer-documentation.md) for comprehensive documentation guidelines

---

## Key Design Patterns in Codebase

### Token-Based Cache Invalidation
Used to prevent stale data issues during async operations. Each operation receives a token; results are discarded if the token doesn't match the current expected value.

### Concurrent Processing with Bounded Parallelism
Thumbnail loading, filter application use worker pools with limited concurrency to avoid overwhelming system resources.

### Format-Specific Extractors
Metadata extraction is delegated to format-specific modules (image.rs, audio.rs, video.rs) based on file type detection via magic bytes or extension.

### Embedded JSON Container Support
Multiple encoding variants supported:
- Base64 Standard / StandardNoPad
- Base64 URLSafe / URLSafeNoPad  
- Plaintext (direct JSON string)
