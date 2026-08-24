import { beforeEach, describe, expect, test } from "bun:test";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { SeatProviderAdapter } from "../../src/extension/oauth.ts";
import {
	SEAT_SENTINEL_API_KEY,
	SeatRuntimeAuthCoordinator,
	type SeatRuntime,
} from "../../src/extension/runtime-auth.ts";

const FRESH_EXPIRES = Date.now() + 3_600_000;
const EXPIRED_EXPIRES = Date.now() - 60_000;

function cred(refresh: string, expires: number): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires };
}

function seedBackend(credential: SeatCredential, label = "work"): InMemorySeatStorageBackend {
	const backend = new InMemorySeatStorageBackend();
	const store = emptyStore();
	store.providers.anthropic = {
		default: label,
		profiles: Object.assign(Object.create(null), { [label]: credential }),
		aliases: Object.assign(Object.create(null)),
	};
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	return backend;
}

/**
 * Fake implementing the same structural runtime interface, plus a `stream`
 * call counter standing in for the provider request (AC-008: abort ⇒ zero).
 */
class FakeRuntime implements SeatRuntime {
	readonly events: string[] = [];
	readonly keys = new Map<string, string>();
	streamCalls = 0;
	failSetFor: Set<string> = new Set(); // api keys whose set should throw
	verifyReturnsWrongValue = false;

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.events.push(`set:${provider}:${apiKey}`);
		if (this.failSetFor.has(apiKey) || this.failSetFor.has("*")) {
			throw new Error(`injected setRuntimeApiKey failure for ${apiKey}`);
		}
		this.keys.set(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.events.push(`remove:${provider}`);
		this.keys.delete(provider);
	}

	getApiKeyForProvider(provider: string): string | undefined {
		return this.verifyReturnsWrongValue ? "someone-elses-key" : this.keys.get(provider);
	}

	stream(): void {
		this.streamCalls += 1;
	}
}

interface AdapterBehavior {
	refresh?: (cred: SeatCredential) => Promise<SeatCredential> | SeatCredential;
	toAuth?: (cred: SeatCredential) => Promise<{ apiKey: string }> | { apiKey: string };
}

function fakeAdapters(behavior: AdapterBehavior, counters: { refresh: number; toAuth: number }): SeatProviderAdapter[] {
	const make = (id: "anthropic" | "openai-codex", displayName: string): SeatProviderAdapter => ({
		id,
		displayName,
		oauth: {
			login: () => Promise.reject(new Error("login not under test")),
			refresh: async (credential) => {
				counters.refresh += 1;
				if (!behavior.refresh) throw new Error("unexpected refresh");
				return (await behavior.refresh(credential as SeatCredential)) as never;
			},
			toAuth: async (credential) => {
				counters.toAuth += 1;
				const impl = behavior.toAuth ?? ((c: SeatCredential) => ({ apiKey: c.access }));
				return (await impl(credential as SeatCredential)) as never;
			},
		},
	});
	return [make("anthropic", "Anthropic"), make("openai-codex", "OpenAI Codex")];
}

interface Harness {
	runtime: FakeRuntime;
	backend: InMemorySeatStorageBackend;
	coordinator: SeatRuntimeAuthCoordinator;
	counters: { refresh: number; toAuth: number };
	aborts: string[];
}

function makeHarness(credential: SeatCredential, behavior: AdapterBehavior): Harness {
	const runtime = new FakeRuntime();
	const backend = seedBackend(credential);
	const counters = { refresh: 0, toAuth: 0 };
	const coordinator = new SeatRuntimeAuthCoordinator({
		runtime,
		backend,
		adapters: fakeAdapters(behavior, counters),
		pins: {},
		invalidateCodex: () => undefined,
		refreshTimeoutMs: 500,
	});
	return { runtime, backend, coordinator, counters, aborts: [] };
}

/** One simulated turn: sync, then stream only if nothing aborted. */
async function runTurn(h: Harness): Promise<void> {
	const before = h.aborts.length;
	await h.coordinator.syncTurn((reason) => {
		h.aborts.push(reason);
		h.runtime.events.push("abort");
	});
	if (h.aborts.length === before) h.runtime.stream();
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
		h.backend.withLock((current) => {
			const store = decodeStore(current);
			store.providers.anthropic!.profiles["work"] = cred("rt-new", FRESH_EXPIRES);
			return { result: undefined, next: encodeStore(store) };
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
