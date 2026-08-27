# Changelog

## [Unreleased]

### Fixed

- `seat --version` reported `3.0.0`. The CLI kept its own hand-written `VERSION` constant, unconnected to `package.json` — it has been wrong since the CLI was first written, when it said `3.0.0` against a manifest reading `1.0.0`, and it shipped that way in 0.1.0, 0.1.1 and 0.2.0. The constant now reads `package.json`, so the two cannot diverge. The existing test asserted `toContain("seat 3")`, which pinned the wrong value and would have failed on any correct one; it now asserts against the manifest.

## [0.2.0] - 2026-08-26

### Added

- The in-session `/seat` view is now interactive: `↑↓` (or `k`/`j`) move a selection between accounts and `enter` makes the highlighted one that provider's default, equivalent to `/seat use <provider>:<label>`. Selecting a built-in row runs `use <provider>:default`, handing the provider back to Pi's own login. Switching does not refetch usage — liveness is derived from the store, so re-reading it is enough to move the dot — and the blocks are not re-sorted under the cursor; the order settles on the next refresh. In a `PI_SEAT`-pinned session the pin is immutable, so the dot cannot move: the view states inline that the default was written and the session keeps its pin. Destructive operations (`rm`, `login`) stay out of the view and remain commands.

### Fixed

- The `/seat` view's keys are matched through pi-tui's `matchesKey` instead of literal escape-sequence comparison. Pi negotiates the Kitty keyboard protocol (flags 1|2|4) at startup, so on Kitty, Ghostty, or WezTerm `esc` arrives as `esc [ 27 u` and `enter` as `esc [ 13 u`: the previous comparison meant `esc` did not close the view on those terminals — a latent bug since the view shipped — and would have made the new `enter` inert there. tmux does not negotiate the protocol, which is why the TUI smoke never saw it; the regression test asserts both encodings.

### Changed

- Usage reports (`seat`, `seat usage`, and the in-session `/seat` view) now group accounts into one section per provider, each opened by a header naming that provider's effective selection (`ANTHROPIC · work (default)`) and a rule. A provider with nothing to meter still gets its header, so its selection state is never missing. The view's two-line top header is gone — that state now sits directly above the accounts it governs. `--json` output is unchanged.
- Within each provider section, the effective selection (pin > default > built-in) is listed first instead of in store order. It is also the first block to paint in the live view.
- Usage reports fetch every account's usage endpoint concurrently instead of one after another. The walk awaited each account in turn, so total latency was the sum of every round trip and grew linearly with the number of stored profiles; measured locally at ~2.2s for 4 accounts (~540ms each) against ~30ms of local work, now ~0.9s. Credential refresh stays strictly serial — it holds the store lock across a network round trip, and `backend.read` acquires that lock synchronously, so overlapping two refreshes deadlocks the process against itself. Account order, JSON shape, and incremental per-account painting are unchanged; the effective selection still paints first (DEC-011).
- Login now reports completion as `seat: login success — stored <provider> profile "<label>"`, in both the extension and the CLI. `notify(…, "info")` renders as one dim line indistinguishable from the flow's progress notices, so the word "success" is what separates them.
- `seat usage --json`: a provider's `active` now reports the label the selection *names* rather than the one that answered. A default or pin pointing at a deleted profile previously reported `null`, which reads as "the built-in login is active" — the runtime actually fails that provider closed.

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
