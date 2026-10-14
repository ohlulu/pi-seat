import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeStore, encodeStore, FileSeatStorageBackend } from "../../src/store/storage.ts";
import { cred } from "./harness.ts";
import { cleanupLoadedExtensions, loadExtension, type LoadedExtension, type LoadOptions } from "./load-extension.ts";

/**
 * AC-034 regression: a pi-subagents foreground child runs on a FRESH
 * ModelRuntime with no extensions loaded, inheriting only the parent's
 * registered providers (pi-subagents child-session.js inheritParentProviders).
 * Before AC-034 it resolved anthropic from auth.json and died on that file's
 * dead grant. Everything here is real except the network: the REAL extension
 * entry, REAL ModelRuntimes and Pi's REAL auth.json AuthStorage, with fetch
 * stubbed so every OAuth refresh is observable.
 */

const FRESH = Date.now() + 3_600_000;
const EXPIRED = Date.now() - 60_000;

/** auth.json's own anthropic grant — dead, as on the machines that reported it. */
const AUTH_JSON_REFRESH = "rt-authjson-dead";
/** The one refresh token the stubbed endpoint accepts. */
const ROTATABLE_REFRESH = "rt-seat-rotatable";

let refreshes: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
	refreshes = [];
	globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
		const refreshToken = (JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string }).refresh_token ?? "";
		refreshes.push(refreshToken);
		if (refreshToken === ROTATABLE_REFRESH) {
			await Bun.sleep(150); // hold the store's async refresh lock across a real await
			return Response.json({ access_token: "at-rotated", refresh_token: "rt-rotated", expires_in: 3600 });
		}
		return Response.json({ error: "invalid_grant", error_description: "Refresh token expired" }, { status: 400 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	cleanupLoadedExtensions();
});

function authPath(loaded: LoadedExtension): string {
	return join(loaded.dir, "auth.json");
}

/** Every runtime in a test reads the same sandbox: auth.json, plus models.json when the test wrote one. */
function runtimeOptions(loaded: LoadedExtension) {
	const modelsPath = join(loaded.dir, "models.json");
	return { authPath: authPath(loaded), modelsPath: existsSync(modelsPath) ? modelsPath : null };
}

function writeAuthJson(loaded: LoadedExtension, entries: Record<string, unknown>): string {
	const content = JSON.stringify(entries, null, 2);
	writeFileSync(authPath(loaded), content, { mode: 0o600 });
	return content;
}

const deadAuthJson = { anthropic: { type: "oauth", refresh: AUTH_JSON_REFRESH, access: "at-authjson", expires: EXPIRED } };

/** The parent session: real runtime, real extension, session_start fired. */
async function startParent(
	options: LoadOptions,
	authJson: Record<string, unknown> = deadAuthJson,
	modelsJson?: Record<string, unknown>,
) {
	const loaded = loadExtension(options);
	const authJsonBefore = writeAuthJson(loaded, authJson);
	if (modelsJson) writeFileSync(join(loaded.dir, "models.json"), JSON.stringify(modelsJson));
	const parent = await ModelRuntime.create(runtimeOptions(loaded));
	loaded.modelRuntime = parent;
	await loaded.fireSessionStart();
	return { loaded, parent, authJsonBefore };
}

/** A foreground child exactly as pi-subagents builds one: fresh runtime + inherited providers. */
async function spawnChild(parent: ModelRuntime, loaded: LoadedExtension): Promise<ModelRuntime> {
	const child = await ModelRuntime.create(runtimeOptions(loaded));
	for (const id of parent.getRegisteredProviderIds()) {
		const native = parent.getRegisteredNativeProvider(id);
		const config = native ? undefined : parent.getRegisteredProviderConfig(id);
		if (native) child.registerNativeProvider(native);
		else if (config) child.registerProvider(id, config);
	}
	return child;
}

function modelOf(runtime: ModelRuntime, provider: string) {
	const model = runtime.getModels(provider)[0];
	if (!model) throw new Error(`no ${provider} model in Pi's catalog`);
	return model;
}

describe("AC-034: subagent children resolve seat credentials, never auth.json", () => {
	test("control: a fresh runtime without the inherited providers rides auth.json's dead grant", async () => {
		const { loaded } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		const bare = await ModelRuntime.create({ authPath: authPath(loaded), modelsPath: null });

		await expect(bare.getAuth(modelOf(bare, "anthropic"))).rejects.toThrow(/OAuth refresh failed for anthropic/);
		expect(refreshes).toContain(AUTH_JSON_REFRESH);
	});

	test("an inherited child uses the seat default; auth.json is neither refreshed nor written", async () => {
		const { loaded, parent, authJsonBefore } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		const child = await spawnChild(parent, loaded);

		const result = await child.getAuth(modelOf(child, "anthropic"));

		expect(result?.auth.apiKey).toBe("at-rt-work");
		expect(await child.checkAuth("anthropic")).toBeDefined();
		expect(refreshes).toEqual([]);
		expect(readFileSync(authPath(loaded), "utf8")).toBe(authJsonBefore);
	});

	test("the child follows the parent's PI_SEAT pin over the store default", async () => {
		const { loaded, parent } = await startParent({
			pin: "personal",
			profiles: { anthropic: { work: cred("rt-work", FRESH), personal: cred("rt-personal", FRESH) } },
			defaults: { anthropic: "work" },
		});
		const child = await spawnChild(parent, loaded);

		expect((await child.getAuth(modelOf(child, "anthropic")))?.auth.apiKey).toBe("at-rt-personal");
	});

	test("a dead seat profile fails the child with seat's error, never an auth.json refresh", async () => {
		const { loaded, parent, authJsonBefore } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-seat-dead", EXPIRED) } },
			defaults: { anthropic: "work" },
		});
		const child = await spawnChild(parent, loaded);

		const failure = child.getAuth(modelOf(child, "anthropic"));

		await expect(failure).rejects.toThrow(/seat: anthropic auth failed — .*invalid_grant/);
		await expect(failure).rejects.not.toThrow(/OAuth refresh failed/);
		expect(refreshes).not.toContain(AUTH_JSON_REFRESH);
		expect(readFileSync(authPath(loaded), "utf8")).toBe(authJsonBefore);
		// AC-007: the dead credential stays in the store for a replacement login.
		const store = new FileSeatStorageBackend(join(loaded.dir, "seat.json")).read((current) => decodeStore(current));
		expect(store.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-seat-dead");
	});

	test("an invalid PI_SEAT fails the child closed with the startup error", async () => {
		const { loaded, parent } = await startParent({
			pin: "nosuch",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		const child = await spawnChild(parent, loaded);

		await expect(child.getAuth(modelOf(child, "anthropic"))).rejects.toThrow(/PI_SEAT is invalid/);
		expect(refreshes).toEqual([]);
	});

	test("with no pin and no default, the child gets Pi's built-in login untouched (AC-006)", async () => {
		const { loaded, parent } = await startParent(
			{ pin: "", profiles: { anthropic: { work: cred("rt-work", FRESH) } } },
			{ anthropic: { type: "oauth", refresh: "rt-authjson-live", access: "at-authjson-live", expires: FRESH } },
		);
		const child = await spawnChild(parent, loaded);

		expect((await child.getAuth(modelOf(child, "anthropic")))?.auth.apiKey).toBe("at-authjson-live");
	});

	test("a seat-only Codex login (no auth.json entry) reaches the child", async () => {
		const { loaded, parent } = await startParent(
			{ pin: "", profiles: { "openai-codex": { main: cred("rt-main", FRESH) } }, defaults: { "openai-codex": "main" } },
			{},
		);
		const child = await spawnChild(parent, loaded);

		expect(await child.checkAuth("openai-codex")).toBeDefined();
		expect((await child.getAuth(modelOf(child, "openai-codex")))?.auth.apiKey).toBe("at-rt-main");
	});

	test("an unowned Codex keeps the apiKey models.json configures for it (AC-006)", async () => {
		const { loaded, parent } = await startParent(
			{ pin: "", profiles: { anthropic: { work: cred("rt-work", FRESH) } }, defaults: { anthropic: "work" } },
			{},
			{ providers: { "openai-codex": { apiKey: "sk-from-models-json" } } },
		);
		const child = await spawnChild(parent, loaded);

		for (const runtime of [parent, child]) {
			expect(await runtime.checkAuth("openai-codex")).toBeDefined();
			expect((await runtime.getAuth(modelOf(runtime, "openai-codex")))?.auth.apiKey).toBe("sk-from-models-json");
		}
	});

	test("concurrent children refresh an expiring seat grant once, without the DEC-011 lock deadlock", async () => {
		const { loaded, parent } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		// Expire the grant after the parent's session_start sync, so the children race the refresh.
		const backend = new FileSeatStorageBackend(join(loaded.dir, "seat.json"));
		backend.withLock((current) => {
			const store = decodeStore(current);
			store.providers.anthropic!.profiles["work"] = cred(ROTATABLE_REFRESH, EXPIRED);
			return { result: undefined, next: encodeStore(store) };
		});
		const [first, second] = [await spawnChild(parent, loaded), await spawnChild(parent, loaded)];

		const started = Date.now();
		const results = await Promise.all([
			first.getAuth(modelOf(first, "anthropic")),
			second.getAuth(modelOf(second, "anthropic")),
		]);

		expect(results.map((result) => result?.auth.apiKey)).toEqual(["at-rotated", "at-rotated"]);
		expect(refreshes).toEqual([ROTATABLE_REFRESH]);
		expect(Date.now() - started).toBeLessThan(3_000); // a sync-lock deadlock waits out the 5s lock timeout
	});

	test("a store corrupted mid-session still lets a non-seat turn run: the sentinel lands (AC-031)", async () => {
		const { loaded, parent } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		writeFileSync(join(loaded.dir, "seat.json"), "{ corrupted mid-session", { mode: 0o600 });
		loaded.activeModel = { provider: "google" };

		await loaded.fireTurnStart();

		// Installing the sentinel runs Pi's availability check through the
		// registered provider; it must not need the unreadable store to pass.
		expect(loaded.aborts).toBe(0);
		expect(loaded.notices.some((notice) => notice.startsWith("seat: anthropic auth failed"))).toBe(true);
		expect(loaded.runtime.streamCalls).toBe(1); // the turn runner went on to the request
		// An anthropic request still fails closed with seat's error.
		await expect(parent.getAuth(modelOf(parent, "anthropic"))).rejects.toThrow(/seat: anthropic auth failed/);
		expect(refreshes).toEqual([]);
	});

	test("session_shutdown hands the providers back to Pi", async () => {
		const { loaded, parent } = await startParent({
			pin: "",
			profiles: { anthropic: { work: cred("rt-work", FRESH) } },
			defaults: { anthropic: "work" },
		});
		expect(parent.getRegisteredProviderIds()).toEqual(["anthropic", "openai-codex"]);

		await loaded.fireSessionShutdown();

		expect(parent.getRegisteredProviderIds()).toEqual([]);
	});
});
