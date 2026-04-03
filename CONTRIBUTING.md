# Contributing

Thanks for your interest in contributing to CharBrowser.

## Getting Started

1. Fork the repository.
2. Create a feature branch from `main`.
3. Install dependencies:

```bash
npm ci
cd src-tauri
cargo check
```

1. Run the app locally:

```bash
npm run tauri dev
```

## Development Guidelines

- Keep changes focused and small.
- Preserve existing behavior unless the change explicitly targets behavior updates.
- Update `README.md` when user-facing behavior changes.
- Regenerate third-party notices if dependencies change:

```bash
npm run licenses:generate
```

## Code Quality Checks

Before opening a PR, run:

```bash
npm run build
cd src-tauri
cargo check
```

## Pull Request Checklist

- [ ] The change has a clear purpose and concise description.
- [ ] Build checks pass locally.
- [ ] Docs are updated when needed.
- [ ] License/notices were regenerated if dependencies changed.

## Commit Style

Use clear, imperative commit messages, for example:

- `Add EXIF-only folder filter`
- `Fix MP3 embedded JSON detection fallback`
- `Update third-party notices generation`

## Reporting Security Issues

Do not open public issues for vulnerabilities. See `SECURITY.md`.

---

## Maintaining Releases

### Before Release

1. Build and verify:

```bash
npm run build
cd src-tauri && cargo check
```

2. Regenerate third-party notices:

```bash
npm run licenses:generate
```

### Automated Releases

- GitHub Actions builds releases for **Windows**, **macOS**, **Linux**
- Windows: portable exe only (no installer)
- Trigger: push version tag (e.g., `v0.1.0`) or run Release workflow manually
- Releases created as drafts for review
