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

- **No CI publisher.** The repo has no release workflow; the GitHub Release is created locally with `gh release create <version>` using the matching CHANGELOG section as body, immediately after the tag push. Reason: single-maintainer repo, no CI infrastructure yet.
- **npm publish follows the tag.** `npm publish` runs locally after the tag and GitHub Release (release-flow excludes npm publishing from its scope; this repo publishes to npm as `pi-seat` so `pi install npm:pi-seat` works). Publish failure is retryable without moving the tag.
