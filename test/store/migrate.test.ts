import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyProfiles, type MigrationResult } from "../../src/store/migrate.ts";
import { parseStore } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { emptyStore } from "../../src/store/schema.ts";

function cred(refresh: string) {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: 1_900_000_000_000 };
}

interface Fixture {
	dir: string;
	legacyPath: string;
	authPath: string;
	storePath: string;
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

function migrate(fx: Fixture): MigrationResult {
	return migrateLegacyProfiles({
		backend: new FileSeatStorageBackend(fx.storePath),
		legacyPath: fx.legacyPath,
		authPath: fx.authPath,
	});
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

describe("migration (AC-014)", () => {
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
					const result = migrate(fx);
					expect(result.outcome).toBe("imported");
					if (result.outcome !== "imported") throw new Error("unreachable");
					expect(result.imported).toEqual(["backup"]);
					expect(result.excluded).toEqual(["personal", "work"]);

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
					const result = migrate(fx);
					expect(result.outcome).toBe("fail-closed");
					if (result.outcome !== "fail-closed") throw new Error("unreachable");
					expect(result.notice).toContain("/seat login");
					expect(existsSync(fx.storePath)).toBe(false); // nothing imported, nothing created
				});
			},
		);
	});

	test("active missing → fail-closed; active dangling → fail-closed", () => {
		withFixture({ legacy: { profiles: { work: cred("rt-1") }, aliases: {} }, auth: {} }, (fx) => {
			const result = migrate(fx);
			expect(result.outcome).toBe("fail-closed");
			expect(existsSync(fx.storePath)).toBe(false);
		});
		withFixture(
			{ legacy: { active: "ghost", profiles: { work: cred("rt-1") }, aliases: {} }, auth: {} },
			(fx) => {
				const result = migrate(fx);
				expect(result.outcome).toBe("fail-closed");
				if (result.outcome !== "fail-closed") throw new Error("unreachable");
				expect(result.reason).toContain("ghost");
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
					const result = migrate(fx);
					expect(result).toEqual({ outcome: "noop", reason: "store-exists" });
					expect(readFileSync(fx.storePath, "utf8")).toBe(before); // store untouched too
				});
			},
		);
	});

	test("legacy file absent → no-op, no store created", () => {
		withFixture({ auth: { anthropic: cred("rt-live") } }, (fx) => {
			assertingForeignUntouched(fx, () => {
				const result = migrate(fx);
				expect(result).toEqual({ outcome: "noop", reason: "legacy-absent" });
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
					const result = migrate(fx);
					expect(result.outcome).toBe("imported");
					if (result.outcome !== "imported") throw new Error("unreachable");
					expect(result.imported).toEqual(["dormant"]);
					expect(result.excluded).toEqual(["work"]);
					expect(result.notice).toContain("work");
					expect(result.notice).toContain("built-in login");
					expect(result.notice).toContain("/seat login");
				});
			},
		);
	});

	test("auth.json absent → rule 2 excludes nothing (determinate, not ambiguous)", () => {
		withFixture(
			{ legacy: { active: "work", profiles: { work: cred("rt-1"), dormant: cred("rt-2") }, aliases: {} } },
			(fx) => {
				assertingForeignUntouched(fx, () => {
					const result = migrate(fx);
					expect(result.outcome).toBe("imported");
					if (result.outcome !== "imported") throw new Error("unreachable");
					expect(result.imported).toEqual(["dormant"]);
					expect(result.excluded).toEqual(["work"]);
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
				const result = migrate(fx);
				expect(result.outcome).toBe("fail-closed");
				expect(existsSync(fx.storePath)).toBe(false);
			},
		);
	});
});
