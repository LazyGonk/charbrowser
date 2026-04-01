# Maintaining CharBrowser

This document covers release workflow, public-repo checks, and license notice generation.

## Public Repository Checklist

Before pushing changes intended for public release:

1. Install dependencies and verify frontend build:

```bash
npm ci
npm run build
```

1. Verify Rust backend build:

```bash
cd src-tauri
cargo check
```

1. Regenerate third-party notices and inventory:

```bash
npm run licenses:generate
```

1. Confirm `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `public/third-party-licenses.json` are up to date.

## Third-Party Notices

- Full third-party dependency and license inventory is generated into:
  - `THIRD_PARTY_NOTICES.md`
  - `public/THIRD_PARTY_NOTICES.md`
  - `public/third-party-licenses.json`
- Regenerate notices and inventory with:

```bash
node scripts/generate-licenses.mjs
```

- In-app access: click the **Licenses** button in the top-right toolbar to open the searchable popup with license links and copyright/author fields.

## Automated Releases

- GitHub Actions builds release artifacts for **Windows**, **macOS**, and **Linux**.
- Windows release publishes a **portable `charbrowser.exe` only** (no installer bundle).
- Trigger options:
  - Push a version tag such as `v0.1.0`
  - Run the `Release` workflow manually from GitHub Actions
- Workflow file: `.github/workflows/release.yml`
- Releases are created as **drafts** for review before publishing.

## Recommended Publish Flow

1. Push branch changes:

```bash
git push origin main
```

1. Push release tags:

```bash
git push origin --tags
```

1. Verify on GitHub:
   - CI workflow succeeds
   - Release workflow creates/updates draft release
