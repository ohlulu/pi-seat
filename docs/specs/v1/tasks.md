---
summary: pi-seat v1 implementation task breakdown — machine-first checklist derived from requirements.md and plan.md
read_when:
  - Executing or resuming pi-seat v1 implementation
  - Checking implementation progress against the spec
---

# Tasks: pi-seat v1

Machine phases are dependency-ordered; run with ralph-wiggum Pattern A when executed autonomously. Rollout/cutover is not a task — it executes per [plan.md §Migration / rollout](./plan.md#migration--rollout) after Human Acceptance. Review record lives in [plan.md §Review Dispositions](./plan.md#review-dispositions).

Sandbox rule: any task that loads the extension or exercises migration runs under a synthetic temporary `PI_CODING_AGENT_DIR` with fixture `auth.json` / `claude-profiles.json`; live `~/.pi/agent` files are asserted byte-identical before/after. No task touches the live store before cutover.

## Phase 1: Foundation

- [x] T001 [DEC-006] Scaffold repo: `package.json` (bun scripts `test`/`typecheck`, `pi.extensions: ["./src/extension/index.ts"]`), `tsconfig.json`, `bun.lock`. Verify: `bun install && grep -q pi.extensions package.json && grep -q typecheck package.json` → exit 0
- [x] T002 [NFR-002] Add `LICENSE` and `NOTICE` with pi-accounts MIT attribution. Verify: `test -f LICENSE && test -f NOTICE && grep -q pi-accounts NOTICE` → exit 0
- [x] T003 [REQ-001] Create `src/store/schema.ts`: store v1 types, parse/validate with own-property access, label/alias charset validation (reject `:` and `,`), with tests. Verify: `bun run typecheck && bun test test/store/schema.test.ts` → clean + GREEN
- [x] T004 [REQ-001] Create `test/helpers/auth-snapshot.ts` (AC-001 teardown assertion) plus `test/helpers/auth-snapshot.test.ts` self-testing byte-change detection, and a bunfig preload that auto-registers the teardown for every `test/integration/**` file. Verify: `bun test test/helpers/auth-snapshot.test.ts` → GREEN

## Phase 2: REQ-001 / REQ-005 — store, lock, refresh

- [x] T005 [REQ-001, REQ-005] Create `src/store/storage.ts` per DEC-003 lock protocol: `realpath:false`, shared stale/update params, locked re-check, no commit after compromise, 0600/O_EXCL temp + same-volume rename, O_NOFOLLOW read. Verify: `bun run typecheck` → clean
- [x] T006 [REQ-001] Storage tests covering AC-002: first create is 0600, symlink target rejected, atomic write survives injected crash-before-rename. Verify: `bun test test/store/storage.test.ts` → GREEN. Depends: T005
- [x] T007 [REQ-005] Cross-process lock tests: two real OS child processes contend; stale-lock takeover; first-create under contention. Verify: `bun test test/store/lock-crossproc.test.ts` → GREEN. Depends: T005
- [x] T008 [REQ-005] Create `src/store/refresh.ts`: locked single-flight refresh (acquire, re-read, refresh only if still expired, write back) with an injected refresh-callback interface (the DI seam for all refresh tests) and lost-response semantics (timeout keeps old credential; `invalid_grant` signals persistent failure). Verify: `bun run typecheck` → clean. Depends: T005
- [x] T009 [REQ-005] AC-009 test: parent test starts an ephemeral HTTP mock OAuth server and passes its URL plus store path to two Bun child processes refreshing the same expired credential → endpoint called exactly once, both processes read the same rotated credential. Plus lost-response branch: injected timeout → store byte-identical, next attempt proceeds. Verify: `bun test test/store/refresh-singleflight.test.ts` → GREEN. Depends: T008

## Phase 3: REQ-008 — migration

- [x] T010 [REQ-008] Create `src/store/migrate.ts`: import with the three exclusion rules (unconditional legacy `active`, refresh-token match vs auth.json, fail-closed on missing/dangling/ambiguous `active`), executed inside the lock with re-check, legacy file untouched. Verify: `bun run typecheck` → clean. Depends: T005
- [x] T011 [REQ-008] AC-014 tests: fixture where legacy `active` pointer and byte-equality disagree → both rules fire independently; ambiguous fixture → fail-closed with `/seat login` message; existing `seat.json` → migration is a no-op; legacy file absent → no-op; successful import emits the built-in-login notice; legacy file byte-identical throughout. Verify: `bun test test/store/migrate.test.ts` → GREEN. Depends: T010

## Phase 4: REQ-002 / REQ-003 — selection resolution

- [x] T012 [REQ-002, REQ-003] Create `src/store/selector.ts`: grammar parse (`[provider:]label-or-alias`, bare = anthropic, recognized prefixes only, `PI_SEAT` multi-value rules) and resolution (`pin > store default > built-in`, alias resolved once at init). Verify: `bun run typecheck` → clean. Depends: T003
- [x] T013 [REQ-002] Selector unit tests: full grammar matrix (unknown label, malformed, duplicate provider → parse error) and resolution matrix (pin/default/builtin per provider). AC-004's startup fail-closed behavior is integration-tested in T030, not here. Verify: `bun test test/store/selector.test.ts` → GREEN. Depends: T012

## Phase 5: REQ-004 / REQ-009 — runtime auth

- [x] T014 [REQ-004, REQ-005, REQ-007] Create `src/extension/oauth.ts`: anthropic + openai-codex adapters reusing Pi built-in OAuth login/refresh/toAuth, implementing the T008 refresh-callback interface. Verify: `bun run typecheck` → clean. Depends: T008
- [x] T015 [REQ-004] Create `src/extension/runtime-auth.ts`: async `turn_start` coordinator (selection → locked refresh → toAuth → overlay → verify), abort-first on any failure then best-effort sentinel. Runtime access is pinned: structural cast of `ctx.modelRegistry.runtime` to obtain the active `ModelRuntime`, feature-detecting `setRuntimeApiKey`/`removeRuntimeApiKey`; never construct a separate runtime. Verify: `bun run typecheck` → clean. Depends: T008, T012, T014
- [x] T016 [REQ-004] Fail-closed tests against a fake implementing the same runtime interface with a `stream` call counter: AC-007 (`invalid_grant` → turn aborted with reason, credential retained, blocked until a replacement login clears it); AC-008 (each of refresh/toAuth/apply/verify/sentinel throws → abort precedes, `stream` called zero times); transient failure → next-turn automatic recovery. Verify: `bun test test/extension/fail-closed.test.ts` → GREEN. Depends: T015
- [x] T017 [REQ-004] Two-turn re-apply test: change default / expire token after first tool call → second provider request uses the new credential. Verify: `bun test test/extension/per-turn.test.ts` → GREEN. Depends: T015
- [x] T018 [REQ-009] Codex invalidation via `closeOpenAICodexWebSocketSessions(sessionId)` plus AC-015 spy test: identity A→B closes exactly once, A→A never, close completes before switch reported. Verify: `bun test test/extension/codex-invalidation.test.ts` → GREEN. Depends: T015

## Phase 6: Extension entry & commands

- [x] T019 [REQ-002, REQ-004, REQ-008] Create `src/extension/index.ts` (init-time pin parse once with alias→label, first-load migration hook, `turn_start` wiring, feature-detection failure → fail-closed with version notice) plus `scripts/smoke-extension.sh`: load the extension via Pi RPC mode under a synthetic `PI_CODING_AGENT_DIR` seeded with fixture legacy + auth files; pass signal is the sandbox migration side effect (sandbox `seat.json` created per REQ-008 rules); live `auth.json`/`claude-profiles.json`/`seat.json` asserted byte-identical before/after. Verify: `bun run smoke:extension` → pass. Depends: T010, T015
- [x] T030 [REQ-002] AC-004 integration test: sandboxed extension load with unknown-label, malformed, and duplicate-provider `PI_SEAT` values → explicit startup notice, turn `abort()`, provider `stream` called zero times, and no partial apply across a multi-provider pin. Verify: `bun test test/extension/pin-failclosed.test.ts` → GREEN. Depends: T019
- [x] T020 [REQ-003, REQ-007] Create command core in `src/extension/commands.ts`: shared mutation handlers over the store (use, `default` clear, login, rm, rename, alias resolution, destructive-confirm policy) as pure functions consumed by both extension and CLI. Verify: `bun run typecheck` → clean. Depends: T012
- [x] T031 [REQ-003, REQ-007] Mutation-handler tests: `default` clears the provider default; rm distinguishes alias vs profile; rename retargets aliases and default; Python-compatible alias resolution; overwrite requires confirm. Verify: `bun test test/extension/handlers.test.ts` → GREEN. Depends: T020
- [x] T032 [REQ-003, REQ-007] Extension adapter: register `/seat` subcommands + bare shorthand routing to the T020 handlers, AC-016 pin notice. Verify: sandboxed RPC `get_commands` lists `/seat` → pass. Depends: T019, T020
- [x] T021 [REQ-003, REQ-007] Extension command tests: AC-005 (default persists, fresh unpinned resolution reads it), AC-006 (spy asserts `setRuntimeApiKey` never called), AC-012/AC-013 (fake OAuth login, overwrite confirm), AC-016 (default written + pin kept + notice). Verify: `bun test test/extension/commands.test.ts` → GREEN. Depends: T032

## Phase 7: REQ-006 — usage rendering & CLI

- [x] T022 [REQ-006] Create `test/fixtures/generate-python-golden.py`: imports the Python seat module from `~/.pi/agent/bin/seat` (must run while it still exists), injects frozen clock, timezone, payload, color, spinner, and width; emits a single `test/fixtures/python-golden.json` keyed scenario → width → stdout lines. Verify: `python3 test/fixtures/generate-python-golden.py /tmp/g1.json && python3 test/fixtures/generate-python-golden.py /tmp/g2.json && cmp /tmp/g1.json /tmp/g2.json` → identical; commit the fixture
- [x] T023 [REQ-006] Create `src/usage/cells.ts`: `cell_width` (East Asian W/F = 2, Ambiguous = 1), `cell_clip`, `fit`, with parity tests against Python probe values. Verify: `bun test test/usage/cells.test.ts` → GREEN
- [x] T024 [REQ-006] Create `src/usage/layout.ts` (tiers) and `src/usage/render.ts` (bars, account blocks, spinner). Verify: `bun run typecheck` → clean. Depends: T023
- [x] T025 [REQ-006] Golden tests: AC-011a width 2–200 scan row-identical to `python-golden.json`; AC-011b width ≥ 40 semantic assertions (account name, meter label, percent, ellipsis on truncation); TS-native expected fixtures for the states Python cannot express — named Codex, dual provider, expired-refresh. Verify: `bun test test/usage/golden.test.ts` → GREEN. Depends: T022, T024
- [x] T026 [REQ-006] Create `src/usage/fetch.ts`: Claude oauth/usage + Codex wham/usage with Python-version headers; dormant profile refresh through REQ-005 path; built-in credential read-only snapshot never refreshed; AC-010 test with mocked endpoints. Verify: `bun test test/usage/fetch.test.ts` → GREEN. Depends: T008
- [x] T027 [REQ-003, REQ-006, REQ-007] Create `src/cli/main.ts`: parser/dispatch for the full REQ-006 synopsis wired to T020 handlers and usage modules, stdout primary / stderr diagnostics split, exit codes 0/1/2, `status --plain` Anthropic-only 4-column TSV, offline `whoami`. Verify: `bun run typecheck` → clean. Depends: T020, T024, T026
- [x] T028 [REQ-006] CLI contract tests — full synopsis matrix: legacy `seat usage --json`, bare `seat`, bare shorthand `seat <selector>`, `use`/`login`/`rm`/`rename`/`whoami` via CLI, bad invocation → exit 2, operation failure → exit 1, `--plain` TSV shape including pin-active semantics and no active row under built-in login, prompts land on stderr only. Verify: `bun test test/cli/contract.test.ts` → GREEN. Depends: T027
- [x] T029 [NFR-001] Add `bench` script to `package.json` (hyperfine, fixed run count, process-cold) for `seat status --plain`, and run it. Verify: `bun run bench` → p95 ≤ 150ms. Depends: T027

## Phase 8: Review remediation

Review of 608670c..HEAD returned NEEDS-FIX with 7 findings. One task per finding; every fix ships with a regression test that reproduces the flaw first.

- [x] T033 [DEC-003] storage.ts sync `withLock` commits with no lock-compromise tracking: a paused writer resuming after stale takeover overwrites the other process's rotated credential. Verify lock ownership synchronously before commit (shared guarded write path). Regression: old writer resumes after stale takeover → commit rejected, other writer's content intact. Verify: `bun test test/store/storage.test.ts` → GREEN
- [x] T034 [REQ-004] invalid_grant block records the coordinator-entry credential, not the one ensureFreshProfile actually sent after the locked re-check; a concurrent same-label replacement unbinds the block next turn and re-sends a dead token. Refresh path must surface the actually-sent credential identity. Regression: stale coordinator read + locked re-read divergence → block binds to the sent token, next turn stays blocked. Verify: `bun test test/extension/fail-closed.test.ts` → GREEN
- [x] T035 [REQ-009] Codex invalidation compares label only: same-label `/seat login` to a different account applies the new key without closing the old WebSocket. Identity must include account fingerprint (accountId, refresh-lineage fallback). Regression: same-label credential replacement → close fires before apply; same-account refresh rotation → no close. Verify: `bun test test/extension/codex-invalidation.test.ts` → GREEN
- [x] T036 [REQ-003, REQ-007] rm confirm binds label only (TOCTOU): a grant replaced during the confirm wait is deleted unseen. needs-confirm carries a credential fingerprint; the confirmed mutation rejects on mismatch and the caller re-asks. Both CLI and extension paths. Verify: `bun test test/extension/handlers.test.ts test/extension/commands.test.ts test/cli/contract.test.ts` → GREEN
- [ ] T037 [REQ-006] profileUsage errors reach CLI output unredacted. Extract the runtime secret redaction into a shared module and apply it with the profile's access+refresh secrets. Regression: refresh error echoing credentials → CLI stderr and ProfileUsageResult.error carry no token. Verify: `bun test test/usage/fetch.test.ts test/cli/contract.test.ts` → GREEN
- [ ] T038 [REQ-004] AC-008 'stream zero' is tautological in the harness (the harness itself skips stream on abort). Add a runner-level integration: real `pi` RPC in a sandbox, custom provider pointing at a counting mock endpoint; control run proves the spy counts, seat-aborted run proves zero provider calls. Verify: `bun test test/integration/runner-abort.test.ts` → GREEN
- [ ] T039 [REQ-006] CLI usage renders only the effective named Codex profile and skips built-in when a named selection exists. Render all stored Codex profiles like Anthropic, plus the built-in snapshot independently; JSON shape mirrors anthropic. Verify: `bun test test/cli/contract.test.ts` → GREEN

## Human Acceptance

- [ ] H001 [AC-003] Two real pi sessions with `PI_SEAT=work` / `PI_SEAT=personal` in tmux: requests attributed to the pinned accounts, store default unchanged
- [ ] H002 [AC-012] Real browser OAuth `/seat login` completes for both providers; profiles appear in store, `auth.json` untouched
- [ ] H003 [AC-011b] Side-by-side visual check vs Python seat at common terminal widths: bars, spinner, CJK alignment feel identical
