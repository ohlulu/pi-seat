import { describe, expect, test } from "bun:test";
import { makeHarness, mutateStore, runTurn, cred } from "./harness.ts";

const FRESH = Date.now() + 3_600_000;
const EXPIRED = Date.now() - 60_000;

describe("per-turn re-apply (REQ-004 two-turn tests)", () => {
	test("default changed after first turn → second turn applies the new credential", async () => {
		const h = makeHarness({
			sections: {
				anthropic: {
					default: "work",
					profiles: { work: cred("rt-work", FRESH), personal: cred("rt-personal", FRESH) },
				},
			},
		});

		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work");

		// A `/seat use personal` from anywhere lands in the store between turns.
		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.default = "personal";
		});

		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-personal");
		expect(h.runtime.streamCalls).toBe(2);
	});

	test("token expired after first turn → second turn refreshes and applies the rotation", async () => {
		const h = makeHarness({
			sections: { anthropic: { default: "work", profiles: { work: cred("rt-1", FRESH) } } },
			behavior: {
				refresh: (c) => ({ ...c, refresh: "rt-2", access: "at-rt-2", expires: FRESH }),
			},
		});

		await runTurn(h);
		expect(h.counters.refresh).toBe(0); // fresh: no refresh on turn 1
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-1");

		// Simulate expiry between the first tool call and the next turn.
		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.profiles["work"] = cred("rt-1", EXPIRED);
		});

		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.counters.refresh).toBe(1);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-2"); // second request rides the rotation
	});

	test("profile deleted mid-session under a pin → per-turn lookup fails closed", async () => {
		const h = makeHarness({
			sections: {
				anthropic: { profiles: { work: cred("rt-work", FRESH), other: cred("rt-other", FRESH) } },
			},
			pins: { anthropic: "work" },
		});

		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work");

		mutateStore(h.backend, (store) => {
			delete store.providers.anthropic!.profiles["work"];
		});

		await runTurn(h);
		expect(h.aborts).toHaveLength(1);
		expect(h.aborts[0]).toContain("work");
		expect(h.runtime.streamCalls).toBe(1); // second turn never streamed
	});

	test("pin is immutable: default change between turns does not move a pinned session", async () => {
		const h = makeHarness({
			sections: {
				anthropic: {
					default: "personal",
					profiles: { work: cred("rt-work", FRESH), personal: cred("rt-personal", FRESH) },
				},
			},
			pins: { anthropic: "work" },
		});

		await runTurn(h);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work");

		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.default = "work"; // irrelevant to the pin
			store.providers.anthropic!.profiles["personal"] = cred("rt-p2", FRESH);
		});

		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work"); // still the pin
	});
});

describe("AC-043: an API-key profile (REQ-013)", () => {
	const KEY = "sk-ant-api03-FAKE-turn-key";

	test("the overlay and every request carry the key, with zero refresh or toAuth", async () => {
		const h = makeHarness({
			sections: {
				anthropic: {
					default: "console",
					profiles: { console: { type: "api_key", key: KEY }, work: cred("rt-work", EXPIRED) },
				},
			},
		});

		await runTurn(h, "anthropic");
		expect(h.aborts).toEqual([]);
		expect(h.runtime.keys.get("anthropic")).toBe(KEY);
		expect(await h.coordinator.requestAuth("anthropic")).toEqual({ apiKey: KEY });
		expect(await h.coordinator.owns("anthropic")).toBe("api_key");
		// The expired OAuth profile beside it is never touched: it is not selected.
		expect(h.counters).toEqual({ refresh: 0, toAuth: 0 });
	});

	test("switching between an OAuth profile and the key re-applies each turn", async () => {
		const h = makeHarness({
			sections: {
				anthropic: {
					default: "work",
					profiles: { console: { type: "api_key", key: KEY }, work: cred("rt-work", FRESH) },
				},
			},
		});

		await runTurn(h, "anthropic");
		expect(h.runtime.keys.get("anthropic")).toBe("at-rt-work");
		expect(await h.coordinator.owns("anthropic")).toBe("oauth");

		mutateStore(h.backend, (store) => {
			store.providers.anthropic!.default = "console";
		});
		await runTurn(h, "anthropic");
		expect(h.runtime.keys.get("anthropic")).toBe(KEY);
		expect(h.aborts).toEqual([]);
	});

	test("a selection naming a deleted profile is owned as missing and fails closed", async () => {
		const h = makeHarness({
			sections: { anthropic: { profiles: { console: { type: "api_key", key: KEY } } } },
			pins: { anthropic: "console" },
		});
		mutateStore(h.backend, (store) => {
			delete store.providers.anthropic!.profiles["console"];
		});

		expect(await h.coordinator.owns("anthropic")).toBe("missing");
		await runTurn(h, "anthropic");
		expect(h.aborts).toHaveLength(1);
		expect(h.aborts[0]).not.toContain(KEY);
		expect(h.runtime.streamCalls).toBe(0);
	});
});
