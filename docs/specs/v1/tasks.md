---
summary: pi-seat v1 implementation task breakdown — machine-first checklist derived from requirements.md and plan.md
read_when:
  - Executing or resuming pi-seat v1 implementation
  - Checking implementation progress against the spec
---

# Tasks: pi-seat v1

Machine phases are dependency-ordered; run with ralph-wiggum Pattern A when executed autonomously. Rollout/cutover is not a task — it executes per [plan.md §Migration / rollout](./plan.md#migration--rollout) after Human Acceptance.

## Phase 1: Foundation

- [ ] T001 [DEC-006] Scaffold repo: `package.json` (bun scripts `test`/`typecheck`/`bench`, `pi.extensions: ["./src/extension/index.ts"]`), `tsconfig.json`, `bun.lock`. Verify: `bun install && bun run typecheck` → clean
- [ ] T002 [NFR-002] Add `LICENSE` and `NOTICE` with pi-accounts MIT attribution. Verify: `test -f LICENSE && test -f NOTICE && grep -q pi-accounts NOTICE` → exit 0
- [ ] T003 [REQ-001] Create `src/store/schema.ts`: store v1 types, parse/validate with own-property access, label/alias charset validation (reject `:` and `,`), with tests. Verify: `bun test test/store/schema.test.ts` → GREEN
- [ ] T004 [REQ-001] Create `test/helpers/auth-snapshot.ts`: teardown helper asserting `auth.json` byte-identical (AC-001), wired into shared test setup. Verify: `bun test test/helpers` → GREEN

## Phase 2: REQ-001 / REQ-005 — store, lock, refresh

- [ ] T005 [REQ-001, REQ-005] Create `src/store/storage.ts` per DEC-003 lock protocol: `realpath:false`, shared stale/update params, locked re-check, no commit after compromise, 0600/O_EXCL temp + same-volume rename, O_NOFOLLOW read. Verify: `bun run typecheck` → clean
- [ ] T006 [REQ-001] Storage tests covering AC-002: first create is 0600, symlink target rejected, atomic write survives injected crash-before-rename. Verify: `bun test test/store/storage.test.ts` → GREEN. Depends: T005
- [ ] T007 [REQ-005] Cross-process lock tests: two real OS child processes contend; stale-lock takeover; first-create under contention. Verify: `bun test test/store/lock-crossproc.test.ts` → GREEN. Depends: T005
- [ ] T008 [REQ-005] Create `src/store/refresh.ts`: locked single-flight refresh (acquire, re-read, refresh only if still expired, write back) with lost-response semantics (timeout keeps old credential; `invalid_grant` signals persistent failure). Verify: `bun run typecheck` → clean. Depends: T005
- [ ] T009 [REQ-005] AC-009 test: two OS processes refresh the same expired credential against a mock OAuth endpoint → endpoint called exactly once, both processes read the same rotated credential. Verify: `bun test test/store/refresh-singleflight.test.ts` → GREEN. Depends: T008

## Phase 3: REQ-008 — migration

- [ ] T010 [REQ-008] Create `src/store/migrate.ts`: import with the three exclusion rules (unconditional legacy `active`, refresh-token match vs auth.json, fail-closed on missing/dangling/ambiguous `active`), executed inside the lock with re-check, legacy file untouched. Verify: `bun run typecheck` → clean. Depends: T005
- [ ] T011 [REQ-008] AC-014 tests: fixture where legacy `active` pointer and byte-equality disagree → both rules fire independently; ambiguous fixture → fail-closed with `/seat login` message; legacy file byte-identical. Verify: `bun test test/store/migrate.test.ts` → GREEN. Depends: T010

## Phase 4: REQ-002 / REQ-003 — selection resolution

- [ ] T012 [REQ-002, REQ-003] Create `src/store/selector.ts`: grammar parse (`[provider:]label-or-alias`, bare = anthropic, recognized prefixes only, `PI_SEAT` multi-value rules) and resolution (`pin > store default > built-in`, alias resolved once at init). Verify: `bun run typecheck` → clean. Depends: T003
- [ ] T013 [REQ-002] Selector tests: grammar matrix including AC-004 cases (unknown label, malformed, duplicate provider → startup error, no partial apply) and full resolution matrix (pin/default/builtin per provider). Verify: `bun test test/store/selector.test.ts` → GREEN. Depends: T012

## Phase 5: REQ-004 / REQ-009 — runtime auth

- [ ] T014 [REQ-007] Create `src/extension/oauth.ts`: anthropic + openai-codex adapters reusing Pi built-in OAuth login/refresh/toAuth. Verify: `bun run typecheck` → clean
- [ ] T015 [REQ-004] Create `src/extension/runtime-auth.ts`: async `turn_start` coordinator (selection → locked refresh → toAuth → overlay → verify), abort-first on any failure then best-effort sentinel, startup feature detection of `ModelRuntime.setRuntimeApiKey`. Verify: `bun run typecheck` → clean. Depends: T008, T012, T014
- [ ] T016 [REQ-004] AC-007/AC-008 tests: fake adapter `invalid_grant` → turn aborted with reason, credential retained; each step (refresh/toAuth/apply/verify/sentinel) throws → abort precedes, provider stream called zero times (runner-level). Verify: `bun test test/extension/fail-closed.test.ts` → GREEN. Depends: T015
- [ ] T017 [REQ-004] Two-turn re-apply test: change default / expire token after first tool call → second provider request uses the new credential. Verify: `bun test test/extension/per-turn.test.ts` → GREEN. Depends: T015
- [ ] T018 [REQ-009] Codex invalidation via `closeOpenAICodexWebSocketSessions(sessionId)` plus AC-015 spy test: identity A→B closes exactly once, A→A never, close completes before switch reported. Verify: `bun test test/extension/codex-invalidation.test.ts` → GREEN. Depends: T015

## Phase 6: Extension entry & commands

- [ ] T019 [REQ-002] Create `src/extension/index.ts`: init-time pin parse (once, alias→label), first-load migration hook, `turn_start` wiring, feature-detection failure → fail-closed with version notice. Verify: `pi -ne -e ./src/extension/index.ts -p "reply ok"` → responds, no extension load error. Depends: T010, T015
- [ ] T020 [REQ-003, REQ-007] Create `src/extension/commands.ts`: `/seat` login/use/rm/rename/status/whoami, shorthand, repeatable `-a|--alias`, pinned-session notice (AC-016), destructive confirm on overwrite/rm. Verify: `bun run typecheck` → clean. Depends: T019
- [ ] T021 [REQ-003, REQ-007] Command tests: AC-005 (default persists, fresh unpinned resolution reads it), AC-006 (spy asserts `setRuntimeApiKey` never called), AC-012/AC-013 (fake OAuth login, overwrite confirm), AC-016 (default written + pin kept + notice). Verify: `bun test test/extension/commands.test.ts` → GREEN. Depends: T020

## Phase 7: REQ-006 — usage rendering & CLI

- [ ] T022 [REQ-006] Create `test/fixtures/generate-python-golden.py`: deterministic golden generator (frozen clock, timezone, payload, color, spinner, width); generate and commit fixtures while Python seat still exists at `~/.pi/agent/bin/seat`. Verify: run twice → byte-identical fixture output
- [ ] T023 [REQ-006] Create `src/usage/cells.ts`: `cell_width` (East Asian W/F = 2, Ambiguous = 1), `cell_clip`, `fit`, with parity tests against Python probe values. Verify: `bun test test/usage/cells.test.ts` → GREEN
- [ ] T024 [REQ-006] Create `src/usage/layout.ts` (tiers) and `src/usage/render.ts` (bars, account blocks, spinner). Verify: `bun run typecheck` → clean. Depends: T023
- [ ] T025 [REQ-006] Golden tests: AC-011a width 2–200 scan row-identical to Python fixtures; AC-011b width ≥ 40 semantic assertions (account name, meter label, percent, ellipsis on truncation). Verify: `bun test test/usage/golden.test.ts` → GREEN. Depends: T022, T024
- [ ] T026 [REQ-006] Create `src/usage/fetch.ts`: Claude oauth/usage + Codex wham/usage with Python-version headers; dormant profile refresh through REQ-005 path; built-in credential read-only snapshot never refreshed; AC-010 test with mocked endpoints. Verify: `bun test test/usage/fetch.test.ts` → GREEN. Depends: T008
- [ ] T027 [REQ-003, REQ-006] Create `src/cli/main.ts`: full synopsis per REQ-006 table, stdout primary / stderr diagnostics split, exit codes 0/1/2, `status --plain` Anthropic-only 4-column TSV, offline `whoami`. Verify: `bun run typecheck` → clean. Depends: T012, T024, T026
- [ ] T028 [REQ-006] CLI contract tests: legacy `seat usage --json` passes, bad invocation → exit 2, `--plain` TSV shape including pin-active semantics and no active row under built-in login, prompts land on stderr only. Verify: `bun test test/cli/contract.test.ts` → GREEN. Depends: T027
- [ ] T029 [NFR-001] Add `bun run bench` script (hyperfine, fixed run count, process-cold) for `seat status --plain`. Verify: `bun run bench` → p95 ≤ 150ms. Depends: T027

## Human Acceptance

- [ ] H001 [AC-003] Two real pi sessions with `PI_SEAT=work` / `PI_SEAT=personal` in tmux: requests attributed to the pinned accounts, store default unchanged
- [ ] H002 [AC-012] Real browser OAuth `/seat login` completes for both providers; profiles appear in store, `auth.json` untouched
- [ ] H003 [AC-011b] Side-by-side visual check vs Python seat at common terminal widths: bars, spinner, CJK alignment feel identical
