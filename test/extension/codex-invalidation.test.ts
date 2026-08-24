import { describe, expect, test } from "bun:test";
import { makeHarness, mutateStore, runTurn, cred } from "./harness.ts";

const FRESH = Date.now() + 3_600_000;

function codexHarness() {
	return makeHarness({
		sections: {
			"openai-codex": {
				default: "acct-a",
				profiles: { "acct-a": cred("rt-a", FRESH), "acct-b": cred("rt-b", FRESH) },
			},
		},
		spyInvalidation: true,
	});
}

describe("codex connection invalidation (AC-015)", () => {
	test("identity A→B closes exactly once; A→A never", async () => {
		const h = codexHarness();

		await runTurn(h); // first apply: (none)→A
		expect(h.runtime.keys.get("openai-codex")).toBe("at-rt-a");
		const afterFirstApply = h.invalidations;

		await runTurn(h); // A→A
		await runTurn(h); // A→A again
		expect(h.invalidations).toBe(afterFirstApply); // A→A never invalidates

		mutateStore(h.backend, (store) => {
			store.providers["openai-codex"]!.default = "acct-b";
		});
		await runTurn(h); // A→B
		expect(h.invalidations).toBe(afterFirstApply + 1); // exactly once
		expect(h.runtime.keys.get("openai-codex")).toBe("at-rt-b");

		await runTurn(h); // B→B
		expect(h.invalidations).toBe(afterFirstApply + 1);
	});

	test("close completes before the switch is applied and reported", async () => {
		const h = codexHarness();
		await runTurn(h);
		mutateStore(h.backend, (store) => {
			store.providers["openai-codex"]!.default = "acct-b";
		});
		await runTurn(h);

		const events = h.runtime.events;
		const invalidateEnd = events.lastIndexOf("invalidate:end");
		const applyB = events.indexOf("set:openai-codex:at-rt-b");
		expect(invalidateEnd).toBeGreaterThanOrEqual(0);
		expect(applyB).toBeGreaterThanOrEqual(0);
		// The async close (with a real delay behind it) finished before the new
		// credential was applied — no request can ride the stale grant.
		expect(invalidateEnd).toBeLessThan(applyB);
		expect(h.aborts).toEqual([]);
	});

	test("switch to builtin (default cleared) also closes the named-account connections", async () => {
		const h = codexHarness();
		await runTurn(h);
		const afterFirstApply = h.invalidations;

		mutateStore(h.backend, (store) => {
			delete store.providers["openai-codex"]!.default;
		});
		await runTurn(h);
		expect(h.invalidations).toBe(afterFirstApply + 1); // A→builtin closes once
		expect(h.runtime.keys.has("openai-codex")).toBe(false); // override removed

		await runTurn(h); // builtin→builtin
		expect(h.invalidations).toBe(afterFirstApply + 1);
	});

	test("anthropic switches never touch codex invalidation", async () => {
		const h = makeHarness({
			sections: {
				anthropic: {
					default: "work",
					profiles: { work: cred("rt-w", FRESH), personal: cred("rt-p", FRESH) },
				},
			},
			spyInvalidation: true,
		});
		await runTurn(h);
		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.default = "personal";
		});
		await runTurn(h);
		expect(h.invalidations).toBe(0);
	});
});
