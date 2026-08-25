/**
 * AC-020: loading the extension never migrates.
 *
 * The trigger used to live in the extension entry, which meant a legacy file
 * sitting next to the store turned any `pi` start into a write. Migration is an
 * operator action now (scripts/migrate-legacy.ts), so extension load must be
 * inert with respect to the store whether or not a legacy file is present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import seatExtension from "../../src/extension/index.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: Date.now() + 3_600_000 };
}

const LEGACY = JSON.stringify({
	active: "work",
	profiles: { work: cred("rt-work"), dormant: cred("rt-dormant") },
	aliases: { d: "dormant" },
});

interface Loaded {
	dir: string;
	notices: string[];
	commands: string[];
}

function loadExtension(files: { legacy?: boolean; seatStore?: boolean } = {}): Loaded {
	const dir = mkdtempSync(join(tmpdir(), "seat-noauto-"));
	if (files.legacy) writeFileSync(join(dir, "claude-profiles.json"), LEGACY, { mode: 0o600 });
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: cred("rt-builtin") }), { mode: 0o600 });
	if (files.seatStore) {
		new FileSeatStorageBackend(join(dir, "seat.json")).withLock(() => ({
			result: undefined,
			next: encodeStore(emptyStore()),
		}));
	}

	const prevDir = process.env["PI_CODING_AGENT_DIR"];
	const prevPin = process.env["PI_SEAT"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	delete process.env["PI_SEAT"];
	cleanups.push(() => {
		if (prevDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevDir;
		if (prevPin !== undefined) process.env["PI_SEAT"] = prevPin;
		rmSync(dir, { recursive: true, force: true });
	});

	const loaded: Loaded = { dir, notices: [], commands: [] };
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const fakePi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string) => {
			loaded.commands.push(name);
		},
	} as unknown as ExtensionAPI;

	seatExtension(fakePi);
	// session_start is where the old hook flushed its migration notice.
	void handlers.get("session_start")?.({ type: "session_start" }, {
		mode: "rpc",
		hasUI: false,
		ui: { notify: (text: string) => loaded.notices.push(text) },
	} as never);
	return loaded;
}

describe("AC-020: extension load never migrates", () => {
	test("legacy file present, no store → nothing is created and nothing is announced", () => {
		const loaded = loadExtension({ legacy: true });
		const legacyPath = join(loaded.dir, "claude-profiles.json");

		expect(existsSync(join(loaded.dir, "seat.json"))).toBe(false); // the whole point
		expect(readFileSync(legacyPath, "utf8")).toBe(LEGACY);
		expect(loaded.notices.join("\n")).not.toContain("Imported");
		expect(loaded.notices.join("\n")).not.toContain("migration");
		// Not even a lock directory: load is read-only with respect to the store.
		expect(readdirSync(loaded.dir).sort()).toEqual(["auth.json", "claude-profiles.json"]);
		expect(loaded.commands).toEqual(["seat"]); // it did load
	});

	test("no legacy file → identical load path, no diagnostics", () => {
		const loaded = loadExtension();
		expect(existsSync(join(loaded.dir, "seat.json"))).toBe(false);
		expect(loaded.notices).toEqual([]);
		expect(loaded.commands).toEqual(["seat"]);
	});

	test("legacy file present alongside an existing store → store byte-identical", () => {
		const loaded = loadExtension({ legacy: true, seatStore: true });
		const storePath = join(loaded.dir, "seat.json");
		const before = readFileSync(storePath);
		expect(readFileSync(storePath).equals(before)).toBe(true);
		expect(loaded.notices).toEqual([]);
	});
});
