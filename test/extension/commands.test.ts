import { describe, expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import { resolveSelection } from "../../src/store/selector.ts";
import type { SeatProviderAdapter } from "../../src/extension/oauth.ts";
import { runSeatCommand, type SeatCommandDeps } from "../../src/extension/seat-command.ts";
import { makeHarness, runTurn } from "./harness.ts";

const FRESH = Date.now() + 3_600_000;

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: FRESH };
}

function seededBackend(): InMemorySeatStorageBackend {
	const backend = new InMemorySeatStorageBackend();
	const store = emptyStore();
	store.providers.anthropic = {
		default: "work",
		profiles: Object.assign(Object.create(null), { work: cred("rt-w"), personal: cred("rt-p") }),
		aliases: Object.assign(Object.create(null), { p: "personal" }),
	};
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	return backend;
}

interface FakeCtx {
	ctx: ExtensionCommandContext;
	notices: string[];
	confirmCalls: string[];
	confirmAnswer: boolean;
}

function fakeCtx(): FakeCtx {
	const state: FakeCtx = {
		notices: [],
		confirmCalls: [],
		confirmAnswer: true,
		ctx: undefined as never,
	};
	state.ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			notify: (text: string) => {
				state.notices.push(text);
			},
			confirm: async (_title: string, message: string) => {
				state.confirmCalls.push(message);
				return state.confirmAnswer;
			},
			input: async () => undefined,
			select: async () => undefined,
		},
	} as never;
	return state;
}

function loginAdapters(minted: SeatCredential, calls: { login: number }): SeatProviderAdapter[] {
	const make = (id: "anthropic" | "openai-codex"): SeatProviderAdapter => ({
		id,
		displayName: id,
		oauth: {
			login: async () => {
				calls.login += 1;
				return minted as never;
			},
			refresh: async () => {
				throw new Error("refresh not under test");
			},
			toAuth: async (c) => ({ apiKey: (c as SeatCredential).access }) as never,
		},
	});
	return [make("anthropic"), make("openai-codex")];
}

function deps(backend: InMemorySeatStorageBackend, overrides: Partial<SeatCommandDeps> = {}): SeatCommandDeps {
	return {
		backend,
		adapters: overrides.adapters ?? loginAdapters(cred("rt-unused"), { login: 0 }),
		pins: overrides.pins ?? {},
	};
}

describe("AC-005: use persists the default; fresh unpinned resolution reads it", () => {
	test("via subcommand and via bare shorthand", async () => {
		const backend = seededBackend();
		const f = fakeCtx();
		await runSeatCommand("use p", f.ctx, deps(backend)); // alias → personal
		expect(f.notices[0]).toContain(`default is now "personal"`);

		// A fresh, unpinned resolution (what a new session would compute) reads it.
		const fresh = backend.read((c) => decodeStore(c));
		expect(resolveSelection(fresh, "anthropic", undefined)).toEqual({ source: "default", label: "personal" });

		await runSeatCommand("work", f.ctx, deps(backend)); // bare shorthand ≡ use
		const again = backend.read((c) => decodeStore(c));
		expect(resolveSelection(again, "anthropic", undefined)).toEqual({ source: "default", label: "work" });
	});
});

describe("AC-017: /seat <selector> -a <alias> attaches the alias with the switch", () => {
	test("`/seat personal -a o` then `/seat o` resolves through the new alias", async () => {
		const backend = seededBackend();
		const f = fakeCtx();
		await runSeatCommand("personal -a o", f.ctx, deps(backend)); // bare shorthand
		const store = backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.default).toBe("personal");
		expect(store.providers.anthropic?.aliases["o"]).toBe("personal");
		expect(f.notices[0]).toContain("alias o → personal");

		// The alias is usable as a selector on the very next command.
		await runSeatCommand("work", f.ctx, deps(backend));
		await runSeatCommand("o", f.ctx, deps(backend));
		expect(resolveSelection(backend.read((c) => decodeStore(c)), "anthropic", undefined)).toEqual({
			source: "default",
			label: "personal",
		});
	});

	test("`use` subcommand takes repeatable --alias; a conflicting alias is refused", async () => {
		const backend = seededBackend();
		const f = fakeCtx();
		await runSeatCommand("use personal -a o --alias me", f.ctx, deps(backend));
		const store = backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.aliases["o"]).toBe("personal");
		expect(store.providers.anthropic?.aliases["me"]).toBe("personal");

		const before = backend.read((c) => c);
		await runSeatCommand("use work -a o", f.ctx, deps(backend)); // o belongs to personal
		expect(f.notices.at(-1)).toContain("already points");
		expect(backend.read((c) => c)).toBe(before); // default not switched either
	});
});

describe("AC-006: no default, no pin → zero runtime override", () => {
	test("coordinator never calls setRuntimeApiKey and the turn streams on builtin", async () => {
		const h = makeHarness({ sections: {} }); // empty store, no pins
		await runTurn(h);
		expect(h.aborts).toEqual([]);
		expect(h.runtime.events.filter((e) => e.startsWith("set:") || e.startsWith("remove:"))).toEqual([]);
		expect(h.runtime.keys.size).toBe(0);
		expect(h.runtime.streamCalls).toBe(1);
	});
});

describe("AC-012: /seat login via fake OAuth flow", () => {
	test("mints through the adapter and stores under the label with aliases", async () => {
		const backend = seededBackend();
		const calls = { login: 0 };
		const minted = cred("rt-minted");
		const f = fakeCtx();
		await runSeatCommand("login openai-codex:main -a m", f.ctx, deps(backend, { adapters: loginAdapters(minted, calls) }));

		expect(calls.login).toBe(1);
		const store = backend.read((c) => decodeStore(c));
		expect(store.providers["openai-codex"]?.profiles["main"]?.refresh).toBe("rt-minted");
		expect(store.providers["openai-codex"]?.aliases["m"]).toBe("main");
		expect(f.notices.some((n) => n.includes(`stored openai-codex profile "main"`))).toBe(true);
	});
});

describe("AC-013: overwrite requires confirm, and confirm precedes the OAuth flow", () => {
	test("declined → no OAuth call, store untouched", async () => {
		const backend = seededBackend();
		const before = backend.read((c) => c);
		const calls = { login: 0 };
		const f = fakeCtx();
		f.confirmAnswer = false;
		await runSeatCommand("login work", f.ctx, deps(backend, { adapters: loginAdapters(cred("rt-new"), calls) }));

		expect(f.confirmCalls).toHaveLength(1);
		expect(calls.login).toBe(0); // browser flow never started
		expect(backend.read((c) => c)).toBe(before);
		expect(f.notices.some((n) => n.includes("cancelled"))).toBe(true);
	});

	test("accepted → overwrites and says so", async () => {
		const backend = seededBackend();
		const calls = { login: 0 };
		const f = fakeCtx();
		await runSeatCommand("login work", f.ctx, deps(backend, { adapters: loginAdapters(cred("rt-new"), calls) }));

		expect(f.confirmCalls).toHaveLength(1);
		expect(calls.login).toBe(1);
		const store = backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-new");
		expect(f.notices.some((n) => n.includes("overwrote previous grant"))).toBe(true);
	});
});

describe("AC-016: use in a pinned session persists the default and keeps the pin", () => {
	test("default written, notice names the retained pin", async () => {
		const backend = seededBackend();
		const f = fakeCtx();
		await runSeatCommand("use personal", f.ctx, deps(backend, { pins: { anthropic: "work" } }));

		const store = backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.default).toBe("personal"); // default written
		expect(f.notices[0]).toContain(`default is now "personal"`);
		expect(f.notices[0]).toContain("keeps its pin (work)"); // AC-016 notice

		// The pinned session itself still resolves to the pin.
		expect(resolveSelection(store, "anthropic", "work")).toEqual({ source: "pin", label: "work" });
	});
});

describe("T036: extension rm re-asks when the grant changes during the prompt", () => {
	test("replacement mid-confirm → second confirm, then the new grant is removed", async () => {
		const backend = seededBackend();
		const f = fakeCtx();
		let confirmCount = 0;
		(f.ctx.ui as { confirm: unknown }).confirm = async () => {
			confirmCount += 1;
			if (confirmCount === 1) {
				backend.withLock((current) => {
					const store = decodeStore(current!);
					store.providers.anthropic!.profiles["work"] = cred("rt-replaced");
					return { result: undefined, next: encodeStore(store) };
				});
			}
			return true;
		};
		await runSeatCommand("rm work", f.ctx, deps(backend));
		expect(confirmCount).toBe(2); // stale rejection forced a re-ask
		expect(backend.read((c) => decodeStore(c)).providers.anthropic?.profiles["work"]).toBeUndefined();
		expect(f.notices.some((n) => n.includes("changed while waiting"))).toBe(true);
	});
});

describe("error surface", () => {
	test("unknown selector reports an error notice, never throws", async () => {
		const f = fakeCtx();
		await runSeatCommand("use nosuch", f.ctx, deps(seededBackend()));
		expect(f.notices.some((n) => n.startsWith("seat:") && n.includes("nosuch"))).toBe(true);
	});
});
