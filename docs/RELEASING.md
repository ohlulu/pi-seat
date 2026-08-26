---
summary: Release facts and procedure deviations for pi-seat (tag-driven, npm-published)
read_when:
  - Shipping a pi-seat release or bumping the version
---

# Releasing

## Facts

```yaml
app: pi-seat
channel: tag-ci

gate: bun test && bun run typecheck

version_source:
  file: package.json
  marketing_key: version

tag:
  format: "{version}"          # bare semver — no v prefix
changelog_heading: "## [{version}]"
sync_files: []

locales: [en]

notes:
  opener: false
```

## Deviations

- **CI also publishes to npm.** `.github/workflows/release.yml` runs on the tag push: gate → `npm publish` via OIDC trusted publishing (no token; trusted publisher configured on npmjs.com for ohlulu/pi-seat + release.yml) → GitHub Release from the matching CHANGELOG section. The local job ends at pushing the branch and tag. Reason: 2FA here is passkey-only (WebAuthn needs a browser), so local publish cannot be non-interactive.
- **History**: 0.1.0 was published locally with a browser WebAuthn hop, before the workflow existed.
