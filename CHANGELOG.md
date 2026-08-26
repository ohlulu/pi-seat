# Changelog

## [Unreleased]

### Changed

- Usage reports (`seat`, `seat usage`, and the in-session `/seat` view) now group accounts into one section per provider, each opened by a header naming that provider's effective selection (`ANTHROPIC · work (default)`) and a rule. A provider with nothing to meter still gets its header, so its selection state is never missing. The view's two-line top header is gone — that state now sits directly above the accounts it governs. `--json` output is unchanged.
- Within each provider section, the effective selection (pin > default > built-in) is listed first instead of in store order. It is also fetched first, so in the live view it is the first block to paint.
- Login now reports completion as `seat: login success — stored <provider> profile "<label>"`, in both the extension and the CLI. `notify(…, "info")` renders as one dim line indistinguishable from the flow's progress notices, so the word "success" is what separates them.

### Removed

- The legacy migration subsystem: `scripts/migrate-legacy.ts`, `src/store/migrate.ts`, and their tests. It was a one-time upgrade path importing dormant profiles from the retired private Python seat's `claude-profiles.json`; only the operator's machines ever had that file, both have completed migration, so the path is removed rather than deprecated (REQ-008 is marked retired in the spec). For every other user it was always a no-op.

## [0.1.1] - 2026-08-26

### Changed

- Releases are now published by CI via npm trusted publishing (OIDC) on tag push.

### Fixed

- Lock-ownership fencing (DEC-003 "no commit after compromise") relied on inode identity, which filesystems that recycle inode numbers (ext4/tmpfs — i.e. Linux) defeat: a successor's recreated lock directory could reuse the captured inode and the fence silently passed. Ownership is now proven by an open handle on the acquired lock directory plus a path identity comparison against it: the held fd pins the inode, so no recreated lock can reuse it and any replacement fails the comparison on every filesystem (a link-count check additionally detects removal directly on filesystems with that semantic, e.g. ext4). 0.1.0 carries this latent bug on Linux; macOS (APFS never recycles inodes) is unaffected. The store is single-user local, so realistic impact is low.

## [0.1.0] - 2026-08-26

Initial release.

### Added

- Named OAuth profiles for Anthropic and OpenAI Codex in an exclusive store (`~/.pi/agent/seat.json`, 0600, file-locked, atomic writes) — Pi's `auth.json` is never written.
- `/seat` extension commands: `login` (with repeatable `-a` aliases), `use` / bare shorthand (also attaches aliases), `rm`, `rename`, `status`, `whoami`.
- Session pinning via `PI_SEAT` (`work` or `anthropic:work,openai-codex:team`); pinned sessions fail closed on unknown or malformed selectors.
- Fail-closed per-turn runtime overlay: refresh → toAuth → apply → verify, abort-first on any failure; Codex WebSocket invalidation on account switch.
- Cross-process single-flight token refresh.
- `seat` CLI with usage meters (5h/weekly bars, CJK-aware layout, golden-tested against the retired Python seat), `status --plain` TSV contract, `--json`.
- In-session usage view: `/seat`, `/seat status`, `/seat usage` open an interactive dashboard (esc/q to close).
- Login UX: auto-opens the platform browser on auth URL / device code, clickable OSC 8 links, explicit completion notice.
- One-time operator migration script `scripts/migrate-legacy.ts` (dry-run by default) importing dormant profiles from the legacy Python seat store.
