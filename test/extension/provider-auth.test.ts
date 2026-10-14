import { afterEach, describe, expect, test } from "bun:test";
import type { ModelAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SeatProviderInstaller,
	getProviderHost,
	wrapProvider,
	type ProviderHost,
	type SeatAuthSource,
} from "../../src/extension/provider-auth.ts";
import type { ProviderId } from "../../src/store/schema.ts";

/**
 * AC-034 unit coverage for the registered provider and its installer. The
 * end-to-end path through real ModelRuntimes lives in subagent-child.test.ts;
 * this file pins the edges that path cannot reach cheaply.
 */

function fakeProvider(id: string, calls: string[] = []): Provider {
	return {
		id,
		name: `${id} builtin`,
		auth: {
			oauth: {
				name: `${id} oauth`,
				login: () => Promise.reject(new Error("not under test")),
				refresh: async (credential) => {
					calls.push(`base-refresh:${credential.refresh}`);
					return credential;
				},
				toAuth: async (credential) => ({ apiKey: `base:${credential.access}` }),
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("not under test");
		},
		streamSimple: () => {
			throw new Error("not under test");
		},
	};
}

function source(owned: Partial<Record<ProviderId, string>>): SeatAuthSource {
	return {
		owns: async (provider) => owned[provider] !== undefined,
		requestAuth: async (provider): Promise<ModelAuth | undefined> =>
			owned[provider] !== undefined ? { apiKey: owned[provider] } : undefined,
	};
}

const stored: OAuthCredential = { type: "oauth", refresh: "rt-authjson", access: "at-authjson", expires: 0 };

class FakeHost implements ProviderHost {
	readonly builtins = new Map<string, Provider>([
		["anthropic", fakeProvider("anthropic")],
		["openai-codex", fakeProvider("openai-codex")],
	]);
	readonly native = new Map<string, Provider>();
	readonly configs = new Map<string, unknown>();
	getRegisteredNativeProvider(id: string) {
		return this.native.get(id);
	}
	getRegisteredProviderConfig(id: string) {
		return this.configs.get(id);
	}
	registrar = {
		registerProvider: (provider: Provider) => {
			this.configs.delete(provider.id);
			this.native.set(provider.id, provider);
		},
		unregisterProvider: (id: string) => {
			this.native.delete(id);
			this.configs.delete(id);
		},
	};
}

describe("AC-034: the registered provider", () => {
	test("a seat-owned provider never refreshes Pi's stored grant and returns seat's auth", async () => {
		const calls: string[] = [];
		const wrapper = wrapProvider("anthropic", fakeProvider("anthropic", calls), source({ anthropic: "at-seat" }));

		// undefined is CredentialStore.modify's "leave the entry unchanged".
		expect(await wrapper.auth.oauth!.refresh(stored, new AbortController().signal)).toBeUndefined();
		expect(await wrapper.auth.oauth!.toAuth(stored)).toEqual({ apiKey: "at-seat" });
		expect(calls).toEqual([]);
	});

	test("an unowned provider delegates refresh and toAuth to the base untouched", async () => {
		const calls: string[] = [];
		const wrapper = wrapProvider("anthropic", fakeProvider("anthropic", calls), source({}));

		await wrapper.auth.oauth!.refresh(stored, new AbortController().signal);
		expect(await wrapper.auth.oauth!.toAuth(stored)).toEqual({ apiKey: "base:at-authjson" });
		expect(calls).toEqual(["base-refresh:rt-authjson"]);
	});

	test("an OAuth-only base still answers the api-key path, which has no login method", async () => {
		const wrapper = wrapProvider("openai-codex", fakeProvider("openai-codex"), source({ "openai-codex": "at-seat" }));
		const input = { ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal };

		expect(wrapper.auth.apiKey?.login).toBeUndefined();
		expect(await wrapper.auth.apiKey!.check!(input)).toEqual({ type: "oauth", source: "pi-seat" });
		expect((await wrapper.auth.apiKey!.resolve(input))?.auth.apiKey).toBe("at-seat");
	});
});

describe("AC-034: ownership that flips between refresh and toAuth", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	test("a grant whose refresh seat skipped is never derived after seat lets go", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-flip-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		const authJson = JSON.stringify({
			anthropic: { type: "oauth", refresh: "rt-authjson", access: "at-authjson-expired", expires: Date.now() - 60_000 },
		});
		writeFileSync(authPath, authJson, { mode: 0o600 });
		const runtime = await ModelRuntime.create({ authPath, modelsPath: null });
		const base = getProviderHost({ runtime })!.builtins.get("anthropic")!;
		// Seat owns the provider when Pi asks refresh, and has let go by toAuth
		// (`/seat use anthropic:default` landing in between).
		let owned = true;
		const flipping: SeatAuthSource = {
			owns: async () => {
				const answer = owned;
				owned = false;
				return answer;
			},
			requestAuth: async () => undefined,
		};
		runtime.registerNativeProvider(wrapProvider("anthropic", base, flipping));

		const failure = runtime.getAuth(runtime.getModels("anthropic")[0]!);

		// Deriving would send the expired auth.json token and draw a 401.
		await expect(failure).rejects.toThrow(/seat: anthropic .*retry/);
		expect(readFileSync(authPath, "utf8")).toBe(authJson);
	});
});

describe("AC-034: installing and handing back the providers", () => {
	test("another extension's native provider is wrapped, then restored on uninstall", () => {
		const host = new FakeHost();
		const theirs = fakeProvider("anthropic");
		host.native.set("anthropic", theirs);
		const installer = new SeatProviderInstaller(host.registrar, source({}));

		installer.install(host);
		expect(host.native.get("anthropic")).not.toBe(theirs);
		installer.uninstall();

		expect(host.native.get("anthropic")).toBe(theirs);
		expect(host.native.has("openai-codex")).toBe(false);
	});

	test("a provider config registered by another extension is left alone and reported", () => {
		const host = new FakeHost();
		host.configs.set("anthropic", { baseUrl: "https://proxy.example" });
		const installer = new SeatProviderInstaller(host.registrar, source({}));

		const notices = installer.install(host);

		expect(host.configs.get("anthropic")).toEqual({ baseUrl: "https://proxy.example" });
		expect(host.native.has("anthropic")).toBe(false);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('"anthropic"');
	});

	test("a stale wrapper from an earlier instance is unwrapped, never wrapped twice", async () => {
		const host = new FakeHost();
		const calls: string[] = [];
		host.builtins.set("anthropic", fakeProvider("anthropic", calls));
		new SeatProviderInstaller(host.registrar, source({ anthropic: "at-old" })).install(host); // never uninstalled

		new SeatProviderInstaller(host.registrar, source({})).install(host);
		const wrapper = host.native.get("anthropic")!;
		await wrapper.auth.oauth!.refresh(stored, new AbortController().signal);

		// An unowned provider reaches the builtin directly: the old wrapper is gone.
		expect(await wrapper.auth.oauth!.toAuth(stored)).toEqual({ apiKey: "base:at-authjson" });
		expect(calls).toEqual(["base-refresh:rt-authjson"]);
	});

	test("install is idempotent across repeated session_start events", () => {
		const host = new FakeHost();
		let registrations = 0;
		const installer = new SeatProviderInstaller(
			{
				registerProvider: (provider) => {
					registrations += 1;
					host.registrar.registerProvider(provider);
				},
				unregisterProvider: host.registrar.unregisterProvider,
			},
			source({}),
		);

		installer.install(host);
		installer.install(host);

		expect(registrations).toBe(2); // one per provider, not per session_start
	});
});
