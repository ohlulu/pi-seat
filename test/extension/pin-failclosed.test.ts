import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import seatExtension from "../../src/extension/index.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { FakeRuntime } from "./harness.ts";

const FRESH = Date.now() + 3_600_000;

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: FRESH };
}

/** Load the real extension entry under a synthetic PI_CODING_AGENT_DIR. */
interface LoadedExtension {
	dir: string;
	runtime: FakeRuntime;
	notices: string[];
	aborts: number;
	fireSessionStart(): Promise<void>;
	fireTurnStart(): Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

function loadExtension(piSeat: string, seedProfiles: Record<string, SeatCredential>): LoadedExtension {
	const dir = mkdtempSync(join(tmpdir(), "seat-pin-"));
	const store = emptyStore();
	if (Object.keys(seedProfiles).length > 0) {
		store.providers.anthropic = {
			profiles: Object.assign(Object.create(null), seedProfiles),
			aliases: Object.assign(Object.create(null)),
		};
	}
	new FileSeatStorageBackend(join(dir, "seat.json")).withLock(() => ({ result: undefined, next: encodeStore(store) }));

	const prevDir = process.env["PI_CODING_AGENT_DIR"];
	const prevPin = process.env["PI_SEAT"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	process.env["PI_SEAT"] = piSeat;
	cleanups.push(() => {
		if (prevDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevDir;
		if (prevPin === undefined) delete process.env["PI_SEAT"];
		else process.env["PI_SEAT"] = prevPin;
		rmSync(dir, { recursive: true, force: true });
	});

	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const fakePi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers.set(event, handler);
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;

	const runtime = new FakeRuntime();
	const loaded: LoadedExtension = {
		dir,
		runtime,
		notices: [],
		aborts: 0,
		fireSessionStart: async () => {
			await handlers.get("session_start")?.({ type: "session_start" }, ctx());
		},
		fireTurnStart: async () => {
			const before = loaded.aborts;
			await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx());
			// Turn-runner contract: stream only when the turn was not aborted.
			if (loaded.aborts === before) runtime.stream();
		},
	};

	const ctx = () =>
		({
			mode: "rpc",
			hasUI: false,
			abort: () => {
				loaded.aborts += 1;
			},
			ui: {
				notify: (text: string) => {
					loaded.notices.push(text);
				},
			},
			modelRegistry: { runtime },
		}) as never;

	seatExtension(fakePi);
	return loaded;
}

async function assertFailClosed(loaded: LoadedExtension): Promise<void> {
	await loaded.fireSessionStart();
	expect(loaded.notices.some((n) => n.includes("PI_SEAT"))).toBe(true); // explicit startup notice

	await loaded.fireTurnStart();
	expect(loaded.aborts).toBe(1); // turn aborted
	expect(loaded.runtime.streamCalls).toBe(0); // provider stream never called
	expect(loaded.runtime.keys.size).toBe(0); // no credential overlay applied at all
}

describe("AC-004: PI_SEAT fail-closed at startup (T030)", () => {
	test("unknown label aborts the turn with a startup notice", async () => {
		const loaded = loadExtension("nosuch", { work: cred("rt-work") });
		await assertFailClosed(loaded);
	});

	test("malformed selector (dangling provider prefix) fails closed", async () => {
		const loaded = loadExtension("anthropic:", { work: cred("rt-work") });
		await assertFailClosed(loaded);
	});

	test("duplicate provider in multi-value pin fails closed", async () => {
		const loaded = loadExtension("anthropic:work,anthropic:work", { work: cred("rt-work") });
		await assertFailClosed(loaded);
	});

	test("no partial apply: one valid + one invalid entry applies neither pin", async () => {
		const loaded = loadExtension("anthropic:work,openai-codex:nosuch", { work: cred("rt-work") });
		await assertFailClosed(loaded);
		// Even the valid anthropic:work pin must not have been applied.
		expect(loaded.runtime.events.filter((e) => e.startsWith("set:"))).toEqual([]);
	});

	test("control: a valid pin applies and streams", async () => {
		const loaded = loadExtension("work", { work: cred("rt-work") });
		await loaded.fireSessionStart();
		await loaded.fireTurnStart();
		expect(loaded.aborts).toBe(0);
		expect(loaded.runtime.keys.get("anthropic")).toBe("at-rt-work");
		expect(loaded.runtime.streamCalls).toBe(1);
	});
});
