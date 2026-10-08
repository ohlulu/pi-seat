import { afterEach, describe, expect, test } from "bun:test";
import type { TurnFailureHandlers } from "../../src/extension/runtime-auth.ts";
import { SEAT_SENTINEL_API_KEY } from "../../src/extension/runtime-auth.ts";
import { cred, makeHarness, type Harness } from "./harness.ts";
import { cleanupLoadedExtensions, loadExtension } from "./load-extension.ts";

const FRESH = Date.now() + 3_600_000;
const EXPIRED = Date.now() - 60_000;

afterEach(cleanupLoadedExtensions);

function recordingHandlers(h: Harness): TurnFailureHandlers {
	return {
		abort: (reason) => h.aborts.push(reason),
		warn: (reason) => h.warnings.push(reason),
	};
}

describe("AC-033: the overlay is applied at session_start, before any turn", () => {
	test("both providers are applied with no turn having run", async () => {
		const h = makeHarness({
			sections: {
				anthropic: { default: "work", profiles: { work: cred("rt-work", FRESH) } },
				"openai-codex": { default: "main", profiles: { main: cred("rt-main", FRESH) } },
			},
		});

		const results = await h.coordinator.syncIdle(recordingHandlers(h));

		expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work");
		expect(h.runtime.keys.get("openai-codex")).toBe("at-rt-main");
		expect(h.aborts).toEqual([]);
	});

	test("a provider with no default and no pin is left to Pi's built-in login", async () => {
		const h = makeHarness({ sections: { anthropic: { profiles: { work: cred("rt-work", FRESH) } } } });

		const results = await h.coordinator.syncIdle(recordingHandlers(h));

		expect(results.map((r) => r.status)).toEqual(["builtin", "builtin"]);
		expect(h.runtime.events).toEqual([]); // zero runtime override (AC-006)
	});

	test("a dead grant is poisoned and reported, never fatal, since there is no turn to abort", async () => {
		const h = makeHarness({
			sections: { anthropic: { default: "work", profiles: { work: cred("rt-dead", EXPIRED) } } },
			behavior: {
				refresh: () => {
					throw new Error("Token refresh failed: invalid_grant");
				},
			},
		});

		const results = await h.coordinator.syncIdle(recordingHandlers(h));

		expect(results.find((r) => r.provider === "anthropic")?.status).toBe("blocked");
		expect(h.runtime.keys.get("anthropic")).toBe(SEAT_SENTINEL_API_KEY); // no fallback to auth.json
		expect(h.aborts).toEqual([]);
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toContain("invalid_grant");
	});

	test("a sentinel that cannot land is escalated through abort, as on the turn path (AC-032)", async () => {
		const h = makeHarness({
			sections: { anthropic: { default: "work", profiles: { work: cred("rt-work", FRESH) } } },
		});
		h.runtime.failSetFor = new Set(["*"]); // the real key and the sentinel both fail

		await h.coordinator.syncIdle(recordingHandlers(h));

		expect(h.aborts).toHaveLength(1);
		expect(h.warnings).toEqual([]);
	});
});

describe("AC-033 wiring: the real extension entry syncs on session_start", () => {
	test("session_start alone applies the pinned credential", async () => {
		const loaded = loadExtension({ pin: "work", profiles: { anthropic: { work: cred("rt-work", FRESH) } } });

		await loaded.fireSessionStart();

		expect(loaded.runtime.keys.get("anthropic")).toBe("at-rt-work");
		expect(loaded.aborts).toBe(0);
	});

	test("a failure at session_start notifies without aborting anything", async () => {
		const loaded = loadExtension({ pin: "work", profiles: { anthropic: { work: cred("rt-work", FRESH) } } });
		loaded.runtime.verifyReturnsWrongValue = true; // read-back never matches, sentinel included

		await loaded.fireSessionStart();

		expect(loaded.aborts).toBe(0);
		expect(loaded.notices.some((n) => n.includes("seat: anthropic auth failed"))).toBe(true);
	});

	test("a startup error applies nothing at session_start; turns still fail closed", async () => {
		const loaded = loadExtension({ pin: "nosuch", profiles: { anthropic: { work: cred("rt-work", FRESH) } } });

		await loaded.fireSessionStart();
		expect(loaded.runtime.keys.size).toBe(0);
		expect(loaded.aborts).toBe(0);

		await loaded.fireTurnStart();
		expect(loaded.aborts).toBe(1);
	});
});
