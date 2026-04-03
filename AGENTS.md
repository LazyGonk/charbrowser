# Agent Configuration

## Role
General-purpose - handles development, code review, and maintenance tasks.

## Working Directory
All file operations MUST be confined to the project root directory. Never modify, create, or delete files outside the project without explicit approval.

## External Commands
Ask for approval before running any shell command that affects files outside the project directory.

## Web Resources
Ask for approval before fetching or searching web resources (webfetch, websearch, codesearch).

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

## Code Style
- Vanilla JavaScript only - no frameworks
- Follow existing patterns in `src/main.js` and `src/state.js`
- Use the `state` module for shared application state
- Keep functions focused and small
- No comments unless explicitly requested

## Security
- Follow `SECURITY.md` guidelines for vulnerability reporting
- Validate file paths before processing
- Never expose or log secrets/keys

## Documentation
- Update `README.md` for user-facing changes
- Update `CONTRIBUTING.md` for development workflow changes
- Update `docs/MAINTAINING.md` for release/maintenance changes
- Regenerate licenses: `npm run licenses:generate`
