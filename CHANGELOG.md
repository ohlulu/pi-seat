# Changelog

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
