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

interface FakeComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

interface FakeCtx {
	ctx: ExtensionCommandContext;
	notices: string[];
	confirmCalls: string[];
	confirmAnswer: boolean;
	/** Components opened through ui.custom, in order. */
	customs: FakeComponent[];
	renderRequests: number;
	/** Closes the open component the way `done()` would. */
	close?: () => void;
}

/**
 * Drives ui.custom without a terminal (pi.md render-probe pattern): the factory
 * runs, the component is captured, and the promise resolves only when the
 * component calls done — so a command that opens a view and never closes it
 * shows up as a hung test rather than a passing one.
 */
type FakeMode = "rpc" | "tui";

function fakeCtx(mode: FakeMode = "rpc"): FakeCtx {
	const state: FakeCtx = {
		notices: [],
		confirmCalls: [],
		confirmAnswer: true,
		customs: [],
		renderRequests: 0,
		ctx: undefined as never,
	};
	const tui = { requestRender: () => void (state.renderRequests += 1) };
	state.ctx = {
		mode,
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
			custom: async (factory: (t: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => FakeComponent) =>
				new Promise((resolve) => {
					let component: FakeComponent | undefined;
					const done = (result: unknown) => {
						resolve(result);
						component?.dispose?.(); // interactive-mode.js disposes on close
					};
					component = factory(tui, {}, {}, done);
					state.customs.push(component);
					state.close = () => done(undefined);
				}),
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

const CLAUDE_PAYLOAD = { limits: [{ kind: "session", percent: 42, resets_at: new Date(FRESH).toISOString() }] };

function deps(backend: InMemorySeatStorageBackend, overrides: Partial<SeatCommandDeps> = {}): SeatCommandDeps {
	return {
		backend,
		adapters: overrides.adapters ?? loginAdapters(cred("rt-unused"), { login: 0 }),
		pins: overrides.pins ?? {},
		authPath: overrides.authPath ?? "/nonexistent/auth.json",
		// No usage request leaves this test file.
		fetchOptions: overrides.fetchOptions ?? { fetchImpl: (async () => Response.json(CLAUDE_PAYLOAD)) as unknown as typeof fetch },
		// No test may ever launch a real browser.
		openBrowser: overrides.openBrowser ?? (() => {}),
	};
}

describe("AC-018 / AC-019: /seat status routing", () => {
	test("TUI: bare /seat opens the view, renders bars, and q closes it", async () => {
		const backend = seededBackend();
		const f = fakeCtx("tui");
		// The command does not resolve until the view closes, so hold the promise.
		const running = runSeatCommand("", f.ctx, deps(backend, { pins: { anthropic: "work" } }));
		await Promise.resolve();
		expect(f.customs).toHaveLength(1);
		expect(f.notices).toEqual([]); // a view, not a notice

		for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));
		const frame = f.customs[0]!.render(100).join("\n");
		expect(frame).toContain("anthropic: work (pin)"); // REQ-010 header
		expect(frame).toContain("█"); // meters actually drawn
		expect(frame).toContain("esc/q close");

		f.customs[0]!.handleInput?.("q");
		await running; // AC-018: q closes, and the command returns
	});

	test("TUI: /seat status opens the same view", async () => {
		const f = fakeCtx("tui");
		const running = runSeatCommand("status", f.ctx, deps(seededBackend()));
		await Promise.resolve();
		expect(f.customs).toHaveLength(1);
		f.close?.();
		await running;
	});

	test("AC-019: RPC mode falls back to text — no component, no hang", async () => {
		const f = fakeCtx("rpc");
		for (const args of ["", "status", "usage", "whoami"]) {
			f.notices.length = 0;
			await runSeatCommand(args, f.ctx, deps(seededBackend(), { pins: { anthropic: "personal" } }));
			expect(f.customs).toHaveLength(0);
			expect(f.notices[0]).toContain("anthropic: personal (pin)");
		}
	});
});

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

describe("AC-021: login opens the browser and reports completion", () => {
	/** Adapter whose login emits the given interaction events before minting. */
	function emittingAdapters(minted: SeatCredential, events: ("auth_url" | "device_code")[]): SeatProviderAdapter[] {
		const make = (id: "anthropic" | "openai-codex"): SeatProviderAdapter => ({
			id,
			displayName: id,
			oauth: {
				login: async (interaction) => {
					for (const type of events) {
						if (type === "auth_url") {
							interaction.notify?.({ type: "auth_url", url: "https://example.test/authorize" } as never);
						} else {
							interaction.notify?.({
								type: "device_code",
								verificationUri: "https://example.test/device",
								userCode: "ABCD-1234",
							} as never);
						}
					}
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

	test("auth_url → opener called once with the URL; notice carries it; success names the label", async () => {
		const f = fakeCtx();
		const opened: string[] = [];
		await runSeatCommand(
			"login work",
			f.ctx,
			deps(seededBackend(), { adapters: emittingAdapters(cred("rt-new"), ["auth_url"]) , openBrowser: (u) => void opened.push(u) }),
		);
		expect(opened).toEqual(["https://example.test/authorize"]);
		expect(f.notices.some((n) => n.includes("https://example.test/authorize"))).toBe(true);
		expect(f.notices.some((n) => n.includes('stored anthropic profile "work"'))).toBe(true);
	});

	test("device_code → opener called with verification URI, code shown", async () => {
		const f = fakeCtx();
		const opened: string[] = [];
		await runSeatCommand(
			"login openai-codex:team",
			f.ctx,
			deps(seededBackend(), { adapters: emittingAdapters(cred("rt-codex"), ["device_code"]), openBrowser: (u) => void opened.push(u) }),
		);
		expect(opened).toEqual(["https://example.test/device"]);
		expect(f.notices.some((n) => n.includes("ABCD-1234"))).toBe(true);
		expect(f.notices.some((n) => n.includes('stored openai-codex profile "team"'))).toBe(true);
	});

	test("a throwing opener never breaks the flow (best-effort contract)", async () => {
		const f = fakeCtx();
		await runSeatCommand(
			"login work",
			f.ctx,
			deps(seededBackend(), {
				adapters: emittingAdapters(cred("rt-new"), ["auth_url"]),
				openBrowser: () => {
					throw new Error("no launcher");
				},
			}),
		);
		expect(f.notices.some((n) => n.includes('stored anthropic profile "work"'))).toBe(true);
	});
});
