/**
 * Loads the REAL extension entry (src/extension/index.ts) against a synthetic
 * PI_CODING_AGENT_DIR, a fake ExtensionAPI capturing its handlers, and a fake
 * ctx capturing notices and footer statuses. Everything the entry does at
 * setup and on session_start/turn_start is observable here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import seatExtension from "../../src/extension/index.ts";
import { emptyStore, type ProviderId, type SeatCredential } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { FakeRuntime } from "./harness.ts";

export interface LoadOptions {
	pin: string;
	profiles?: Partial<Record<ProviderId, Record<string, SeatCredential>>>;
	/** Write an undecodable seat.json to exercise the store-unreadable path. */
	corruptStore?: boolean;
	/** print/json modes report hasUI false and have no status surface. */
	hasUI?: boolean;
}

export interface LoadedExtension {
	dir: string;
	runtime: FakeRuntime;
	notices: string[];
	/** Latest text per status key; undefined means the key was cleared. */
	statuses: Map<string, string | undefined>;
	statusCalls: number;
	aborts: number;
	fireSessionStart(): Promise<void>;
	fireTurnStart(): Promise<void>;
}

const cleanups: (() => void)[] = [];

/** Call from afterEach in every file that uses loadExtension. */
export function cleanupLoadedExtensions(): void {
	while (cleanups.length) cleanups.pop()!();
}

export function loadExtension(options: LoadOptions): LoadedExtension {
	const dir = mkdtempSync(join(tmpdir(), "seat-ext-"));
	const storePath = join(dir, "seat.json");

	if (options.corruptStore) {
		writeFileSync(storePath, "{ this is not valid json", { mode: 0o600 });
	} else {
		const store = emptyStore();
		for (const [provider, profiles] of Object.entries(options.profiles ?? {}) as [
			ProviderId,
			Record<string, SeatCredential>,
		][]) {
			if (Object.keys(profiles).length === 0) continue;
			store.providers[provider] = {
				profiles: Object.assign(Object.create(null), profiles),
				aliases: Object.assign(Object.create(null)),
			};
		}
		new FileSeatStorageBackend(storePath).withLock(() => ({ result: undefined, next: encodeStore(store) }));
	}

	const prevDir = process.env["PI_CODING_AGENT_DIR"];
	const prevPin = process.env["PI_SEAT"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	process.env["PI_SEAT"] = options.pin;
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
		statuses: new Map(),
		statusCalls: 0,
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
			hasUI: options.hasUI ?? false,
			abort: () => {
				loaded.aborts += 1;
			},
			ui: {
				notify: (text: string) => {
					loaded.notices.push(text);
				},
				setStatus: (key: string, text: string | undefined) => {
					loaded.statusCalls += 1;
					loaded.statuses.set(key, text);
				},
				// Marks the colour so tests can assert styling, not just text.
				theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			},
			modelRegistry: { runtime },
		}) as never;

	seatExtension(fakePi);
	return loaded;
}
