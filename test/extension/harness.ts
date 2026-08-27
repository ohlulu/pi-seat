/**
 * Shared coordinator test harness: fake runtime (same structural interface as
 * the pinned ModelRuntime slice, plus a `stream` counter standing in for the
 * provider request), fake provider adapters, and an in-memory seeded store.
 */
import { emptyStore, type ProviderId, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { SeatProviderAdapter } from "../../src/extension/oauth.ts";
import { SeatRuntimeAuthCoordinator, type SeatRuntime } from "../../src/extension/runtime-auth.ts";

export function cred(refresh: string, expires: number): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires };
}

export interface SeedSection {
	default?: string;
	profiles: Record<string, SeatCredential>;
}

export function seedBackend(sections: Partial<Record<ProviderId, SeedSection>>): InMemorySeatStorageBackend {
	const backend = new InMemorySeatStorageBackend();
	const store = emptyStore();
	for (const [provider, section] of Object.entries(sections) as [ProviderId, SeedSection][]) {
		store.providers[provider] = {
			...(section.default !== undefined ? { default: section.default } : {}),
			profiles: Object.assign(Object.create(null), section.profiles),
			aliases: Object.assign(Object.create(null)),
		};
	}
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	return backend;
}

export function mutateStore(
	backend: InMemorySeatStorageBackend,
	mutate: (store: ReturnType<typeof decodeStore>) => void,
): void {
	backend.withLock((current) => {
		const store = decodeStore(current);
		mutate(store);
		return { result: undefined, next: encodeStore(store) };
	});
}

export class FakeRuntime implements SeatRuntime {
	readonly events: string[] = [];
	readonly keys = new Map<string, string>();
	streamCalls = 0;
	failSetFor: Set<string> = new Set();
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

	/** Stand-in for the provider request; the turn runner calls it only when nothing aborted. */
	stream(): void {
		this.streamCalls += 1;
	}
}

export interface AdapterBehavior {
	refresh?: (cred: SeatCredential) => Promise<SeatCredential> | SeatCredential;
	toAuth?: (cred: SeatCredential) => Promise<{ apiKey: string }> | { apiKey: string };
}

export function fakeAdapters(
	behavior: AdapterBehavior,
	counters: { refresh: number; toAuth: number },
): SeatProviderAdapter[] {
	const make = (id: ProviderId, displayName: string): SeatProviderAdapter => ({
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

export interface Harness {
	runtime: FakeRuntime;
	backend: InMemorySeatStorageBackend;
	coordinator: SeatRuntimeAuthCoordinator;
	counters: { refresh: number; toAuth: number };
	aborts: string[];
	/** Non-fatal failures: a provider this turn does not use failed closed. */
	warnings: string[];
	invalidations: number;
}

export interface HarnessConfig {
	sections: Partial<Record<ProviderId, SeedSection>>;
	behavior?: AdapterBehavior;
	pins?: Partial<Record<ProviderId, string>>;
	/** Async spy: pushes invalidate:start / invalidate:end into runtime.events. */
	spyInvalidation?: boolean;
}

export function makeHarness(config: HarnessConfig): Harness {
	const runtime = new FakeRuntime();
	const backend = seedBackend(config.sections);
	const counters = { refresh: 0, toAuth: 0 };
	const harness: Harness = {
		runtime,
		backend,
		coordinator: undefined as never,
		counters,
		aborts: [],
		warnings: [],
		invalidations: 0,
	};
	harness.coordinator = new SeatRuntimeAuthCoordinator({
		runtime,
		backend,
		adapters: fakeAdapters(config.behavior ?? {}, counters),
		pins: config.pins ?? {},
		invalidateCodex: config.spyInvalidation
			? (((async () => {
					harness.invalidations += 1;
					runtime.events.push("invalidate:start");
					await Bun.sleep(5); // make "close completes first" observable
					runtime.events.push("invalidate:end");
				}) as unknown) as (sessionId?: string) => void)
			: () => {
					harness.invalidations += 1;
				},
		refreshTimeoutMs: 500,
	});
	return harness;
}

/**
 * One simulated turn: sync, then stream only if nothing aborted this turn.
 * `activeProvider` is the provider of the model this turn runs on; omitting it
 * models a Pi build or state where the active model is unknown.
 */
export async function runTurn(h: Harness, activeProvider?: string): Promise<void> {
	const before = h.aborts.length;
	await h.coordinator.syncTurn(
		{
			abort: (reason) => {
				h.aborts.push(reason);
				h.runtime.events.push("abort");
			},
			warn: (reason) => {
				h.warnings.push(reason);
				h.runtime.events.push("warn");
			},
		},
		activeProvider,
	);
	if (h.aborts.length === before) h.runtime.stream();
}
