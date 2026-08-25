/**
 * REQ-008 / AC-014, driven through the operator script (T049).
 *
 * The rules live in src/store/migrate.ts, but nothing in the product calls them
 * except `scripts/migrate-legacy.ts`, so that is where they are tested: a rule
 * that works in isolation and never fires from the one entry point that exists
 * is not a migration.
 *
 * Every scenario runs the dry run first and asserts it wrote nothing, then
 * `--apply`, and asserts both reached the same decision.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStore } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { emptyStore } from "../../src/store/schema.ts";
import { runMigrateScript, type MigrateScriptDeps } from "../../scripts/migrate-legacy.ts";

function cred(refresh: string) {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: 1_900_000_000_000 };
}

interface Fixture {
	dir: string;
	legacyPath: string;
	authPath: string;
	storePath: string;
}

interface Run {
	code: number;
	out: string;
	errs: string;
}

function withFixture(
	files: { legacy?: unknown | string; auth?: unknown | string; seatStore?: boolean },
	fn: (fx: Fixture) => void,
): void {
	const dir = mkdtempSync(join(tmpdir(), "seat-migrate-"));
	const fx: Fixture = {
		dir,
		legacyPath: join(dir, "claude-profiles.json"),
		authPath: join(dir, "auth.json"),
		storePath: join(dir, "seat.json"),
	};
	try {
		if (files.legacy !== undefined) {
			writeFileSync(fx.legacyPath, typeof files.legacy === "string" ? files.legacy : JSON.stringify(files.legacy), {
				mode: 0o600,
			});
		}
		if (files.auth !== undefined) {
			writeFileSync(fx.authPath, typeof files.auth === "string" ? files.auth : JSON.stringify(files.auth), {
				mode: 0o600,
			});
		}
		if (files.seatStore) {
			new FileSeatStorageBackend(fx.storePath).withLock(() => ({ result: undefined, next: encodeStore(emptyStore()) }));
		}
		fn(fx);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function run(fx: Fixture, ...argv: string[]): Run {
	const out: string[] = [];
	const errs: string[] = [];
	const deps: MigrateScriptDeps = {
		io: { out: (line) => out.push(line), err: (line) => errs.push(line) },
		env: {},
		home: "/nonexistent-home",
	};
	const code = runMigrateScript(["--dir", fx.dir, ...argv], deps);
	return { code, out: out.join("\n"), errs: errs.join("\n") };
}

/** The dry run is a preview: nothing on disk may differ afterwards. */
function dryRun(fx: Fixture): Run {
	const before = snapshot(fx);
	const result = run(fx);
	expect(snapshot(fx)).toEqual(before);
	return result;
}

function snapshot(fx: Fixture): Record<string, string | null> {
	// Content alone is not enough: the P1 regression was a dry run that left
	// bytes identical but fchmod'd the store to 0600 and took the write lock.
	// Mode and the directory listing (lock/tmp artifacts) are part of "nothing".
	const read = (path: string) =>
		existsSync(path) ? `${readFileSync(path).toString("base64")}:${statSync(path).mode.toString(8)}` : null;
	return {
		store: read(fx.storePath),
		legacy: read(fx.legacyPath),
		auth: read(fx.authPath),
		dir: readdirSync(fx.dir).sort().join(","),
	};
}

/** Wrap a scenario so the legacy file (and auth.json) are asserted byte-identical. */
function assertingForeignUntouched(fx: Fixture, fn: () => void): void {
	const legacyBefore = existsSync(fx.legacyPath) ? readFileSync(fx.legacyPath) : null;
	const authBefore = existsSync(fx.authPath) ? readFileSync(fx.authPath) : null;
	const legacyMode = legacyBefore ? statSync(fx.legacyPath).mode : null;
	fn();
	const legacyAfter = existsSync(fx.legacyPath) ? readFileSync(fx.legacyPath) : null;
	const authAfter = existsSync(fx.authPath) ? readFileSync(fx.authPath) : null;
	if (legacyBefore === null) expect(legacyAfter).toBeNull();
	else {
		expect(legacyAfter !== null && legacyBefore.equals(legacyAfter)).toBe(true);
		expect(statSync(fx.legacyPath).mode).toBe(legacyMode!);
	}
	if (authBefore === null) expect(authAfter).toBeNull();
	else expect(authAfter !== null && authBefore.equals(authAfter)).toBe(true);
}

describe("migration via migrate-legacy.ts (AC-014)", () => {
	test("active pointer and byte-equality disagree → both exclusion rules fire independently", () => {
		withFixture(
			{
				// active names "work", but auth.json's grant byte-matches "personal":
				// rule 1 must exclude work, rule 2 must exclude personal, and only
				// the untangled third profile survives.
				legacy: {
					active: "work",
					profiles: { work: cred("rt-work"), personal: cred("rt-builtin"), backup: cred("rt-backup") },
					aliases: { w: "work", b: "backup" },
				},
				auth: { anthropic: cred("rt-builtin") },
			},
			(fx) => {
				assertingForeignUntouched(fx, () => {
					// Dry run: the plan, and why each account is skipped.
					const preview = dryRun(fx);
					expect(preview.code).toBe(0);
					expect(preview.out).toContain("dry run");
					expect(preview.out).toContain("would import (1)");
					expect(preview.out).toContain("backup");
					expect(preview.out).toContain("would skip (2)");
					expect(preview.out).toContain("work — legacy `active` lineage");
					expect(preview.out).toContain("personal — shares auth.json's current anthropic grant");
					expect(preview.out).toContain("--apply");
					expect(existsSync(fx.storePath)).toBe(false); // preview created nothing

					const applied = run(fx, "--apply");
					expect(applied.code).toBe(0);
					expect(applied.out).toContain("imported (1)");
					expect(applied.out).toContain("skipped (2)");

					const store = parseStore(JSON.parse(readFileSync(fx.storePath, "utf8")));
					expect(Object.keys(store.providers.anthropic?.profiles ?? {})).toEqual(["backup"]);
					// Alias of an excluded profile is dropped with it; alias of an imported one follows.
					expect(store.providers.anthropic?.aliases).toEqual(
						Object.assign(Object.create(null), { b: "backup" }),
					);
					expect(statSync(fx.storePath).mode & 0o777).toBe(0o600);
				});
			},
		);
	});

	test("ambiguous comparison (malformed auth.json) → fail-closed with /seat login message", () => {
		withFixture(
			{
				legacy: { active: "work", profiles: { work: cred("rt-1"), other: cred("rt-2") }, aliases: {} },
				auth: "{not valid json",
			},
			(fx) => {
				assertingForeignUntouched(fx, () => {
					// The dry run refuses too — a cutover script can gate on exit 1
					// before it has changed anything.
					const preview = dryRun(fx);
					expect(preview.code).toBe(1);
					expect(preview.errs).toContain("refused");
					expect(preview.errs).toContain("/seat login");

					const applied = run(fx, "--apply");
					expect(applied.code).toBe(1);
					expect(applied.errs).toContain("/seat login");
					expect(existsSync(fx.storePath)).toBe(false); // nothing imported, nothing created
				});
			},
		);
	});

	test("active missing → fail-closed; active dangling → fail-closed", () => {
		withFixture({ legacy: { profiles: { work: cred("rt-1") }, aliases: {} }, auth: {} }, (fx) => {
			expect(dryRun(fx).code).toBe(1);
			expect(run(fx, "--apply").code).toBe(1);
			expect(existsSync(fx.storePath)).toBe(false);
		});
		withFixture(
			{ legacy: { active: "ghost", profiles: { work: cred("rt-1") }, aliases: {} }, auth: {} },
			(fx) => {
				const applied = run(fx, "--apply");
				expect(applied.code).toBe(1);
				expect(applied.errs).toContain("ghost");
				expect(existsSync(fx.storePath)).toBe(false);
			},
		);
	});

	test("existing seat.json → migration is a no-op", () => {
		withFixture(
			{
				legacy: { active: "work", profiles: { work: cred("rt-1"), dormant: cred("rt-2") }, aliases: {} },
				auth: { anthropic: cred("rt-live") },
				seatStore: true,
			},
			(fx) => {
				assertingForeignUntouched(fx, () => {
					const before = readFileSync(fx.storePath, "utf8");
					expect(dryRun(fx).out).toContain("seat.json already exists");

					const applied = run(fx, "--apply");
					expect(applied.code).toBe(0);
					expect(applied.out).toContain("nothing to do");
					expect(readFileSync(fx.storePath, "utf8")).toBe(before); // store untouched too
				});
			},
		);
	});

	test("dry run never takes the lock or touches store metadata (P1 regression)", () => {
		withFixture(
			{
				legacy: { active: "work", profiles: { work: cred("rt-1"), dormant: cred("rt-2") }, aliases: {} },
				auth: { anthropic: cred("rt-live") },
				seatStore: true,
			},
			(fx) => {
				// A mode the backend would "correct": the old preview read via
				// FileSeatStorageBackend.read(), which fchmods 0600 and locks.
				chmodSync(fx.storePath, 0o644);
				const modeBefore = statSync(fx.storePath).mode;
				const dirBefore = readdirSync(fx.dir).sort().join(",");

				dryRun(fx);

				expect(statSync(fx.storePath).mode).toBe(modeBefore);
				expect(readdirSync(fx.dir).sort().join(",")).toBe(dirBefore);
			},
		);
	});

	test("legacy file absent → no-op, no store created", () => {
		withFixture({ auth: { anthropic: cred("rt-live") } }, (fx) => {
			assertingForeignUntouched(fx, () => {
				expect(dryRun(fx).out).toContain("no claude-profiles.json");
				const applied = run(fx, "--apply");
				expect(applied.code).toBe(0);
				expect(applied.out).toContain("nothing to do");
				expect(existsSync(fx.storePath)).toBe(false);
			});
		});
	});

	test("successful import emits the built-in-login notice naming excluded accounts", () => {
		withFixture(
			{
				legacy: { active: "work", profiles: { work: cred("rt-work"), dormant: cred("rt-dorm") }, aliases: {} },
				auth: { anthropic: cred("rt-work") },
			},
			(fx) => {
				assertingForeignUntouched(fx, () => {
					const applied = run(fx, "--apply");
					expect(applied.code).toBe(0);
					expect(applied.out).toContain("dormant");
					expect(applied.out).toContain("work");
					expect(applied.out).toContain("built-in login");
					expect(applied.out).toContain("/seat login");
				});
			},
		);
	});

	test("auth.json absent → rule 2 excludes nothing (determinate, not ambiguous)", () => {
		withFixture(
			{ legacy: { active: "work", profiles: { work: cred("rt-1"), dormant: cred("rt-2") }, aliases: {} } },
			(fx) => {
				assertingForeignUntouched(fx, () => {
					const preview = dryRun(fx);
					expect(preview.code).toBe(0);
					expect(preview.out).toContain("would import (1)");
					expect(preview.out).toContain("would skip (1)");
					expect(preview.out).toContain("work — legacy `active` lineage");

					expect(run(fx, "--apply").code).toBe(0);
					const store = parseStore(JSON.parse(readFileSync(fx.storePath, "utf8")));
					expect(Object.keys(store.providers.anthropic?.profiles ?? {})).toEqual(["dormant"]);
				});
			},
		);
	});

	test("malformed legacy profile → fail-closed (comparison ambiguous)", () => {
		withFixture(
			{
				legacy: { active: "work", profiles: { work: cred("rt-1"), broken: { type: "oauth" } }, aliases: {} },
				auth: {},
			},
			(fx) => {
				expect(dryRun(fx).code).toBe(1);
				expect(run(fx, "--apply").code).toBe(1);
				expect(existsSync(fx.storePath)).toBe(false);
			},
		);
	});
});

describe("migrate-legacy.ts invocation contract", () => {
	test("bad invocations exit 2 and never touch the store", () => {
		withFixture(
			{ legacy: { active: "work", profiles: { work: cred("rt-1"), dormant: cred("rt-2") }, aliases: {} } },
			(fx) => {
				const before = snapshot(fx);
				for (const argv of [["--wat"], ["--dir"], ["extra"], ["--apply", "extra"]]) {
					const result = run(fx, ...argv);
					expect(result.code).toBe(2);
					expect(result.errs).toContain("usage:");
				}
				expect(snapshot(fx)).toEqual(before);
			},
		);
	});

	test("--dir wins over PI_CODING_AGENT_DIR, and the paths are reported", () => {
		withFixture({ legacy: { active: "work", profiles: { work: cred("rt-1") }, aliases: {} } }, (fx) => {
			const out: string[] = [];
			const code = runMigrateScript(["--dir", fx.dir], {
				io: { out: (line) => out.push(line), err: () => undefined },
				env: { PI_CODING_AGENT_DIR: "/nonexistent-env-dir" },
				home: "/nonexistent-home",
			});
			// The lone profile IS the active lineage, so the plan is empty — a
			// decision, not a refusal.
			expect(code).toBe(0);
			expect(out.join("\n")).toContain("would import (0)");
			expect(out.join("\n")).toContain("(none)");
			expect(out.join("\n")).toContain(fx.storePath);
			expect(out.join("\n")).not.toContain("/nonexistent-env-dir");
		});
	});
});
