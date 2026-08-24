import { beforeEach, describe, expect, test } from "bun:test";
import type { SeatCredential } from "../../src/store/schema.ts";
import { decodeStore } from "../../src/store/storage.ts";
import { SEAT_SENTINEL_API_KEY } from "../../src/extension/runtime-auth.ts";
import { cred, makeHarness as makeSharedHarness, mutateStore, runTurn, type AdapterBehavior, type Harness } from "./harness.ts";

const FRESH_EXPIRES = Date.now() + 3_600_000;
const EXPIRED_EXPIRES = Date.now() - 60_000;

function makeHarness(credential: SeatCredential, behavior: AdapterBehavior): Harness {
	return makeSharedHarness({
		sections: { anthropic: { default: "work", profiles: { work: credential } } },
		behavior,
	});
}

function storedRefresh(h: Harness): string | undefined {
	return h.backend.read((current) => decodeStore(current)).providers.anthropic?.profiles["work"]?.refresh;
}

describe("AC-007: invalid_grant is persistent fail-closed", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness(cred("rt-dead", EXPIRED_EXPIRES), {
			refresh: () => {
				throw new Error("Token refresh failed: invalid_grant");
			},
		});
	});

	test("turn aborts with reason, credential retained, blocked until replacement login", async () => {
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.aborts[0]).toContain("anthropic auth failed");
		expect(h.runtime.streamCalls).toBe(0);
		expect(storedRefresh(h)).toBe("rt-dead"); // not deleted
		expect(h.counters.refresh).toBe(1);

		// Next turn: still blocked, and no second refresh attempt is made.
		await runTurn(h);
		expect(h.aborts).toHaveLength(2);
		expect(h.counters.refresh).toBe(1);
		expect(h.runtime.streamCalls).toBe(0);

		// Replacement login rotates the stored grant → block clears, turn applies.
		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.profiles["work"] = cred("rt-new", FRESH_EXPIRES);
		});
		await runTurn(h);
		expect(h.aborts).toHaveLength(2); // no new abort
		expect(h.runtime.streamCalls).toBe(1);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-new");
	});
});

describe("AC-008: every failing step aborts before any provider request", () => {
	test("refresh throws (transient) → abort precedes, stream zero", async () => {
		const h = makeHarness(cred("rt-1", EXPIRED_EXPIRES), {
			refresh: () => {
				throw new Error("ECONNRESET");
			},
		});
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.runtime.streamCalls).toBe(0);
		expect(h.runtime.events.indexOf("abort")).toBeLessThan(
			h.runtime.events.indexOf(`set:anthropic:${SEAT_SENTINEL_API_KEY}`),
		);
	});

	test("toAuth throws → abort precedes, stream zero", async () => {
		const h = makeHarness(cred("rt-1", FRESH_EXPIRES), {
			toAuth: () => {
				throw new Error("toAuth exploded");
			},
		});
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.counters.refresh).toBe(0); // fresh credential → no refresh needed
		expect(h.runtime.streamCalls).toBe(0);
		expect(h.runtime.events.indexOf("abort")).toBeLessThan(
			h.runtime.events.indexOf(`set:anthropic:${SEAT_SENTINEL_API_KEY}`),
		);
	});

	test("apply throws → abort precedes; sentinel best-effort also throws; stream zero", async () => {
		const h = makeHarness(cred("rt-1", FRESH_EXPIRES), {});
		h.runtime.failSetFor = new Set(["*"]); // real key AND sentinel both fail
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.runtime.streamCalls).toBe(0);
		// Abort came before the sentinel attempt, and the sentinel failure did
		// not un-abort the turn.
		const abortIndex = h.runtime.events.indexOf("abort");
		const sentinelIndex = h.runtime.events.indexOf(`set:anthropic:${SEAT_SENTINEL_API_KEY}`);
		expect(abortIndex).toBeGreaterThanOrEqual(0);
		expect(sentinelIndex).toBeGreaterThan(abortIndex);
	});

	test("verify mismatch throws → abort, sentinel replaces the applied key, stream zero", async () => {
		const h = makeHarness(cred("rt-1", FRESH_EXPIRES), {});
		h.runtime.verifyReturnsWrongValue = true;
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.aborts[0]).toContain("did not retain");
		expect(h.runtime.streamCalls).toBe(0);
		expect(h.runtime.keys.get("anthropic")).toBe(SEAT_SENTINEL_API_KEY);
	});

	test("abort reasons never leak token material", async () => {
		const h = makeHarness(cred("rt-secret-token", EXPIRED_EXPIRES), {
			refresh: (c) => {
				throw new Error(`server rejected refresh ${c.refresh} with access ${c.access}`);
			},
		});
		await runTurn(h);
		expect(h.aborts[0]).not.toContain("rt-secret-token");
		expect(h.aborts[0]).not.toContain("at-rt-secret-token");
	});
});

describe("transient failure recovers automatically next turn", () => {
	test("network blip on turn 1, success on turn 2", async () => {
		let failOnce = true;
		const h = makeHarness(cred("rt-1", EXPIRED_EXPIRES), {
			refresh: (c) => {
				if (failOnce) {
					failOnce = false;
					throw new Error("ETIMEDOUT");
				}
				return { ...c, refresh: "rt-rotated", access: "at-rotated", expires: FRESH_EXPIRES };
			},
		});
		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.runtime.streamCalls).toBe(0);
		expect(storedRefresh(h)).toBe("rt-1"); // transient failure keeps the old credential

		await runTurn(h);
		expect(h.aborts).toHaveLength(1); // no new abort
		expect(h.counters.refresh).toBe(2); // retried, unlike the invalid_grant block
		expect(h.runtime.streamCalls).toBe(1);
		expect(storedRefresh(h)).toBe("rt-rotated");
		expect(h.runtime.keys.get("anthropic")).toBe("at-rotated");
	});
});

describe("provider isolation", () => {
	test("anthropic failure leaves openai-codex builtin path untouched", async () => {
		const h = makeHarness(cred("rt-1", EXPIRED_EXPIRES), {
			refresh: () => {
				throw new Error("boom");
			},
		});
		const results = await h.coordinator.syncTurn((reason) => h.aborts.push(reason));
		expect(results.find((r) => r.provider === "anthropic")?.status).toBe("aborted");
		expect(results.find((r) => r.provider === "openai-codex")?.status).toBe("builtin");
		// No codex override was ever installed (AC-006 for the unconfigured provider).
		expect(h.runtime.keys.has("openai-codex")).toBe(false);
	});
});
